/**
 * dsh-usage-stats — Host half.
 *
 * 数据通道：注册本地 HTTP 路由 `/api/usage-stats/query`，浏览器客户端同源
 * fetch（无 CORS 问题）。Host 负责：
 *   1. 本地统计：回放会话日志 + 挂 llm/stream 实时累加（DSH 自己的用量，token 与
 *      官方同源，费用按 DeepSeek 官方人民币价估算）
 *   2. 官方数据（可选）：platform userToken → 平台私有端点（余额 / 用量 / 费用），
 *      与 platform.deepseek.com/usage 页面一致（账号全量口径）
 * 官方不可用时自动回退本地统计。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdirSync, readFileSync, statSync, chmodSync } from 'node:fs'

export const name = 'usage-stats'
export const inject = ['sessionQuery', 'webServer']

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const NEW_PRICING_AT = Date.parse('2026-08-17T00:00:00+08:00')
const MAX_DAY_BUCKETS = 370
const OFFICIAL_PROVIDERS = new Set(['deepseek-official', 'session-title-first-prompt-llm'])

const PRICES = {
  'deepseek-v4-flash': { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
  'deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
}
const LEGACY_PRICES = {
  'deepseek-v4-flash': { cacheHit: 0.02, cacheMiss: 1, output: 2 },
  'deepseek-v4-pro': { cacheHit: 0.025, cacheMiss: 3, output: 6 },
}
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-v4-flash-0731': 'deepseek-v4-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
}

const TOKEN_FILE = join(homedir(), '.dsh', 'dsh-usage-stats.json')
const PLATFORM_BASE = 'https://platform.deepseek.com'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const OFFICIAL_HEADERS = {
  Accept: 'application/json',
  'x-app-version': '1.0.0',
  Origin: PLATFORM_BASE,
  Referer: `${PLATFORM_BASE}/usage`,
  'User-Agent': UA,
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}
const QUERY_ROUTE = '/api/usage-stats/query'
const CACHE_TTL_MS = 60000

function pad2(value) {
  return String(value).padStart(2, '0')
}

function beijingDayKey(time) {
  const d = new Date(time + BEIJING_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

function peakMultiplier(time) {
  if (time < NEW_PRICING_AT) return 1
  const h = new Date(time + BEIJING_OFFSET_MS).getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18) ? 2 : 1
}

function zeroRow() {
  return {
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costCny: 0,
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const resolveModel = (provider, model) => (OFFICIAL_PROVIDERS.has(provider) ? MODEL_ALIASES[model] : undefined)

// ---------------------------------------------------------------------------
// 本地统计：回放 + 实时
// ---------------------------------------------------------------------------

function applyUsage(days, provider, model, usage, time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return
  const alias = resolveModel(provider, model)
  if (alias === undefined || typeof usage !== 'object' || usage === null) return
  const b = {
    inputTokens: num(usage.inputTokens),
    cacheReadTokens: num(usage.cacheReadTokens),
    cacheWriteTokens: num(usage.cacheWriteTokens),
    outputTokens: num(usage.outputTokens),
  }
  const table = time < NEW_PRICING_AT ? LEGACY_PRICES : PRICES
  const price = table[alias]
  if (price === undefined) return
  const miss = b.inputTokens + b.cacheWriteTokens
  const cost = (miss * price.cacheMiss + b.cacheReadTokens * price.cacheHit + b.outputTokens * price.output) * peakMultiplier(time) / 1_000_000
  const key = beijingDayKey(time)
  const prev = days[key] || zeroRow()
  days[key] = {
    calls: prev.calls + 1,
    inputTokens: prev.inputTokens + b.inputTokens,
    cacheReadTokens: prev.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: prev.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: prev.outputTokens + b.outputTokens,
    costCny: prev.costCny + cost,
  }
  const keys = Object.keys(days)
  if (keys.length > MAX_DAY_BUCKETS) {
    keys.sort().slice(0, keys.length - MAX_DAY_BUCKETS).forEach((k) => { delete days[k] })
  }
}

function foldEvent(state, event) {
  // P3：损坏事件的时间戳不进入折叠（避免 NaN-NaN-NaN 日期桶污染统计）
  if (typeof event.time !== 'number' || !Number.isFinite(event.time)) return
  // 逐事件字段校验：异常事件只跳过自身，不影响整个会话折叠
  if (event.type === 'request/header') {
    const config = event.data && event.data.header && event.data.header.config
    if (typeof config !== 'object' || config === null) return
    state.route = { provider: config.provider, model: config.model }
    return
  }
  if (event.type === 'step/start') {
    const turn = Number(event.data && event.data.turn)
    const step = Number(event.data && event.data.step)
    if (!Number.isFinite(turn) || !Number.isFinite(step)) return
    state.open = {
      turn,
      step,
      time: event.time,
      provider: state.route.provider,
      model: state.route.model,
    }
    return
  }
  if (event.type === 'assistant/message') {
    const open = state.open
    const matches = open !== null && open.turn === event.data.turn && open.step === event.data.step
    const provider = matches ? open.provider : state.route.provider
    const model = matches ? open.model : state.route.model
    const time = matches ? open.time : event.time
    // 水印：请求开始时间晚于水印的事件由实时流负责，回放跳过（防双计）
    if (event.data.usage !== undefined && time < state.watermark) {
      applyUsage(state.days, provider, model, event.data.usage, time)
    }
    state.open = null
    return
  }
  if (event.type === 'step/end') {
    if (state.open !== null && state.open.turn === event.data.turn && state.open.step === event.data.step) state.open = null
    return
  }
  if (event.type === 'compaction/start') {
    // 记录 compaction 起始时间，summary 按起始时间归属（跨水印不遗漏）。
    // 官方文档中 compactionId 属于 CompactionResult，事件载荷可能带也可能不带；
    // 因此主路径先尝试用 compactionId 关联，兜底记录串行 pending 起始时间，
    // 任何 schema 下跨水印 compaction 都能正确归属。
    const id = event.data && event.data.compactionId
    if (id !== undefined && id !== null) {
      state.compactionStart = state.compactionStart || new Map()
      state.compactionStart.set(id, event.time)
    }
    state.pendingCompactionStart = event.time
    return
  }
  if (event.type === 'compaction/end') {
    // 清理已结束 compaction 的起始时间，防止 Map 无界增长
    const id = event.data && event.data.compactionId
    if (state.compactionStart && id !== undefined && id !== null) state.compactionStart.delete(id)
    state.pendingCompactionStart = undefined
    return
  }
  if (event.type === 'compaction/summary' && event.data.usage !== undefined) {
    // 归属时间优先级：compactionId 映射 → 串行 pending 起始时间 → summary 事件时间；
    // 与实时流按"调用开始时间"分区的口径一致，跨水印 compaction 不漏计。
    const mapped = state.compactionStart && state.compactionStart.get(event.data.compactionId)
    const startTime = mapped ?? state.pendingCompactionStart ?? event.time
    if (startTime < state.watermark) {
      applyUsage(state.days, event.data.provider, event.data.model, event.data.usage, startTime)
    }
  }
}

/** 折叠单个会话的水印前事件到 per 日桶（纯新增，调用方负责换新对象）。 */
async function foldSession(ctx, sessionId, watermark, per) {
  const snap = await ctx.sessionQuery.readSession(sessionId)
  const state = { route: { provider: '', model: '' }, open: null, days: per, watermark, compactionStart: new Map() }
  for (const event of snap.events) {
    try {
      foldEvent(state, event)
    } catch (err) {
      // 单条异常事件不拖垮整个会话
    }
  }
}

