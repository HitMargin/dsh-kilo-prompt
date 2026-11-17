/**
 * dsh-kilo-prompt · 宿主半边
 *
 * 把 Kilo Code 的内置系统提示词（soul + default）作为一个 system-prompt 段落
 * 注入 DSH，开关由侧栏按钮控制、状态持久化。
 *
 * ## DSH 的系统提示词是怎么拼的
 *
 * `dsh-system-prompt` 维护一组**按 order 排序的段落**，每轮请求前拼成完整 system：
 *
 *   -1000  harness:identity        "You are an AI agent powered by DeepSeek Harness."
 *       0  deployment persona      （部署级人格，默认空串）
 *     100  ← 本插件插在这里
 *     500  plan policy
 *     600  team policy
 *    1000+ 各工具的说明段落
 *
 * 注册方式是 `ctx.systemPrompt.section({ name, order, text })`，返回一个 disposer；
 * 调用 disposer 就把段落撤掉，下一轮请求即恢复。这让"运行时开关"成为可能 ——
 * 不需要重启、不需要改 profile 配置。
 *
 * ## 为什么不用 dsh-persona
 *
 * `@deepseek-ai/dsh-persona` 是给 agent preset 用的：它注册的段落名与注册表自己
 * 注册的 persona 同名，全局挂载会**撞名并报错**（源码注释里明说 "mounted globally
 * it collides with the registry's own registration and fails loud"）。
 * 所以本插件用自己的段落名，只做追加，不碰部署人格。
 *
 * ## 为什么默认关
 *
 * 这会整体替换模型的说话方式与行为准则，属于"强副作用"开关。默认关，用户主动开。
 * 配置文件缺失、损坏、格式不对，一律当成关。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { KILO_PROMPT } from './prompt.js'

/** 路由前缀。 */
const ROUTE_STATE = '/plugins/kilo-prompt/state'

/** 段落名。刻意与 dsh-persona / dsh-system-prompt 的段落名不同，避免撞名。 */
const SECTION_NAME = 'kilo:persona'

/** 段落顺序：落在部署人格(0)之后、计划策略(500)之前。 */
const SECTION_ORDER = 100

/** 请求体上限。开关请求只有几十字节，给 4KB 足够，同时挡住乱传大 body。 */
const MAX_BODY_BYTES = 4096

/** 是否进入"彻底静默"模式：只用于本地调试，不进产品路径。 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 开关文件位置。与 model-usage / archived-sessions 的约定一致。 */
function settingsFile() {
  return join(dshHome(), 'plugin-data', 'dsh-kilo-prompt', 'settings.json')
}

/**
 * 读开关。默认关 —— 强副作用的功能，默认必须落在安全的一边。
 * @returns {boolean} 是否启用。
 */
function readEnabled() {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return parsed.enabled === true
  } catch {
    return false
  }
}

/**
 * 写开关。
 * @param {boolean} value 新值。
 * @returns {boolean} 是否写成功。
 */
