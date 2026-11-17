// 客户端半边的离线测试。
//
// 浏览器端唯一会"静默坏掉"的地方就是 apply() 挂载失败 —— 控制台报错、按钮消失，
// 其他一切照常。所以这里把 client.js 在 vm 沙箱里真跑一遍：
// 模块外壳、locale 词典、sidebar.footer.action 注册、按钮渲染。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const code = readFileSync(join(ROOT, 'client.js'), 'utf8');

let pass = 0;
let failCount = 0;
const ok = (m) => {
  pass += 1;
  console.log('ok   ' + m);
};
const fail = (m) => {
  failCount += 1;
  console.error('FAIL ' + m);
};

/* ── 极简 React ── */
const react = {
  createElement(type, props, ...children) {
    return {
      type,
      props: { ...(props || {}), children: children.flat().filter((c) => c !== null && c !== undefined) },
    };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
  useCallback(fn) {
    return fn;
  },
};

/* ── 极简 DOM ── */
const dom = new Map();
const document = {
  getElementById: (id) => dom.get(id) || null,
  createElement: () => {
    const node = { id: '', textContent: '', removed: false, remove() { this.removed = true; } };
    return node;
  },
  head: {
    appendChild(node) {
      dom.set(node.id, node);
    },
  },
};

/* ── 沙箱 ── */
let captured = null;
const listeners = new Map();

const window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};

const sandbox = {
  window,
  document,
  console,
  require(name) {
    if (name === 'react') return react;
    throw new Error('未知模块: ' + name);
  },
  fetch: async () => ({ ok: false, status: 404, json: async () => null }),
  importMeta: undefined,
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
new vm.Script(code, { filename: 'client.js' }).runInContext(sandbox);

/* ── 1. 模块外壳 ── */
if (!captured) fail('没有调用 __ModuleLoader__.load');
else ok('调用 __ModuleLoader__.load');

if (captured && captured.id !== 'dsh-kilo-prompt') fail(`模块 id 应为 dsh-kilo-prompt，实际 ${captured && captured.id}`);
else ok('模块 id 正确');

// 模块的 factory 由模块加载器以 require 调用，这里照做。
const plugin = captured && typeof captured.factory === 'function'
  ? captured.factory((name) => sandbox.require(name))
  : null;
if (!plugin) fail('factory() 没返回插件对象');
else ok(`插件对象形状正确（name=${plugin.name}, inject=${JSON.stringify(plugin.inject)}）`);

if (!plugin || typeof plugin.apply !== 'function') fail('缺少 apply()');
else ok('apply 是函数');

/* ── 2. apply() 能跑通，且注册到 sidebar.footer.action ── */
let seat = null;
const localeDicts = [];
const ctx = {
  locale: {
    register(ns, dict) {
      localeDicts.push({ ns, dict });
      return () => {};
    },
    bind(ns) {
      return (key) => {
        const dict = localeDicts.find((d) => d.ns === ns)?.dict || {};
        return (dict.zh && dict.zh[key]) || key;
      };
    },
  },
  slots: {
    inject(slotKey, cb) {
      const result = cb();
      if (slotKey === 'sidebar.footer.action') seat = { slotKey, result };
      return () => {};
    },
    register(def, Component) {
      return { def, component: Component };
    },
  },
};

let threw = null;
try {
  plugin.apply(ctx);
} catch (error) {
  threw = error;
}
if (threw) fail('apply() 抛异常: ' + threw.message);
else ok('apply() 未抛异常');

if (!seat) fail('没有注册到 sidebar.footer.action');
else ok('已注册到 sidebar.footer.action');

if (seat && seat.result.def.order !== 20) fail(`order 应为 20（铃铛是 10，本插件在其后），实际 ${seat.result.def.order}`);
else ok('order = 20（排在铃铛之后）');

if (seat && typeof seat.result.def.label !== 'function') fail('label 应是函数（跟随语言切换）');
else ok('label 是函数（跟随 locale）');

if (!localeDicts.some((d) => d.dict && d.dict.zh && d.dict.en)) fail('未注册中英词典');
else ok('注册了中英双语词典');

/* ── 3. 组件能渲染 ── */
if (seat && seat.result.component) {
  try {
    const el = seat.result.component({});
    if (!el || el.type !== 'button') fail('根节点应是 <button>');
    else ok('渲染成功，根节点是 <button>');

    const attrs = (el && el.props) || {};
    if (attrs['data-on'] !== 'false') fail(`默认应为关闭状态，实际 data-on=${attrs['data-on']}`);
    else ok('默认 data-on=false（与"默认关"一致）');

    if (attrs['aria-pressed'] !== false) fail('aria-pressed 应为 false');
    else ok('带 aria-pressed（可访问性）');

    if (!String(attrs['aria-label'] || '').length) fail('缺少 aria-label');
    else ok(`有 aria-label：${attrs['aria-label']}`);

    if (attrs.disabled !== false) fail('未忙碌时不应 disabled');
    else ok('空闲态可点击');
  } catch (error) {
    fail('渲染抛异常: ' + error.message);
  }
}

/* ── 4. HMR 卸载钩子 ── */
if (typeof window.__KILO_PROMPT_DISPOSE__ === 'function') {
  window.__KILO_PROMPT_DISPOSE__();
  if (typeof window.__KILO_PROMPT_DISPOSE__ !== 'undefined') fail('卸载后 __KILO_PROMPT_DISPOSE__ 应被删除');
  else ok('HMR 卸载钩子可用且能自清理');
} else {
  fail('未安装 HMR 卸载钩子');
}

/* ── 5. 样式挂载 ── */
const styleNode = dom.get('dsh-kilo-prompt-style');
if (!styleNode) fail('未挂载样式表');
else if (!styleNode.textContent.includes('data-on')) fail('样式表内容不对');
else ok('样式表已挂载（含 data-on 状态样式）');

console.log(`\n通过 ${pass} 项${failCount ? `，失败 ${failCount} 项` : '，全部通过'}`);
process.exit(failCount ? 1 : 0);