/** 把 source 日桶按日键累加进 target。 */
function mergeDays(target, source) {
  for (const [key, row] of Object.entries(source)) {
    const prev = target[key] || zeroRow()
    target[key] = {
      calls: prev.calls + row.calls,
      inputTokens: prev.inputTokens + row.inputTokens,
      cacheReadTokens: prev.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: prev.cacheWriteTokens + row.cacheWriteTokens,
      outputTokens: prev.outputTokens + row.outputTokens,
      costCny: prev.costCny + row.costCny,
    }
  }
}

function localPeriods(days, now) {
  const todayKey = beijingDayKey(now)
  const monthPrefix = todayKey.slice(0, 7)
  const toJson = (row) => ({
    tokens: row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens,
    cost: row.costCny,
    calls: row.calls,
  })
  let month = zeroRow()
  for (const key of Object.keys(days)) {
    if (key.startsWith(monthPrefix)) {
      const row = days[key]
      month = {
        calls: month.calls + row.calls,
        inputTokens: month.inputTokens + row.inputTokens,
        cacheReadTokens: month.cacheReadTokens + row.cacheReadTokens,
        cacheWriteTokens: month.cacheWriteTokens + row.cacheWriteTokens,
        outputTokens: month.outputTokens + row.outputTokens,
        costCny: month.costCny + row.costCny,
      }
    }
  }
  return { today: toJson(days[todayKey] || zeroRow()), month: toJson(month), todayKey }
}