function writeEnabled(value) {
  try {
    const file = settingsFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ enabled: value }, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 只接受同源发起的写请求。 */
function isTrustedWrite(req) {
  const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase()
  if (site === 'cross-site') return false
  const method = String(req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const origin = String((req.headers && req.headers.origin) || '')
  if (origin.length === 0) return true
  try {
    const host = String((req.headers && req.headers.host) || '')
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 用原生 req/res 读 JSON 请求体（不引入任何依赖）。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
  })
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文。
 */
export function apply(ctx) {
  const note = (message) => {
    try {
      const logger = ctx.logger ? ctx.logger('kilo-prompt') : null
      if (logger && typeof logger.info === 'function') logger.info(message)
    } catch {
      /* 日志失败不该影响主流程 */
    }
  }

  /** 当前开关状态。 */
  let enabled = readEnabled()

  /**
   * systemPrompt 服务。
   *
   * 冷启动时本插件可能早于 system-prompt 就绪，所以不能在模块加载期访问，
   * 必须走 ctx.inject 等它出现。拿到后立刻按当前开关决定是否注册段落。
   */
  let systemPrompt = null
  /** 段落注册返回的 disposer；null 表示当前没有注入。 */
  let disposeSection = null

  /**
   * 把开关状态同步到 system-prompt 段落上。
   *
   * 幂等：状态没变化就什么都不做，避免重复注册撞名。
   */
  const sync = () => {
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return

    if (enabled && disposeSection === null) {
      try {
        disposeSection = systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: KILO_PROMPT,
        })
        note('kilo prompt section registered')
      } catch (error) {
        // 注册失败（例如撞名）不能拖垮插件：记一笔，按钮仍会显示开关状态。
        note(`section registration failed: ${String((error && error.message) || error)}`)
        disposeSection = null
      }
      return
    }

    if (!enabled && disposeSection !== null) {
      try {
        disposeSection()
      } catch (error) {
        note(`section disposal failed: ${String((error && error.message) || error)}`)
      }
      disposeSection = null
      note('kilo prompt section removed')
    }
  }

  const stateHandler = (req, res) => {
    const method = String(req.method || 'GET').toUpperCase()
    const send = (code, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'no-store',
      })
      res.end(body)
    }

    if (!isTrustedWrite(req)) {
      send(403, { ok: false, error: 'cross-site request rejected' })
      return
    }

    if (method === 'GET' || method === 'HEAD') {
      send(200, {
        ok: true,
        enabled,
        // 让界面能显示"当前注入了多少字"，也方便排查是不是加载了空提示词。
        promptChars: KILO_PROMPT.length,
        section: SECTION_NAME,
        order: SECTION_ORDER,
        // 服务是否就绪：false 时开关可以拨但不会真正生效，界面该提示。
        ready: systemPrompt !== null,
      })
      return
    }

    if (method !== 'PUT' && method !== 'POST') {
      send(405, { ok: false, error: 'method not allowed' })
      return
    }

    // 返回 promise：webServer 不等待它，但测试与调用方可以 await 到真正写完响应。
    return readJsonBody(req)
      .then((body) => {
        if (typeof body.enabled !== 'boolean') {
          send(400, { ok: false, error: 'enabled must be boolean' })
          return
        }
        enabled = body.enabled
        // 写盘失败不回滚内存值：用户刚拨的开关，行为该立刻跟上。
        const saved = writeEnabled(enabled)
        sync()
        note(`enabled = ${enabled} (saved=${saved})`)
        send(200, { ok: true, enabled, saved, ready: systemPrompt !== null })
      })
      .catch((error) => {
        send(400, { ok: false, error: String((error && error.message) || error) })
      })
  }

  // 冷启动时序：system-prompt 与 webServer 都由别的插件提供，本插件可能更早加载，
  // 所以必须走 ctx.inject 等它们出现，不能裸访问 ctx.systemPrompt / ctx.webServer。
  const fiber = ctx.inject(['systemPrompt', 'webServer'], (child) => {
    systemPrompt = child.systemPrompt
    sync()

    let disposer = null
    try {
      disposer = child.webServer.register({
        kind: 'exact',
        path: ROUTE_STATE,
        handler: stateHandler,
      })
      note(`route registered: ${ROUTE_STATE}`)
    } catch (error) {
      // HMR 重入时会抛 duplicate exact route；旧 handler 功能等价，记一笔就够。
      note(`route registration failed: ${String((error && error.message) || error)}`)
    }

    return () => {
      try {
        if (disposer) disposer()
      } catch {
        /* 卸载路径不该再抛 */
      }
      // 卸载时务必撤掉段落，否则提示词会残留到下一轮请求。
      if (disposeSection !== null) {
        try {
          disposeSection()
        } catch {
          /* 同上 */
        }
        disposeSection = null
      }
      systemPrompt = null
    }
  })

  return () => {
    try {
      void fiber.dispose()
    } catch {
      /* 同上 */
    }
  }
}

export {
  KILO_PROMPT,
  MAX_BODY_BYTES,
  ROUTE_STATE,
  SECTION_NAME,
  SECTION_ORDER,
  readEnabled,
}