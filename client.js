// P2：Node 环境（无 window / 无模块加载器）导入本文件为空操作，避免 ReferenceError
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({
    id: 'dsh-usage-stats',
    factory: (require) => {
      const React = require('react')
      const module = { exports: {} }

    const USAGE_URL = 'https://platform.deepseek.com/usage'
    const QUERY_ROUTE = '/api/usage-stats/query'
    const UPDATE_ROUTE = '/api/usage-stats/update'
    const STATUS_ROUTE = '/api/usage-stats/status'
    const REFRESH_MS = 60000
    const UPDATE_POLL_MS = 3600 * 1000 // 版本检测低频：1 小时一轮
    const STATUS_POLL_MS = 5 * 60 * 1000 // 服务状态无告警：5 分钟一轮（事故更新是分钟级，够用）
    const STATUS_POLL_ALERT_MS = 60 * 1000 // 有告警：1 分钟一轮盯恢复，别让已解决的告警多挂几分钟
    const UPDATE_BADGE_TEXT = '有新版'
    const UPDATE_BADGE_CLASS = 'dshus-upd-badge'

    function formatCompactTokens(value) {
      if (value < 1_000) return String(Math.round(value))
      if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`
      if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`
      return `${(value / 1_000_000_000).toFixed(2)}B`
    }

    // 与平台页一致：金额去尾（截断）到 2 位小数，而非四舍五入——避免"多 0.01"
    function truncate2(value) {
      return Math.floor(value * 100 + 1e-6) / 100
    }

    function formatMoney(value, currency) {
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : (currency ? `${currency} ` : '')
      return `${symbol}${truncate2(value).toFixed(2)}`
    }

    function formatBalance(amount, currency) {
      const symbol = currency === 'CNY' ? '￥' : currency === 'USD' ? '$' : (currency ? `${currency} ` : '')
      return `余额 ${symbol}${truncate2(amount).toFixed(2)}`
    }

    // --- 峰谷时段逻辑（回归测试按这两个标记切片，别删这两行注释）-----------------
    // 规则来源（口径以官方为准，改前先核对）：
    //   1) 文档「模型 & 价格」脚注：空闲价为高峰价一半；北京时间**周一至周五（不含
    //      中国法定节假日）9:00-12:00、14:00-18:00 为高峰**；其余时段，包括周末及
    //      中国法定节假日全天，均为空闲。
    //      https://api-docs.deepseek.com/zh-cn/quick_start/pricing
    //   2) 2026-09-19《DeepSeek API 峰谷时间说明》：**调休上班的周末**、中国法定节假日
    //      全天均按空闲时段计费 —— 即「调休补班」不会把周末变成高峰。
    // 节假日取《国务院办公厅关于 2026 年部分节假日安排的通知》的「放假」区间（含调休
    // 拼出的连休，如国庆 10/1-7；区间内的 10/5-7 是调休工作日，按官方口径仍算节假日全天）。
    //   https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
    // 本标签只做展示，不参与 token 或费用计算（金额一律取官方数据）。
    const CN_HOLIDAY_YEAR = 2026 // 每年 11 月前后国务院发布下一年安排，届时补一段
    const CN_HOLIDAYS = [
      ['2026-01-01', '2026-01-03', '元旦'],
      ['2026-02-15', '2026-02-23', '春节'],
      ['2026-04-04', '2026-04-06', '清明'],
      ['2026-05-01', '2026-05-05', '劳动节'],
      ['2026-06-19', '2026-06-21', '端午'],
      ['2026-09-25', '2026-09-27', '中秋'],
      ['2026-10-01', '2026-10-07', '国庆'],
    ]
    // 调休上班的周末（通知里「X 月 X 日（周六/周日）上班」那些天）：判定上等同普通周末，
    // 这里只用来把 tooltip 说清楚 —— 谁要是把补班日当工作日算高峰，就踩到 2026-09-19 公告。
    const CN_MAKEUP_WEEKENDS = [
      '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
    ]
    const PEAK_HOUR_RANGES = [[9, 12], [14, 18]]

    function cnHolidayName(ymd) {
      for (const [start, end, name] of CN_HOLIDAYS) {
        if (ymd >= start && ymd <= end) return name
      }
      return null
    }

    // 北京时间（固定 UTC+8：中国自 1991 年起无夏令时）。nowMs 可注入，便于测试。
    function beijingTime(nowMs) {
      const d = new Date((nowMs === undefined ? Date.now() : nowMs) + 8 * 60 * 60 * 1000)
      return {
        year: d.getUTCFullYear(),
        hour: d.getUTCHours(),
        weekday: d.getUTCDay(),
        ymd: d.toISOString().slice(0, 10),
      }
    }

    // 当前计费时段：{ label: '高峰' | '空闲', hint }。hint 只进 tooltip，不占版面。
    function pricingTier(nowMs) {
      const { year, hour, weekday, ymd } = beijingTime(nowMs)
      // 跨年后国务院还没发新安排时的兜底：照工作日时段的规则走，但把话说出来
      const stale = year > CN_HOLIDAY_YEAR
        ? `（节假日数据截至 ${CN_HOLIDAY_YEAR} 年，${year} 年安排发布后需更新）`
        : ''
      // 先认节假日再认周末：假期与周末重叠时（如 2026-10-03 周六在国庆里），
      // 说「国庆假期」比说「周末」更贴事实
      const holiday = cnHolidayName(ymd)
      if (holiday !== null) {
        return { label: '空闲', hint: `${holiday}假期全天按空闲时段计费${stale}` }
      }
      if (weekday === 0 || weekday === 6) {
        const makeup = CN_MAKEUP_WEEKENDS.indexOf(ymd) >= 0
          ? '；官方明确：调休上班的周末也按空闲时段计费'
          : ''
        return { label: '空闲', hint: `周末全天按空闲时段计费${makeup}${stale}` }
      }
      for (const [from, to] of PEAK_HOUR_RANGES) {
        if (hour >= from && hour < to) {
          return { label: '高峰', hint: `工作日高峰时段 ${from}:00-${to}:00（北京时间）${stale}` }
        }
      }
      return {
        label: '空闲',
        hint: `工作日非高峰时段（高峰为 9:00-12:00、14:00-18:00，北京时间）${stale}`,
      }
    }
    // --- 峰谷时段逻辑结束 -------------------------------------------------------

    module.exports.inject = ['slots']

    module.exports.apply = function apply(ctx) {
      const style = document.createElement('style')
      style.textContent = `
        [class*="footerActions"] { flex-wrap: wrap; }
        .dshus-wrap { display: flex; flex-direction: column; flex: 0 0 100%; min-width: 0; }
        /* 服务状态提示：与卡片同宽（同一个 12px 内边距）→ 文字与「用量信息」对齐。
           形态见 backlog/specs/服务状态提示.md（原型定稿的变体 A）。 */
        .dshus-hint {
          display: flex; align-items: center; gap: 5px; min-width: 0;
          flex: none; /* 不可压缩：告警行被压扁过一次（见下 .dshus-block 的注释） */
          margin: 0 0 3px; padding: 3px var(--dsh-sidebar-inline-padding);
          border-radius: 4px; font-size: 11px; line-height: 1.4; text-decoration: none;
          white-space: nowrap; overflow: hidden;
        }
        .dshus-hint-icon { flex: none; font-size: 10px; }
        .dshus-hint-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .dshus-hint-arrow { flex: none; opacity: .8; }
        .dshus-hint-warn { color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary); }
        /* 主题里没有 error 版的 tertiary，用状态色自己调一层 wash（不支持 color-mix 时
           退回官方的 danger hover 底色，只是更淡） */
        .dshus-hint-error {
          color: var(--dsw-alias-state-error-primary);
          background: var(--dsw-alias-interactive-bg-hover-danger);
          background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);
        }
        .dshus-block {
          /* flex: none，别写 100%：这个卡片始终在 column 方向的 .dshus-wrap 里，
             那里的 flex-basis 100% 是**高度**（不是宽度）—— 它会吃掉整个 wrap 高度，
             把上面的告警行挤成 6px（告警自身 overflow:hidden 于是一半字被裁）。
             实测（2026-09-20，注入告警行后量 DOM）：flex:0 0 100% 时告警行 6px/内容 14px；
             改 none 后 21.4px，卡片回到自然高度 70.2px，wrap = 三者之和 94.6px。
             宽度不受影响：column 容器里靠 align-items: stretch 撑满。 */
          display: flex; flex-direction: column; gap: 3px; flex: none;
          min-width: 0; padding: 7px var(--dsh-sidebar-inline-padding); box-sizing: border-box;
          font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-primary);
        }
        .dshus-headrow {
          display: flex; align-items: center; justify-content: space-between;
          gap: 8px; min-width: 0; margin-bottom: 2px;
        }
        .dshus-head {
          display: flex; align-items: center; gap: 0; min-width: 0;
          text-decoration: none; color: var(--dsw-alias-label-primary);
          border-radius: 4px; padding: 1px 2px 1px 0; align-self: flex-start;
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
          flex: none; color: var(--dsw-alias-label-secondary);
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
          text-decoration: none;
        }
        /* 收起态有故障：整项从 Σ 摘要换成图标（tooltip 带完整文案） */
        .dshus-rail-alert { border-radius: 4px; padding: 4px 0; font-size: 12px; }
        .dshus-loading { color: var(--dsw-alias-label-tertiary); font-size: 10px; }
        .dshus-upd-badge {
          flex: none; align-self: center;
          font-size: 9px; line-height: 1; font-weight: 400;
          color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1);
          border-radius: 3px; padding: 2px 5px;
          white-space: nowrap; text-decoration: none; cursor: pointer;
          position: relative; z-index: 1;
        }
        .dshus-upd-badge:hover { color: var(--dsw-alias-brand-primary); }
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
              .then((response) => {
                if (!response.ok) throw new Error('usage unavailable')
                return response.json()
              })
              .then((payload) => {
                if (!alive) return
                if (!payload || !['ready', 'unavailable', 'configuration_required'].includes(payload.status)) {
                  throw new Error('invalid usage response')
                }
                setData(payload)
              })
              .catch(() => {
                if (alive) setData({ status: 'unavailable', officialError: '官方数据暂不可用，请稍后重试' })
              })
            timer = setTimeout(load, REFRESH_MS)
          }
          load()
          return () => { alive = false; if (timer !== null) clearTimeout(timer) }
        }, [])

        // 服务状态：只在「有影响」时出现。拉不到就按「没问题」处理（问不到 ≠ 出问题）。
        // 有告警时改 1 分钟一轮 —— 5 分钟一轮会让「官方已标 resolved」多挂好几分钟
        //（2026-09-23 实测：15:44 恢复，界面还挂着，刷新才消失）。host 侧也同步收紧到 30s，
        // 两段加起来恢复最多 ~1 分钟就翻牌；没告警时仍是 5 分钟一轮。
        const [alert, setAlert] = React.useState(null)
        React.useEffect(() => {
          let alive = true
          let timer = null
          let shown = null // 与 setAlert 同步的镜像：决定下一轮的间隔（state 读不到最新值）
          const arm = () => {
            // 任何时刻只留一个定时器；先排下一轮，fetch 挂死也不会让轮询停摆
            if (timer !== null) clearTimeout(timer)
            timer = setTimeout(load, shown === null ? STATUS_POLL_MS : STATUS_POLL_ALERT_MS)
          }
          const apply = (next) => {
            if (next === shown) return
            shown = next // 出告警→收紧节奏；恢复→放松。立刻重排，避免旧节奏再跑一轮
            setAlert(next)
            arm()
          }
          const load = () => {
            arm()
            fetch(STATUS_ROUTE, { headers: { Accept: 'application/json' } })
              .then((response) => (response.ok ? response.json() : null))
              .then((payload) => {
                if (!alive) return
                apply(payload !== null && typeof payload === 'object' && payload.active === true ? payload : null)
              })
              .catch(() => { if (alive) apply(null) })
          }
          // 标签页在后台会被节流/冻结，定时器停摆；回到前台补拉一次（「刷新才消失」的另一半原因）
          const onVisible = () => { if (document.visibilityState === 'visible') load() }
          document.addEventListener('visibilitychange', onVisible)
          load()
          return () => {
            alive = false
            if (timer !== null) clearTimeout(timer)
            document.removeEventListener('visibilitychange', onVisible)
          }
        }, [])

        // severity 只认 error，其余（含字段缺失）一律按 warn 渲染，避免出现没样式的条
        const alertSeverity = alert === null ? null : (alert.severity === 'error' ? 'error' : 'warn')
        const alertIcon = alert === null ? '' : (alertSeverity === 'error' ? '⛔' : '⚠')
        const alertText = alert === null ? '' : `${alert.label}${alert.since ? ` · ${alert.since} 起` : ''}`
        const alertTitle = alert === null ? '' : [
          alert.title,
          alert.components ? `受影响：${alert.components}` : '',
          alert.since ? `${alert.since} 起` : '',
        ].filter(Boolean).join('\n')
        const hint = alert === null ? null : React.createElement('a', {
          className: `dshus-hint dshus-hint-${alertSeverity}`,
          href: alert.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: alertTitle,
        },
          React.createElement('span', { className: 'dshus-hint-icon' }, alertIcon),
          React.createElement('span', { className: 'dshus-hint-text' }, alertText),
          React.createElement('span', { className: 'dshus-hint-arrow' }, '↗'))
        // 收起态空间只够一个图标：整项让给告警，tooltip 里给全信息
        const railAlert = alert === null ? null : React.createElement('a', {
          className: `dshus-rail dshus-rail-alert dshus-hint-${alertSeverity}`,
          href: alert.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: alertTitle,
        }, alertIcon)
        const withHint = (children) => React.createElement('div', { className: 'dshus-wrap' }, hint, children)

        // 峰谷标签：每次渲染取当前时刻（卡片每 60s 刷新一次，跨时段最迟 1 分钟翻牌）
        const tier = data !== null ? pricingTier() : null

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
            tier !== null
              ? React.createElement('span', { className: 'dshus-badge', title: tier.hint }, tier.label)
              : null),
          data !== null && data.balance !== null && data.balance !== undefined
            ? React.createElement('span', { className: 'dshus-balance' }, formatBalance(data.balance.amount, data.balance.currency))
            : null)

        if (data === null) {
          if (!wide && railAlert !== null) return railAlert
          return withHint(React.createElement('div', { className: 'dshus-block' }, head,
            React.createElement('div', { className: 'dshus-loading' }, '统计中…')))
        }

        if (data.status !== 'ready') {
          const message = data.scanHint || data.officialError || '官方数据暂不可用'
          if (!wide) return railAlert !== null ? railAlert : React.createElement('div', { className: 'dshus-rail', title: message }, 'Σ —')
          return withHint(React.createElement('div', { className: 'dshus-block' }, head,
            React.createElement('div', { className: 'dshus-loading' }, message)))
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
          return withHint(React.createElement('div', { className: 'dshus-block' }, head, todayLine, monthLine,
            data.scanHint ? React.createElement('div', { className: 'dshus-loading' }, data.scanHint) : null))
        }
        if (railAlert !== null) return railAlert
        return React.createElement('div', {
          className: 'dshus-rail',
          title: `今日 ${formatCompactTokens(data.today.tokens)} tok · ${formatMoney(data.today.cost, data.currency)}，本月 ${formatCompactTokens(data.month.tokens)} tok${data.scanHint ? `\n${data.scanHint}` : ''}`,
        }, `Σ ${formatCompactTokens(data.today.tokens)}`)
      }

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'usage-stats' },
        (props) => React.createElement(UsageStats, props),
      ))

      // ---- 检测新版：品牌行「有新版」徽章 ----
      // 只有服务端报告 hasUpdate 才注入。品牌行外层是 <button onClick=startSession>，
      // 锚点点击必须 stopPropagation（不 preventDefault），否则会触发新建会话。
      const updateState = { hasUpdate: false, url: USAGE_URL }
      let badgeAnchor = null
      let updateTimer = null
      let badgeObserver = null

      function clearBadge() {
        if (badgeObserver !== null) { badgeObserver.disconnect(); badgeObserver = null }
        if (badgeAnchor && badgeAnchor.parentNode) badgeAnchor.parentNode.removeChild(badgeAnchor)
        badgeAnchor = null
      }

      function ensureBadge() {
        if (!updateState.hasUpdate) { clearBadge(); return }
        if (badgeAnchor && document.body.contains(badgeAnchor)) return
        const container = document.querySelector('[class*="brandIdentity"]')
        if (!container || container.querySelector(`.${UPDATE_BADGE_CLASS}`)) return
        badgeAnchor = document.createElement('a')
        badgeAnchor.className = UPDATE_BADGE_CLASS
        badgeAnchor.href = updateState.url
        badgeAnchor.target = '_blank'
        badgeAnchor.rel = 'noopener noreferrer'
        badgeAnchor.textContent = UPDATE_BADGE_TEXT
        badgeAnchor.addEventListener('click', (event) => { event.stopPropagation() })
        container.appendChild(badgeAnchor)
        if (badgeObserver === null) {
          // React 渲染会重建品牌行 DOM，观察变化以便徽章被清掉后重新挂上
          badgeObserver = new MutationObserver(ensureBadge)
          badgeObserver.observe(document.body, { childList: true, subtree: true })
        }
      }

      function pollUpdate() {
        fetch(UPDATE_ROUTE, { headers: { Accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            updateState.hasUpdate = !!(payload && typeof payload === 'object' && payload.hasUpdate === true)
            if (payload && typeof payload === 'object' && typeof payload.url === 'string') updateState.url = payload.url
            ensureBadge()
          })
          .catch(() => { updateState.hasUpdate = false; clearBadge() })
        updateTimer = setTimeout(pollUpdate, UPDATE_POLL_MS)
      }
      pollUpdate()

      ctx.on('dispose', () => {
        if (updateTimer !== null) clearTimeout(updateTimer)
        clearBadge()
      })
    }

      return module.exports
    },
  })
}