// ---------------------------------------------------------------------------
// 官方端点（platform userToken → 私有 dashboard 接口）
// ---------------------------------------------------------------------------

function readConfigFile() {
  try {
    // P2：明文 token 文件必须 owner-only；权限过宽则自动收紧到 0600
    try {
      const st = statSync(TOKEN_FILE)
      if ((st.mode & 0o077) !== 0) chmodSync(TOKEN_FILE, 0o600)
    } catch (err) {
      return null
    }
    const text = readFileSync(TOKEN_FILE, 'utf8')
    if (!text) return null
    const j = JSON.parse(text)
    const raw = j && (j.platformToken !== undefined ? j.platformToken : (typeof j.value === 'string' ? j.value : null))
    let token = null
    if (typeof raw === 'string' && raw.trim()) token = raw.trim()
    else if (raw !== null && typeof raw === 'object' && typeof raw.value === 'string' && raw.value.trim()) token = raw.value.trim()
    return { token, autoScan: !!(j && j.autoScan === true) }
  } catch (err) {
    return null
  }
}

/**
 * 自动获取：扫描本机 Chromium 系浏览器（Chrome / Edge / Brave / Arc）各 Profile
 * 的 Local Storage LevelDB，提取 platform.deepseek.com 的 userToken 候选。
 * 启发式解析（不引入 LevelDB 依赖）：记录形如 `userToken<len>base64值`，
 * 直接用正则抓取值主体，交给 isValidToken 校验。
 */
