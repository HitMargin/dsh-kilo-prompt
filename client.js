/**
 * dsh-kilo-prompt · 客户端半边
 *
 * 在侧栏底部（铃铛旁边）放一个按钮，点一下开关 Kilo 内置提示词。
 *
 * 依赖：只 require('react')，由页面模块表提供。零构建。
 */
window.__ModuleLoader__.load({
  id: 'dsh-kilo-prompt',
  factory(require) {
    const React = require('react')

    const NS = 'dsh-kilo-prompt'
    const ROUTE_STATE = '/plugins/kilo-prompt/state'

    // 词典：与铃铛插件同一套 locale 机制（ctx.locale.register + bind），
    // 而不是在组件里猜 props.locale —— 宿主不保证注入它。
    const DICT = {
      zh: {
        label: 'Kilo 提示词',
        on: 'Kilo 提示词已开启',
        off: 'Kilo 提示词已关闭',
        enable: '开启 Kilo 内置提示词',
        disable: '关闭 Kilo 内置提示词',
        onHint: '已注入 soul + default（{n} 字）',
        offHint: '当前使用 DSH 默认提示词',
        failed: '操作失败',
        notReady: '系统提示词服务尚未就绪，稍后再试',
      },
      en: {
        label: 'Kilo prompt',
        on: 'Kilo prompt on',
        off: 'Kilo prompt off',
        enable: 'Enable the Kilo built-in prompt',
        disable: 'Disable the Kilo built-in prompt',
        onHint: 'soul + default injected ({n} chars)',
        offHint: 'Using the DSH default prompt',
        failed: 'Operation failed',
        notReady: 'The system-prompt service is not ready yet; try again shortly',
      },
    }

    const CSS = `
.${NS}-root {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.${NS}-root[data-on="true"] {
  color: var(--dsw-alias-state-success-primary, inherit);
}
.${NS}-root:disabled {
  cursor: default;
  opacity: 0.5;
}
.${NS}-icon { width: 15px; height: 15px; flex: none; }
.${NS}-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary, currentColor);
}
.${NS}-root[data-busy="true"] .${NS}-icon { animation: ${NS}-spin 900ms linear infinite; }
@keyframes ${NS}-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .${NS}-root[data-busy="true"] .${NS}-icon { animation: none; }
}
`

    /** 挂样式表，返回卸载函数。 */
    function mountStyles() {
      const id = `${NS}-style`
      const previous = document.getElementById(id)
      if (previous && typeof previous.remove === 'function') previous.remove()
      const tag = document.createElement('style')
      tag.id = id
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        const node = document.getElementById(id)
        if (node && typeof node.remove === 'function') node.remove()
      }
    }

    /** 图标：一张"文档 + 星"的图，表示"提示词"。 */
    function Icon() {
      return React.createElement(
        'svg',
        {
          className: `${NS}-icon`,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
        React.createElement('path', {
          d: 'M4 2.5h5.2L12.5 5.8v7.7a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z',
          stroke: 'currentColor',
          'stroke-width': '1.2',
          'stroke-linejoin': 'round',
        }),
        React.createElement('path', {
          d: 'M9 2.6v3.3h3.3',
          stroke: 'currentColor',
          'stroke-width': '1.2',
          'stroke-linejoin': 'round',
        }),
        React.createElement('path', {
          d: 'M6.9 7.1l.55 1.4 1.4.55-1.4.55-.55 1.4-.55-1.4-1.4-.55 1.4-.55.55-1.4Z',
          fill: 'currentColor',
        }),
      )
    }

    /**
     * 造按钮组件。`t` 由 locale 服务绑定好，闭包持有 —— 组件本身不碰 props.locale。
     * @param {(key: string) => string} t 翻译函数。
     * @returns {Function} React 组件。
     */
    function makeControl(t) {
      return function KiloPromptButton() {
        const [enabled, setEnabled] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [ready, setReady] = React.useState(true)
        const [chars, setChars] = React.useState(0)
        const [error, setError] = React.useState('')

        // 拉一次当前状态；拿不到就按"关"显示，但把 ready 标成 false 以便提示。
        React.useEffect(() => {
          let alive = true
          fetch(ROUTE_STATE, { method: 'GET' })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
            .then((data) => {
              if (!alive || !data || data.ok !== true) return
              setEnabled(data.enabled === true)
              setChars(typeof data.promptChars === 'number' ? data.promptChars : 0)
              setReady(data.ready !== false)
            })
            .catch(() => {
              if (!alive) return
              setReady(false)
            })
          return () => {
            alive = false
          }
        }, [])

        const toggle = React.useCallback(async () => {
          if (busy) return
          setBusy(true)
          setError('')
          const next = !enabled
          try {
            const res = await fetch(ROUTE_STATE, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled: next }),
            })
            const data = await res.json().catch(() => null)
            if (!res.ok || !data || data.ok !== true) {
              throw new Error((data && data.error) || `${t('failed')} (HTTP ${res.status})`)
            }
            setEnabled(data.enabled === true)
            if (data.ready === false) {
              setReady(false)
              setError(t('notReady'))
            } else {
              setReady(true)
            }
          } catch (cause) {
            setError(String((cause && cause.message) || cause || t('failed')))
          } finally {
            setBusy(false)
          }
        }, [busy, enabled, t])

        const hint = enabled ? t('onHint').replace('{n}', String(chars)) : t('offHint')
        const label = enabled ? t('disable') : t('enable')
        const title = ready ? `${enabled ? t('on') : t('off')} · ${hint}` : t('notReady')

        // 说明文字只走原生 title。
        //
        // 之前这里还渲染了一个自定义气泡（绝对定位在按钮右侧）。侧栏是窄的，
        // 那行文案比侧栏还宽，于是被祖先的 overflow 裁掉 —— 用户看到的就是
        // "文本被遮住了"。而原生 title 由浏览器绘制在层最上方，永远不会被裁，
        // 铃铛插件用的也是它。两者同时存在还会一个 hover 出两个提示。
        return React.createElement(
          'button',
          {
            type: 'button',
            className: `${NS}-root`,
            'data-on': enabled ? 'true' : 'false',
            'data-busy': busy ? 'true' : 'false',
            disabled: busy,
            'aria-pressed': enabled,
            'aria-label': label,
            title: error && error.length > 0 ? `${label} — ${error}` : title,
            onClick: toggle,
          },
          React.createElement(Icon),
          enabled ? React.createElement('span', { className: `${NS}-dot` }) : null,
        )
      }
    }

    return {
      name: 'dsh-kilo-prompt',
      inject: ['slots', 'locale'],

      apply(ctx) {
        // HMR 会重跑 apply 而不先卸载旧实例：先拆掉上一份，避免 slot 重复注册。
        try {
          if (typeof window.__KILO_PROMPT_DISPOSE__ === 'function') window.__KILO_PROMPT_DISPOSE__()
        } catch {
          /* 旧实例已经烂了也不影响新实例 */
        }

        const disposers = []
        const own = (fn) => {
          try {
            const dispose = fn()
            if (typeof dispose === 'function') disposers.push(dispose)
          } catch {
            /* 单个注册失败不该阻断其余 */
          }
        }

        own(() => ctx.locale.register(NS, DICT))
        const t = ctx.locale.bind(NS)
        own(() => mountStyles())
        own(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: NS,
          order: 20,
          label: () => t('label'),
        }, makeControl(t))))

        // HMR 不需要额外监听：每次 apply() 开头都会调用 window.__KILO_PROMPT_DISPOSE__
        // 拆掉上一份，靠这个全局钩子就够了（与铃铛插件一致）。
        // 这里刻意不使用 import.meta —— 沙箱测试里跑的是普通脚本，不支持它。
        window.__KILO_PROMPT_DISPOSE__ = () => {
          for (const dispose of disposers.splice(0).reverse()) {
            try {
              dispose()
            } catch {
              /* 单个清理失败不该阻断其余 */
            }
          }
          delete window.__KILO_PROMPT_DISPOSE__
        }
      },
    }
  },
})