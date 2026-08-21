// P2：Node 环境（无 window / 无模块加载器）导入本文件为空操作，避免 ReferenceError
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({
    id: 'dsh-usage-stats',
    factory: (require) => {
      const React = require('react')
      const module = { exports: {} }

    const USAGE_URL = 'https://platform.deepseek.com/usage'
    const QUERY_ROUTE = '/api/usage-stats/query'
    const REFRESH_MS = 60000

    function formatCompactTokens(value) {
      if (value < 1_000) return String(Math.round(value))
      if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`
      if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`
      return `${(value / 1_000_000_000).toFixed(2)}B`
    }

    function formatMoney(value, currency) {
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : (currency ? `${currency} ` : '')
      return `${symbol}${value.toFixed(2)}`
    }

    function formatBalance(amount, currency) {
      const symbol = currency === 'CNY' ? '￥' : currency === 'USD' ? '$' : (currency ? `${currency} ` : '')
      return `余额 ${symbol}${amount.toFixed(2)}`
    }

    module.exports.inject = ['slots']

    module.exports.apply = function apply(ctx) {
      const style = document.createElement('style')
      style.textContent = `
        [class*="footerActions"] { flex-wrap: wrap; }
        .dshus-block {
          display: flex; flex-direction: column; gap: 3px; flex: 0 0 100%;
          min-width: 0; padding: 7px 10px; box-sizing: border-box;
          font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-primary);
        }
        .dshus-headrow {
          display: flex; align-items: center; justify-content: space-between;
          gap: 8px; min-width: 0; margin-bottom: 2px;
        }
        .dshus-head {
          display: flex; align-items: center; gap: 0; min-width: 0;
          text-decoration: none; color: var(--dsw-alias-label-primary);
          border-radius: 4px; padding: 1px 2px; align-self: flex-start;
        }
        .dshus-head:hover { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }
        .dshus-title { min-width: 0; font-size: 11px; font-weight: 600; line-height: 1.4; }
        .dshus-link { flex: none; color: inherit; font-size: 12px; line-height: 1; }
        .dshus-badge {
          margin-left: 5px; font-size: 9px; line-height: 1; font-weight: 400;
          color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1);
          border-radius: 3px; padding: 2px 4px; align-self: center;
        }
        .dshus-balance {
          flex: none; font-size: 10px; color: var(--dsw-alias-label-secondary);
          font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .dshus-row { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
        .dshus-label { flex: none; color: var(--dsw-alias-label-secondary); }
        .dshus-tok {
          flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; font-variant-numeric: tabular-nums;
        }
        .dshus-cost { flex: none; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
        .dshus-rail {
          display: flex; align-items: center; justify-content: center; padding: 6px 0;
          font-size: 10px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary);
        }
        .dshus-loading { color: var(--dsw-alias-label-tertiary); font-size: 10px; }
      `
      document.head.appendChild(style)
      ctx.on('dispose', () => { style.remove() })

      function UsageStats(props) {
        const wide = props.wide === true
        const [data, setData] = React.useState(null)

        React.useEffect(() => {
          let alive = true
          let timer = null
          const load = () => {
            fetch(QUERY_ROUTE, { headers: { Accept: 'application/json' } })
              .then((response) => response.json())
              .then((payload) => {
                if (!alive) return
                if (payload !== null && typeof payload === 'object' && payload.today !== undefined) {
                  setData(payload)
                }
              })
              .catch(() => {})
            timer = setTimeout(load, REFRESH_MS)
          }
          load()
          return () => { alive = false; if (timer !== null) clearTimeout(timer) }
        }, [])

        const head = React.createElement('div', { className: 'dshus-headrow' },
          React.createElement('a', {
            className: 'dshus-head',
            href: USAGE_URL,
            target: '_blank',
            rel: 'noopener noreferrer',
            title: '打开官方用量页',
          },
            React.createElement('span', { className: 'dshus-title' }, '用量信息'),
            React.createElement('span', { className: 'dshus-link' }, '↗'),
            data !== null && data.source === 'official'
              ? React.createElement('span', { className: 'dshus-badge' }, '官方')
              : null),
          data !== null && data.balance !== null && data.balance !== undefined
            ? React.createElement('span', { className: 'dshus-balance' }, formatBalance(data.balance.amount, data.balance.currency))
            : null)

        if (data === null) {
          return React.createElement('div', { className: 'dshus-block' }, head,
            React.createElement('div', { className: 'dshus-loading' }, '统计中…'))
        }

        const todayLine = React.createElement('div', { className: 'dshus-row' },
          React.createElement('span', { className: 'dshus-label' }, '今日'),
          React.createElement('span', { className: 'dshus-tok' }, `${formatCompactTokens(data.today.tokens)} tok`),
          React.createElement('span', { className: 'dshus-cost' }, formatMoney(data.today.cost, data.currency)))
        const monthLine = React.createElement('div', { className: 'dshus-row' },
          React.createElement('span', { className: 'dshus-label' }, '本月'),
          React.createElement('span', { className: 'dshus-tok' }, `${formatCompactTokens(data.month.tokens)} tok`),
          React.createElement('span', { className: 'dshus-cost' }, formatMoney(data.month.cost, data.currency)))

        if (wide) {
          return React.createElement('div', { className: 'dshus-block' }, head, todayLine, monthLine)
        }
        return React.createElement('div', {
          className: 'dshus-rail',
          title: `今日 ${formatCompactTokens(data.today.tokens)} tok · ${formatMoney(data.today.cost, data.currency)}，本月 ${formatCompactTokens(data.month.tokens)} tok`,
        }, `Σ ${formatCompactTokens(data.today.tokens)}`)
      }

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'usage-stats' },
        (props) => React.createElement(UsageStats, props),
      ))
    }

      return module.exports
    },
  })
}