const BROWSER_ROOTS = [
  join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
  join(homedir(), 'Library', 'Application Support', 'Microsoft Edge'),
  join(homedir(), 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
  join(homedir(), 'Library', 'Application Support', 'Arc'),
]
const BROWSER_SCAN_MAX_BYTES = 64 * 1024 * 1024 // 单文件上限 64MB

function scanBrowserTokens() {
  const found = []
  const seen = new Set()
  for (const root of BROWSER_ROOTS) {
    let profiles = []
    try {
      profiles = readdirSync(root)
    } catch (err) {
      continue
    }
    for (const profile of profiles) {
      if (profile === 'Local State') continue
      let files = []
      try {
        files = readdirSync(join(root, profile, 'Local Storage', 'leveldb'))
      } catch (err) {
        continue
      }
      for (const file of files) {
        if (!file.endsWith('.ldb') && !file.endsWith('.log')) continue
        const path = join(root, profile, 'Local Storage', 'leveldb', file)
        let buf
        try {
          const stat = readFileSync(path)
          if (stat.length > BROWSER_SCAN_MAX_BYTES) continue
          buf = stat
        } catch (err) {
          continue
        }
        // 注意：userToken 记录与 origin 前缀可能不在同一个 SSTable 文件，
        // 所以不做 platform.deepseek.com 预过滤，直接按键名找。
        const text = buf.toString('latin1')
        let idx = 0
        while ((idx = text.indexOf('userToken', idx)) !== -1) {
          const seg = text.slice(idx, idx + 320)
          const match = seg.match(/[A-Za-z0-9+/=]{40,200}/)
          if (match && !seen.has(match[0])) {
            seen.add(match[0])
            found.push(match[0])
          }
          idx += 9
        }
      }
    }
  }
  return found
}

function isAuthError(payload) {
  // P2-3：HTTP 401/403（fetchJson 标记的 __authError）与平台业务码 40002/40003
  if (payload && payload.__authError) return true
  const code = payload && payload.code
  const bizCode = payload && payload.data && payload.data.biz_code
  return code === 40002 || code === 40003 || bizCode === 40002 || bizCode === 40003
}

async function isValidToken(token) {
  try {
    const j = await fetchJson('/api/v0/users/get_user_summary', token, AbortSignal.timeout(8000))
    return !!(j && j.code === 0)
  } catch (err) {
    return false
  }
}

// token 解析状态：手动配置优先（有效则一直用，auth 失败才失效）。
// P1：浏览器自动扫描为显式 opt-in —— 需配置文件里 `"autoScan": true`，
// 默认关闭，避免把其他网站的 userToken 形式字符串发往 DeepSeek 验证。
// userToken 是长效会话（数周~数月），只在登录/登出/改密时变化：
// 配置文件用 stat 变更检测（每次查询前），浏览器扫描 6 小时一次 + 失效强制。
const BROWSER_SCAN_MS = 6 * 60 * 60 * 1000

const tokenState = {
  manual: null,        // 配置文件读到的 token（null = 无/已失效）
  manualValid: false,  // 配置 token 是否已验证有效
  autoScan: false,     // 是否启用浏览器自动扫描（opt-in）
  configCheckedAt: 0,  // 上次重读配置文件时间
  scanCheckedAt: 0,    // 上次扫描浏览器时间
  candidates: [],      // 浏览器扫描到的候选
  browserValid: null,  // 已验证有效的浏览器 token
  configGeneration: 0, // 配置每变化一次 +1，官方缓存据此失效
}

/** 配置文件的 inode+mtime+size 签名；每次官方查询前轻量检测。 */
let lastConfigSig = null
function configFileChanged() {
  let st = null
  try {
    st = statSync(TOKEN_FILE)
  } catch (err) {
    // 文件不存在也算一种状态
  }
  const sig = st === null ? 'missing' : `${st.ino}:${st.mtimeMs}:${st.size}`
  const changed = sig !== lastConfigSig
  lastConfigSig = sig
  return changed
}

/** 应用一次配置读取：token / autoScan 变化时重置对应状态并 bump 代数。 */
function applyConfig(cfg) {
  const newManual = cfg ? cfg.token : null
  if (newManual !== tokenState.manual) {
    tokenState.manual = newManual
    tokenState.manualValid = false
    tokenState.configGeneration += 1
  }
  const newAutoScan = cfg ? cfg.autoScan : false
  if (newAutoScan !== tokenState.autoScan) {
    tokenState.autoScan = newAutoScan
    tokenState.configGeneration += 1
    if (!newAutoScan) {
      // 撤销 opt-in 立即清空浏览器 token 与候选，不能继续使用
      tokenState.browserValid = null
      tokenState.candidates = []
    } else {
      tokenState.scanCheckedAt = 0 // 开启后立即扫描
    }
  }
}

async function resolveToken(forceRescan = false) {
  const now = Date.now()
  if (forceRescan || configFileChanged() || now - tokenState.configCheckedAt > 5 * 60 * 1000) {
    tokenState.configCheckedAt = now
    applyConfig(readConfigFile())
  }
  // 浏览器扫描：重量操作，低频（6h）+ 鉴权失败强制；仅 opt-in
  if (forceRescan || now - tokenState.scanCheckedAt > BROWSER_SCAN_MS) {
    tokenState.scanCheckedAt = now
    tokenState.candidates = tokenState.autoScan ? scanBrowserTokens() : []
    // P2：候选集刷新后必须淘汰旧 browserValid——用户切换账号后不再沿用旧 token
    tokenState.browserValid = null
  }
  // 1) 手动配置：已验证则直接复用（auth 失败才会被置失效）
  if (tokenState.manual !== null && tokenState.manualValid) return tokenState.manual
  if (tokenState.manual !== null) {
    if (await isValidToken(tokenState.manual)) {
      tokenState.manualValid = true
      return tokenState.manual
    }
    tokenState.manual = null
  }
  // 2) 浏览器自动获取：优先复用已验证的，否则逐候选校验
  if (tokenState.browserValid !== null) return tokenState.browserValid
  for (const candidate of tokenState.candidates) {
    if (await isValidToken(candidate)) {
      tokenState.browserValid = candidate
      return candidate
    }
  }
  return null
}

async function fetchJson(path, token, signal) {
  const response = await fetch(`${PLATFORM_BASE}${path}`, {
    headers: { ...OFFICIAL_HEADERS, Authorization: `Bearer ${token}` },
    signal,
  })
  if (!response.ok) {
    // P2-3：HTTP 401/403 也是 token 失效信号——交给 isAuthError 触发重扫，
    // 而不是直接抛错绕过鉴权重试逻辑；其他状态码仍按网络错误处理。
    if (response.status === 401 || response.status === 403) {
      return { __authError: true, __status: response.status }
    }
    throw new Error(`HTTP ${response.status}`)
  }
  return response.json()
}

function sumUsage(items) {
  let tokens = 0
  let requests = 0
  for (const item of items || []) {
    if (typeof item !== 'object' || item === null) continue
    const type = String(item.type || '').toUpperCase()
    const amount = Number(item.amount)
    if (!Number.isFinite(amount)) continue
    if (type === 'REQUEST') requests += amount
    else if (type === 'PROMPT_CACHE_HIT_TOKEN' || type === 'PROMPT_CACHE_MISS_TOKEN' || type === 'RESPONSE_TOKEN') tokens += amount
  }
  return { tokens, requests }
}

function sumModels(modelUsages) {
  let tokens = 0
  let requests = 0
  for (const mu of modelUsages || []) {
    const s = sumUsage(mu && mu.usage)
    tokens += s.tokens
    requests += s.requests
  }
  return { tokens, requests }
}

function parseOfficialPayload(amountRes, costRes, summaryRes) {
  const amountBiz = amountRes && amountRes.data && amountRes.data.biz_data
  const costBiz = costRes && costRes.data && costRes.data.biz_data
  if (!amountBiz) throw new Error('amount payload missing biz_data')
  const currency = (costBiz && costBiz[0] && costBiz[0].currency) || 'CNY'

  const dayMap = new Map()
  let monthTokens = 0
  let monthRequests = 0
  let monthCost = 0
  for (const day of amountBiz.days || []) {
    if (typeof day !== 'object' || day === null || !day.date) continue
    const s = sumModels(day.data)
    dayMap.set(day.date, s)
    monthTokens += s.tokens
    monthRequests += s.requests
  }
  const costDayMap = new Map()
  for (const day of (costBiz && costBiz[0] && costBiz[0].days) || []) {
    if (typeof day !== 'object' || day === null || !day.date) continue
    const s = sumModels(day.data)
    costDayMap.set(day.date, s)
    monthCost += s.tokens
  }
  const todayKey = beijingDayKey(Date.now())
  // 今日缺失时显示 0，绝不把返回数据的最后一天冒充"今日"
  const todayAmount = dayMap.get(todayKey) || { tokens: 0, requests: 0 }
  const todayCost = costDayMap.get(todayKey) || { tokens: 0, requests: 0 }

  let balance = null
  const biz = summaryRes && summaryRes.data && summaryRes.data.biz_data
  if (biz) {
    const wallets = [...(biz.normal_wallets || []), ...(biz.bonus_wallets || [])]
    if (wallets.length > 0) {
      const cny = wallets.filter((w) => w && w.currency === 'CNY')
      const pick = cny.length > 0 ? cny : wallets
      let amount = 0
      for (const w of pick) amount += Number(w.balance) || 0
      balance = { amount, currency: pick[0].currency }
    }
  }

  return {
    today: { tokens: todayAmount.tokens, cost: todayCost.tokens },
    month: { tokens: monthTokens, cost: monthCost, requests: monthRequests },
    currency,
    balance,
  }
}

async function fetchOfficial() {
  const token = await resolveToken()
  if (!token) return null
  // P1：月份按北京时间计算，避免每月 1 日 00:00–07:59（UTC 仍在上一月）查错月份
  const shifted = new Date(Date.now() + BEIJING_OFFSET_MS)
  const month = shifted.getUTCMonth() + 1
  const year = shifted.getUTCFullYear()
  const query = `?month=${month}&year=${year}`

  const fetchBatch = (t) => {
    const signal = AbortSignal.timeout(15000)
    // P3：单请求失败不整体抛错——转成标记，避免 5xx 并发时掩盖同批的
    // 401/403 认证失败（__authError 仍需触发重扫）
    const wrap = (p) => p.catch((err) => ({ __httpError: String(err && err.message ? err.message : err) }))
    return Promise.all([
      wrap(fetchJson(`/api/v0/usage/amount${query}`, t, signal)),
      wrap(fetchJson(`/api/v0/usage/cost${query}`, t, signal)),
      wrap(fetchJson('/api/v0/users/get_user_summary', t, signal)),
    ])
  }

  let [amountRes, costRes, summaryRes] = await fetchBatch(token)
  if (isAuthError(amountRes) || isAuthError(costRes) || isAuthError(summaryRes)) {
    // token 失效：全部失效 + 强制重扫（配置重读 + 浏览器重扫），用新 token 重试一次
    tokenState.manual = null
    tokenState.manualValid = false
    tokenState.browserValid = null
    tokenState.configCheckedAt = 0
    tokenState.scanCheckedAt = 0
    const retried = await resolveToken(true)
    if (retried === null) throw new Error('platform token invalid and no fresh candidate')
    ;[amountRes, costRes, summaryRes] = await fetchBatch(retried)
  }
  return parseOfficialPayload(amountRes, costRes, summaryRes)
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export async function apply(ctx) {
  // 水印：实时流负责 [watermark, ∞)，回放负责 [0, watermark)，两者不重叠
  const watermark = Date.now()
  const TAIL_FIRST_MS = 30_000 // 首次尾扫延迟（等多数 in-flight 落盘）
  const TAIL_SCAN_MS = 60_000 // 持续尾扫周期（覆盖长请求晚落盘）

  // ---- 实时流（立即接入，只统计水印后开始的请求） ----
  const daysLive = {}
  ctx.on('llm/stream', (options, next) => {
    const provider = options.provider
    const model = options.model
    const startedAt = Date.now()
    const stream = next()
    return (async function* () {
      for await (const chunk of stream) {
        if (chunk.type === 'usage' && startedAt >= watermark) applyUsage(daysLive, provider, model, chunk.usage, startedAt)
        yield chunk
      }
    })()
  })

  // ---- 回放（只折叠水印前事件）：串行链 + 持续尾扫 + 失败保留上次 ----
  let daysPre = {}
  let replayChain = Promise.resolve()
  // 尾扫只重折叠活跃会话，但 daysPre 必须由"全部会话的聚合"重建，
  // 否则会抹掉已结束会话的历史。故按 session 维护聚合，未重扫的会话保留原值。
  const sessionFolds = new Map() // sessionId -> 该会话水印前的日桶
  let pendingIds = new Set() // 待尾扫会话：初次活跃、可能仍产生水印前事件（含刚关闭）
  const runReplay = (liveOnly) => {
    replayChain = replayChain.then(async () => {
      try {
        const sessions = await ctx.sessionQuery.listSessions()
        const currentIds = new Set()
        const currentLive = new Set()
        for (const record of sessions) {
          currentIds.add(record.header.id)
          if (record.live === true) currentLive.add(record.header.id)
        }
        // 尾扫折叠集合 = pending（初次活跃、可能仍会产生水印前事件）∪ 当前活跃。
        // pending 保留到会话"被折叠过一次且已不再活跃"才移除，防止
        // "初次回放时请求在途 → 会话在下一次尾扫前关闭"的永久漏计。
        const toFold = liveOnly
          ? new Set([...pendingIds, ...currentLive])
          : currentIds
        for (const id of toFold) {
          const per = {}
          try {
            await foldSession(ctx, id, watermark, per)
            sessionFolds.set(id, per) // 成功才更新该会话
          } catch (err) {
            // 该会话保持上次成功值；不中断整体
            ctx.logger.warn(`usage-stats: skip session ${id}: ${String(err)}`)
          }
        }
        // 更新 pending：仍活跃的保留 + 新出现的活跃会话加入；
        // 刚关闭的会话本轮已被折叠（终态），从 pending 移除。
        if (liveOnly) {
          const next = new Set()
          for (const id of pendingIds) if (currentLive.has(id)) next.add(id)
          for (const id of currentLive) next.add(id)
          pendingIds = next
        } else {
          pendingIds = new Set(currentLive)
        }
        // GC：已删除的会话从聚合中移除
        for (const id of sessionFolds.keys()) {
          if (!currentIds.has(id)) sessionFolds.delete(id)
        }
        // 重建 daysPre = 全部会话聚合（含未重扫的已结束会话，历史不丢）
        const fresh = {}
        for (const per of sessionFolds.values()) mergeDays(fresh, per)
        daysPre = fresh
      } catch (err) {
        // 列表失败：保留上一次成功的 daysPre，不清空
        ctx.logger.warn(`usage-stats: replay failed: ${String(err)}`)
      }
    })
    return replayChain
  }
  runReplay(false) // 初次全量回放

  // 持续尾扫：定期重建 daysPre（替换而非累加，避免双计），覆盖
  // "水印前启动、落盘晚"的长请求；串行链保证结果有序。
  // 尾扫只重读活跃会话（新事件只发生在活跃会话），降低持续 I/O。
  let tailTimer = null
  let disposed = false
  const scheduleTail = (delay) => {
    tailTimer = setTimeout(() => {
      if (disposed) return
      runReplay(true).then(() => { if (!disposed) scheduleTail(TAIL_SCAN_MS) })
    }, delay)
  }
  scheduleTail(TAIL_FIRST_MS)
  ctx.effect(() => () => {
    // 阻止已触发的回调在卸载后再次调度
    disposed = true
    if (tailTimer !== null) clearTimeout(tailTimer)
  }, 'usage-stats: tail scan timer')

  // 合并视图：回放与实时按水印互斥，按日键相加即可
  const mergedDays = () => {
    const d = {}
    mergeDays(d, daysPre)
    mergeDays(d, daysLive)
    return d
  }

  // 官方数据缓存 + in-flight 合并 + 配置变更失效
  let officialCache = null
  let lastOfficialError = null
  let officialInFlight = null

  async function officialSnapshot() {
    // P1：每次查询前轻量检测配置文件变更（stat），变更立即应用配置、
    // 清空 token 状态、官方缓存与 in-flight——撤销 token / autoScan 即时生效。
    if (configFileChanged()) {
      tokenState.configCheckedAt = 0
      tokenState.scanCheckedAt = 0
      applyConfig(readConfigFile())
      officialCache = null
      officialInFlight = null // 旧 token 的在途请求不再复用（其结果按 gen 校验丢弃）
    }
    const gen = tokenState.configGeneration
    if (officialCache !== null
      && officialCache.generation === gen
      && Date.now() - officialCache.at < CACHE_TTL_MS) {
      return officialCache.data
    }
    // P1：in-flight 绑定 generation——配置已变则不复用旧 token 的请求
    if (officialInFlight !== null) {
      if (officialInFlight.gen === gen) return officialInFlight.promise
      officialInFlight = null
    }
    const promise = (async () => {
      try {
        const data = await fetchOfficial()
        // P1：完成时若配置代数已变，丢弃旧账号数据，不写缓存
        if (tokenState.configGeneration !== gen) return null
        if (data === null) return null
        officialCache = { at: Date.now(), data, generation: gen }
        lastOfficialError = null
        return data
      } catch (err) {
        lastOfficialError = String(err)
        officialCache = null
        return null
      } finally {
        if (officialInFlight !== null && officialInFlight.gen === gen) officialInFlight = null
      }
    })()
    officialInFlight = { gen, promise }
    return promise
  }

  // P1：仅允许回环地址访问本接口（余额/用量属于账户隐私）；
  // DSH 若配置 all-interfaces，同网段也无法读取。
  function isLoopback(addr) {
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }
  // 简单滑动窗口限流：每 IP 每分钟 60 次（正常客户端每 60s 轮询 1 次）
  const rateBuckets = new Map()
  function rateLimited(ip) {
    const now = Date.now()
    const hits = (rateBuckets.get(ip) || []).filter((t) => now - t < 60_000)
    if (hits.length >= 60) return true
    hits.push(now)
    rateBuckets.set(ip, hits)
    return false
  }

  const server = ctx.get('webServer') ?? ctx.get('httpServer')
  if (server !== undefined && typeof server.register === 'function') {
    ctx.effect(() => server.register({
      kind: 'exact',
      path: QUERY_ROUTE,
      handler: async (req, res) => {
        const send = (status, body) => {
          // P3：余额/用量属隐私数据，禁止浏览器 HTTP 缓存
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          })
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method !== 'GET') {
            send(405, { ok: false, error: 'method not allowed' })
            return
          }
          const remote = req.socket.remoteAddress || ''
          if (!isLoopback(remote) || rateLimited(remote)) {
            send(403, { ok: false, error: 'forbidden' })
            return
          }
          const now = Date.now()
          const local = localPeriods(mergedDays(), now)
          const payload = {
            source: 'local',
            today: local.today,
            month: local.month,
            todayKey: local.todayKey,
            currency: 'CNY',
            balance: null,
            generatedAt: now,
          }
          const official = await officialSnapshot()
          if (official !== null) {
            // 保留接口原始货币与金额，不做硬编码汇率换算
            payload.source = 'official'
            payload.today = { tokens: official.today.tokens, cost: official.today.cost, calls: 0 }
            payload.month = { tokens: official.month.tokens, cost: official.month.cost, calls: official.month.requests }
            payload.currency = official.currency
            payload.balance = official.balance
          } else {
            payload.officialError = '官方数据暂不可用'
          }
          send(200, payload)
        } catch (err) {
          // 只回稳定错误码，细节留在 Host 日志
          ctx.logger.warn(`usage-stats: query route failed: ${String(err)}`)
          send(500, { ok: false, error: 'internal' })
        }
      },
    }), 'usage-stats: query route')
  }
}
