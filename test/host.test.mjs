// 宿主半边的行为测试。
//
// 重点不是"能注册段落"，而是：
//   - 开关关闭时**不能**注册（默认关，强副作用不该默默生效）
//   - 开关打开时注册，关掉后 disposer 被调用（真的撤掉）
//   - 开关持久化，重新 apply 后仍生效
//   - 跨站写请求被拒
//   - 注册抛错时插件不崩、状态如实回报
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// 每个用例一个独立的 DSH_HOME，避免相互污染。
function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'kilo-prompt-'));
  process.env.DSH_HOME = home;
  return home;
}

const { apply, ROUTE_STATE, SECTION_NAME, SECTION_ORDER, KILO_PROMPT, readEnabled } =
  await import('../index.js');

const ok = (m) => console.log('ok   ' + m);

/** 假的 systemPrompt：记录 section() 调用与 disposer。 */
function makeSystemPrompt({ throwOnRegister = false } = {}) {
  const sections = [];
  const disposals = [];
  return {
    sections,
    disposals,
    section(def) {
      if (throwOnRegister) throw new Error('duplicate section name');
      sections.push(def);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        disposals.push(def.name);
      };
    },
    getSectionOrder(name) {
      return name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : undefined;
    },
  };
}

/** 组装最小 cordis 上下文。 */
function makeCtx({ systemPrompt, throwOnRegister } = {}) {
  const routes = new Map();
  const sp = systemPrompt || makeSystemPrompt({ throwOnRegister });
  const ctx = {
    get(name) {
      if (name === 'systemPrompt') return sp;
      return null;
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject(services, callback) {
      const child = {
        systemPrompt: sp,
        webServer: {
          register(def) {
            routes.set(def.path, def.handler);
            return () => routes.delete(def.path);
          },
        },
      };
      const dispose = callback(child);
      return {
        dispose: () => {
          if (typeof dispose === 'function') dispose();
        },
      };
    },
    logger: () => ({ info() {} }),
  };
  apply(ctx);
  return { ctx, routes, sp };
}

function req(body, extra = {}) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1', origin: 'http://127.0.0.1' },
    method: 'PUT',
    url: '/',
    ...extra,
  });
}
function get() {
  return Object.assign(Readable.from([]), { headers: {}, method: 'GET', url: '/' });
}

async function call(handler, request) {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, hd) {
      this.statusCode = code;
      this.headers = hd;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
  await handler(request, res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* 非 JSON */
  }
  return { status: res.statusCode, json };
}

/* ── 1. 默认关：不该注册任何段落 ─────────────────────────────────── */
{
  freshHome();
  const { sp } = makeCtx();
  assert.equal(sp.sections.length, 0, '默认关时不该注册段落');
  assert.equal(readEnabled(), false);
  ok('默认关 → 不注册段落（强副作用不默默生效）');
}

/* ── 2. 打开后注册；关掉后真的撤掉 ──────────────────────────────── */
{
  freshHome();
  const { routes, sp } = makeCtx();

  const on = await call(routes.get(ROUTE_STATE), req({ enabled: true }));
  assert.equal(on.status, 200);
  assert.equal(on.json.enabled, true);
  assert.equal(sp.sections.length, 1, '打开后应注册一个段落');
  assert.equal(sp.sections[0].name, SECTION_NAME);
  assert.equal(sp.sections[0].order, SECTION_ORDER);
  assert.equal(sp.sections[0].text, KILO_PROMPT);
  ok('打开 → 注册段落（名字/顺序/正文都对）');

  const off = await call(routes.get(ROUTE_STATE), req({ enabled: false }));
  assert.equal(off.json.enabled, false);
  assert.deepEqual(sp.disposals, [SECTION_NAME], '关闭时应调用 disposer 撤掉段落');
  ok('关闭 → disposer 被调用，段落撤掉');
}

/* ── 3. 段落落在部署人格(0)之后、计划策略(500)之前 ──────────────── */
{
  freshHome();
  const { routes, sp } = makeCtx();
  await call(routes.get(ROUTE_STATE), req({ enabled: true }));
  const order = sp.sections[0].order;
  assert.ok(order > 0 && order < 500, `order 应落在 (0, 500)，实际 ${order}`);
  ok(`段落顺序 ${order} 落在部署人格与计划策略之间`);
}

/* ── 4. 开关持久化：重新 apply 后仍生效 ─────────────────────────── */
{
  const home = freshHome();
  {
    const { routes } = makeCtx();
    await call(routes.get(ROUTE_STATE), req({ enabled: true }));
  }
  // 模拟重启：同一个 DSH_HOME，重新 apply 一次
  const { sp } = makeCtx();
  assert.equal(sp.sections.length, 1, '重启后应按持久化状态自动注册');
  assert.equal(readEnabled(), true);
  ok(`开关写入文件（${home}），重新 apply 后自动恢复`);
}

/* ── 5. 非布尔 enabled 被拒 ─────────────────────────────────────── */
{
  freshHome();
  const { routes } = makeCtx();
  const res = await call(routes.get(ROUTE_STATE), req({ enabled: 'yes' }));
  assert.equal(res.status, 400);
  ok('非布尔的 enabled → 400');
}

/* ── 6. 跨站写请求被拒 ─────────────────────────────────────────── */
{
  freshHome();
  const { routes } = makeCtx();
  const res = await call(
    routes.get(ROUTE_STATE),
    req({ enabled: true }, { headers: { 'sec-fetch-site': 'cross-site' } }),
  );
  assert.equal(res.status, 403);
  ok('跨站改开关 → 403');
}

/* ── 7. 注册抛错时插件不崩，状态如实回报 ────────────────────────── */
{
  freshHome();
  const { routes } = makeCtx({ throwOnRegister: true });
  const res = await call(routes.get(ROUTE_STATE), req({ enabled: true }));
  assert.equal(res.status, 200, '注册失败不该让请求失败');
  assert.equal(res.json.enabled, true, '开关状态仍如实反映用户的意图');
  ok('注册抛错 → 请求仍 200，开关状态如实（不假装成功也不崩）');
}

/* ── 8. GET 回报 promptChars 与 ready ───────────────────────────── */
{
  freshHome();
  const { routes } = makeCtx();
  const res = await call(routes.get(ROUTE_STATE), get());
  assert.equal(res.json.ok, true);
  assert.equal(res.json.enabled, false);
  assert.ok(res.json.promptChars > 1000, '应回报提示词长度，便于排查空提示词');
  assert.equal(res.json.ready, true);
  ok(`GET 回报 promptChars=${res.json.promptChars}、ready=true`);
}

/* ── 9. 提示词本身：两层齐全、工具名已适配 ─────────────────────── */
{
  assert.ok(KILO_PROMPT.startsWith('You are Kilo, a highly skilled software engineer'),
    'soul 应在最前（Kilo 的拼装顺序）');
  assert.ok(KILO_PROMPT.includes('# Tone and style'), '应包含 default 主体层');
  assert.ok(KILO_PROMPT.includes('ask_user_question'), 'question 工具应换成 DSH 的');
  assert.ok(KILO_PROMPT.includes('pwsh'), 'Bash 应换成 pwsh');
  assert.ok(KILO_PROMPT.includes('subagent'), 'Task 应换成 subagent');
  assert.ok(!/\bBash\b/.test(KILO_PROMPT), '不应再出现 Kilo 的 Bash 工具名');
  assert.ok(!/kilo\.ai\/docs/.test(KILO_PROMPT), '不该保留 DSH 用不上的 Kilo 文档地址');
  ok('提示词 = soul + default，工具名已适配 DSH');
}

console.log('\n全部通过');