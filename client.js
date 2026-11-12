// Node 环境（无 window / 无模块加载器）导入本文件为空操作，避免 ReferenceError
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
    const ALERTS_ROUTE = '/api/usage-stats/alerts'
    // host 侧还没重启（客户端热更新先到）时 /alerts 会 404 —— 这时列出官方组件但禁用，
    // 让用户看到「重启 dsh web 后生效」，而不是一句莫名的「读取失败」。
    // 顺序与官方「订阅特定组件」一致（api 组在前，网页版在后）。
    const FALLBACK_COMPONENT_OPTIONS = [
      { key: 'pro', group: 'api', label: 'Pro', component: null },
      { key: 'flash', group: 'api', label: 'Flash', component: null },
      { key: 'search', group: 'api', label: '搜索 API', component: null },
      { key: 'fetch', group: 'api', label: '抓取 API', component: null },
      { key: 'other', group: 'api', label: '其它 API', component: null },
      { key: 'chat', group: 'web', label: '对话服务', component: null },
      { key: 'upload', group: 'web', label: '上传文件服务', component: null },
    ]
    // 设置页存完档发这个事件：侧边栏立刻重拉一次状态，不用等下一轮 5 分钟轮询
    const ALERTS_CHANGED_EVENT = 'dshus:alerts-changed'

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
        // 调休上班的周末同样落在这里：官方口径是补班日也按空闲计费（2026-09-19 公告），
        // 而它们本来就是周末，所以不需要单独一张表 —— 判定上等同普通周末。
        return { label: '空闲', hint: `周末全天按空闲时段计费${stale}` }
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
        /* 悬浮底色用 interactive-bg-hover，别用 bg-layer-*：layer 系列在浅色主题里等于
           底色（都是 #fff），于是白底叠在 #f9fafb 的侧边栏上既看不见徽章、也看不见悬浮
           反馈；深色主题下同一个 token 是 #232324、对着 #1b1b1c 有对比，所以只考虑深色
           时看不出问题。interactive-bg-hover 是「叠在任何底色上都成立的 ink/white 覆盖层」，
           叠出来浅色 #eceef0（ΔE 4.3）、深色 #2c2c2e（ΔE 8.2），两边都读得出来。 */
        .dshus-head:hover { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); }
        .dshus-title { min-width: 0; font-size: 11px; font-weight: 600; line-height: 1.4; }
        .dshus-link { flex: none; color: inherit; font-size: 12px; line-height: 1; }
        .dshus-badge {
          margin-left: 5px; font-size: 9px; line-height: 1; font-weight: 400;
          color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover);
          border-radius: 3px; padding: 2px 4px; align-self: center;
        }
        /* 高峰上实心琥珀：有颜色 = 高峰，灰 = 空闲，不用读字就能扫出来。
           用「实心底 + 深墨字」而不是「淡底 + 琥珀字」：amber-600 压 amber-100 只有
           2.58:1，9px 小字读不清；这组（amber-500 底 + 静态 amber-900 字）是 7.2:1。
           字色故意用 static token：alias 的 label 系在两个主题里一黑一白，压不住同一个
           实心底；static-amber-900 两个主题同值（#27241f），所以深浅下都成立。
           空闲保持中性灰，不另加绿色：绿色在这个界面里容易被读成「服务健康」，
           而这是计费时段，不是服务状态。 */
        .dshus-badge-peak {
          color: var(--dsw-static-amber-900);
          background: var(--dsw-alias-state-warn-primary);
          font-weight: 500;
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
        /* 沿用原来「有新版」小徽章的样式，只挪位置 + 字号提到 11px（与用量卡正文同号）；
           右边缘跟上面的用量卡对齐：卡片内容内缩一个 --dsh-sidebar-inline-padding，
           这里补同样的右边距，别比「余额」那一列多探出去 8px。 */
        .dshus-upd-badge {
          flex: none; margin-inline-start: auto;
          margin-inline-end: var(--dsh-sidebar-inline-padding, 8px);
          align-self: center;
          font-size: 11px; line-height: 1; font-weight: 400;
          color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover);
          border-radius: 3px; padding: 3px 6px;
          white-space: nowrap; text-decoration: none; cursor: pointer;
        }
        .dshus-upd-badge:hover { color: var(--dsw-alias-brand-primary); }

        /* ---- 设置页：API 告警组件 ---- */
        /* 与官方设置页同宽（720px）+ 语义 token，浅色/深色跟着主题走 */
        .dshus-set { display: flex; flex-direction: column; gap: 12px; max-width: 720px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
        .dshus-set-title { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; }
        .dshus-set-intro { margin: 0; color: var(--dsw-alias-label-secondary); }
        .dshus-set-card { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }
        .dshus-set-cardhead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-weight: 500; }
        .dshus-set-carddesc { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 400; }
        .dshus-set-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; cursor: pointer; }
        .dshus-set-row + .dshus-set-row { border-top: 1px solid var(--dsw-alias-border-l1); }
        .dshus-set-row input[type="checkbox"] { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--dsw-alias-state-business-primary); cursor: pointer; }
        .dshus-set-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .dshus-set-label { font-size: 13px; }
        .dshus-set-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dshus-set-note { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
        .dshus-set-msg { font-size: 12px; }
        .dshus-set-msg-error { color: var(--dsw-alias-state-error-primary); }
        .dshus-set-msg-ok { color: var(--dsw-alias-label-tertiary); }
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
        // host 侧也同步收紧到 30s，两段加起来恢复最多 ~1 分钟就翻牌；没告警时仍是 5 分钟一轮。
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
          // 设置页改了静音的组件：立刻重拉，别等下一轮轮询（5 分钟太久，用户会以为没生效）
          const onAlertsChanged = () => { load() }
          window.addEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged)
          load()
          return () => {
            alive = false
            if (timer !== null) clearTimeout(timer)
            document.removeEventListener('visibilitychange', onVisible)
            window.removeEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged)
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
              ? React.createElement('span', {
                  className: `dshus-badge dshus-badge-${tier.label === '高峰' ? 'peak' : 'idle'}`,
                  title: tier.hint,
                }, tier.label)
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
          const message = data.officialError || '官方数据暂不可用'
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
          return withHint(React.createElement('div', { className: 'dshus-block' }, head, todayLine, monthLine))
        }
        if (railAlert !== null) return railAlert
        return React.createElement('div', {
          className: 'dshus-rail',
          title: `今日 ${formatCompactTokens(data.today.tokens)} tok · ${formatMoney(data.today.cost, data.currency)}，本月 ${formatCompactTokens(data.month.tokens)} tok`,
        }, `Σ ${formatCompactTokens(data.today.tokens)}`)
      }

      // ---- 设置页：API 告警组件 ----
      // 官方状态页的「订阅更新 → 订阅特定组件」就是这页的对应物：按官方组件（V4 Pro / V4.1 Flash /
      // 搜索 API / 抓取 API / 对话服务 / 上传文件服务）逐项勾选。用户通常只关心自己在用的那几项：
      // pro 有告警而自己跑 flash 时不该被打扰。关掉的项写进 host 侧设置
      // （~/.dsh/dsh-usage-stats.settings.json），状态路由据此过滤。
      function UsageStatsSettings() {
        const [state, setState] = React.useState({ phase: 'loading', options: [], muted: [], error: null })
        const [saved, setSaved] = React.useState(false)

        React.useEffect(() => {
          let alive = true
          fetch(ALERTS_ROUTE, { headers: { Accept: 'application/json' } })
            .then((response) => {
              // 404 = 客户端已更新、host 还是旧进程（插件升级后的常态）：照实说，别当故障
              if (response.status === 404) return { ok: 'restart-required' }
              return response.ok ? response.json() : Promise.reject(new Error(String(response.status)))
            })
            .then((payload) => {
              if (payload && payload.ok === 'restart-required') {
                if (alive) setState({ phase: 'skew', options: FALLBACK_COMPONENT_OPTIONS, muted: [], error: null })
                return
              }
              if (!alive) return
              if (!payload || payload.ok !== true) throw new Error('invalid alerts response')
              setState({
                phase: 'ready',
                options: Array.isArray(payload.options) ? payload.options : [],
                muted: Array.isArray(payload.muted) ? payload.muted : [],
                error: null,
              })
            })
            .catch(() => {
              if (alive) setState({ phase: 'error', options: [], muted: [], error: '读取设置失败，请稍后重试；刚更新过插件的话，重启 dsh web 后生效' })
            })
          return () => { alive = false }
        }, [])

        const save = (nextMuted) => {
          // 先本地翻牌（勾选框立刻响应），失败再回滚提示
          setState((prev) => ({ ...prev, muted: nextMuted, error: null }))
          setSaved(false)
          fetch(ALERTS_ROUTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ muted: nextMuted }),
          })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
            .then((payload) => {
              if (!payload || payload.ok !== true) throw new Error('invalid alerts response')
              setState((prev) => ({ ...prev, muted: Array.isArray(payload.muted) ? payload.muted : prev.muted }))
              setSaved(true)
              // 让侧边栏立刻按新设置重拉一次状态，否则最长要等下一轮 5 分钟轮询
              window.dispatchEvent(new CustomEvent(ALERTS_CHANGED_EVENT))
            })
            .catch(() => setState((prev) => ({ ...prev, error: '保存失败（设置未生效），请稍后重试' })))
        }

        const toggle = (key) => {
          const muted = state.muted.includes(key) ? state.muted.filter((item) => item !== key) : [...state.muted, key]
          save(muted)
        }

        const children = [React.createElement('h2', { className: 'dshus-set-title', key: 'title' }, '用量统计')]
        children.push(React.createElement('p', { className: 'dshus-set-intro', key: 'intro' },
          '侧边栏「用量信息」卡片与官方服务故障提示的偏好设置。'))

        const optionRows = (options, disabled) => options.map((option) => {
          const key = String(option.key)
          const on = disabled ? true : !state.muted.includes(key)
          return React.createElement('label', { className: 'dshus-set-row', key },
            React.createElement('input', {
              type: 'checkbox',
              checked: on,
              disabled,
              onChange: disabled ? undefined : () => toggle(key),
            }),
            React.createElement('span', { className: 'dshus-set-body' },
              React.createElement('span', { className: 'dshus-set-label' }, String(option.label || key)),
              option.component
                ? React.createElement('span', { className: 'dshus-set-hint', title: String(option.component) }, String(option.component))
                : null))
        })

        const card = (key, title, desc, options, note, disabled) => React.createElement('div', { className: 'dshus-set-card', key },
          React.createElement('div', { className: 'dshus-set-cardhead' },
            React.createElement('span', null, title),
            React.createElement('span', { className: 'dshus-set-carddesc' }, desc)),
          optionRows(options, disabled),
          note === null ? null : React.createElement('p', { className: 'dshus-set-note' }, note))

        if (state.phase === 'loading') {
          children.push(React.createElement('p', { className: 'dshus-set-note', key: 'loading' }, '读取中…'))
        } else if (state.phase === 'skew') {
          children.push(card('skew-api', 'API 服务', '重启 dsh web 后可以在这里勾选',
            state.options.filter((option) => option.group !== 'web'), null, true))
          children.push(card('skew-web', '网页版服务', '重启 dsh web 后可以在这里勾选',
            state.options.filter((option) => option.group === 'web'), null, true))
          children.push(React.createElement('p', { className: 'dshus-set-note', key: 'skew-note' },
            '插件已更新，但 Host 还是旧进程（没有 /api/usage-stats/alerts 路由）：重启 dsh web 后本页生效。'))
        } else if (state.phase === 'error') {
          children.push(React.createElement('p', { className: 'dshus-set-msg dshus-set-msg-error', key: 'error' }, state.error))
        } else {
          const api = state.options.filter((option) => option.group !== 'web')
          const web = state.options.filter((option) => option.group === 'web')
          children.push(card('api', 'API 服务', '只提示勾选组件的官方故障', api,
            '与官方状态页「订阅更新 → 订阅特定组件」一一对应；「其它 API」是官方以后新增组件的兜底。'
            + '取消勾选即静音，全部取消就不再提示任何 API 故障。', false))
          children.push(card('web', '网页版服务', '默认关闭：DSH 走 API，与网页版无关', web,
            '对话服务、上传文件服务属于网页版（deepseek.com）。勾选后网页版故障也会进侧边栏。', false))
          if (state.error) children.push(React.createElement('p', { className: 'dshus-set-msg dshus-set-msg-error', key: 'save-error' }, state.error))
          if (saved && !state.error) children.push(React.createElement('p', { className: 'dshus-set-msg dshus-set-msg-ok', key: 'saved' }, '已保存'))
        }

        return React.createElement('div', { className: 'dshus-set' }, children)
      }

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'usage-stats' },
        (props) => React.createElement(UsageStats, props),
      ))

      // 设置页挂在 DSH 设置的最后（内置序：账号 -10 / 通用 0 / 模型 10 / 插件 15 / Agent 预设 20；桌宠 30）
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'usage-stats',
        order: 40,
        label: () => '用量统计',
      }, (props) => React.createElement(UsageStatsSettings, props)))

      // ---- 检测新版：账号行右侧的「有新版」徽章 ----
      // 只有服务端报告 hasUpdate 才注入。位置对齐桌面版自己的更新提示：桌面把
      // DesktopUpdateIndicator 放在设置行（`sidebar.settings` 的 triggerRow）里，紧挨账号按钮；
      // 这个插件把徽章放进同一行、靠右，两种版本一眼看到的地方是同一个。
      //
      // 桌面版整段不启动：DSH 桌面应用自己带「检查更新」菜单与更新弹窗，再亮一个「有新版」
      // 是重复打扰，所以桌面版不轮询 /update、也不注入徽章；web 版（浏览器打开）照旧。
      // 判据与 DSH 前端同源：桌面壳会在页面注入 dshDesktopBoot（见 dsh-web-frontend 的
      // src/main.ts，它拿这个全局判断要不要走桌面 boot），浏览器里的 web 页面没有它。
      const isDesktopApp = typeof window !== 'undefined' && window.dshDesktopBoot !== undefined
      const updateState = { hasUpdate: false, url: USAGE_URL }
      let badgeAnchor = null
      let updateTimer = null
      let badgeObserver = null
      let badgeRow = null

      // 账号行是 DSH 的设置触发行（slot 名是公开契约，比哈希类名稳）。
      // 收起成图标栏后这一行只有 36px 宽，放不下徽章：先撤掉，观察器留着，展开后补回来。
      const BADGE_ROW_SELECTOR = '[data-slot="sidebar.settings"] [class*="triggerRow"]'
      const BADGE_MIN_ROW_WIDTH = 120

      function removeBadgeAnchor() {
        if (badgeAnchor && badgeAnchor.parentNode) badgeAnchor.parentNode.removeChild(badgeAnchor)
        badgeAnchor = null
      }

      function clearBadge() {
        if (badgeObserver !== null) { badgeObserver.disconnect(); badgeObserver = null }
        removeBadgeAnchor()
      }

      function ensureBadge() {
        if (!updateState.hasUpdate) { clearBadge(); return }
        // observer 必须在**找到那一行之前**就装上：它的全部用途就是等账号行出现 / 被 React
        // 重建 / 侧栏在宽窄两态之间切换后把徽章补回来。原先只在注入成功后才安装，于是首轮
        // /update 比品牌行渲染更快时（host 缓存命中就是这种：1 小时内刷新页面）徽章会被丢掉，
        // 且没有任何东西会重试，要等下一轮轮询 —— 1 小时。
        // 侧栏收起只改行上的 class（宽度跟着变），所以 class 变化也要观察。
        const row = document.querySelector(BADGE_ROW_SELECTOR)
        badgeRow = row
        if (badgeObserver === null) {
          // 只把「节点增删」和「账号行自己的 class 变化」当信号：整页 class 变化（悬停、
          // 流式输出时的高亮）每秒都有，不加这层过滤等于每来一次就查一遍 DOM。
          badgeObserver = new MutationObserver((records = []) => {
            const relevant = records.some((record) => record.type === 'childList'
              || (badgeRow !== null && (badgeRow === record.target || badgeRow.contains(record.target))))
            if (relevant) ensureBadge()
          })
          badgeObserver.observe(document.body, {
            childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
          })
        }
        if (row === null || row.getBoundingClientRect().width < BADGE_MIN_ROW_WIDTH) {
          removeBadgeAnchor()
          return
        }
        if (badgeAnchor !== null && badgeAnchor.parentNode === row) return
        removeBadgeAnchor()
        badgeAnchor = document.createElement('a')
        badgeAnchor.className = UPDATE_BADGE_CLASS
        badgeAnchor.href = updateState.url
        badgeAnchor.target = '_blank'
        badgeAnchor.rel = 'noopener noreferrer'
        badgeAnchor.textContent = UPDATE_BADGE_TEXT
        row.appendChild(badgeAnchor)
      }

      function pollUpdate() {
        if (isDesktopApp) return // 桌面版由应用自己提示更新，这里不查也不画
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
