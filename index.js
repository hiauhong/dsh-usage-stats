/**
 * dsh-usage-stats — Host half.
 *
 * 数据通道：注册本地 HTTP 路由 `/api/usage-stats/query`，浏览器客户端同源
 * fetch（无 CORS 问题）。Host 负责：
 *   官方数据：platform userToken → 平台私有端点（余额 / 用量 / 费用）。
 *   官方不可用时返回明确状态，不估算用量或费用。
 */

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { readdirSync, readFileSync, statSync, chmodSync, realpathSync } from 'node:fs'

export const name = 'usage-stats'
export const inject = ['webServer']

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
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
const UPDATE_ROUTE = '/api/usage-stats/update'
const STATUS_ROUTE = '/api/usage-stats/status'
const CACHE_TTL_MS = 60000
// 服务状态（status.deepseek.com）：官方状态站是 FlashDuty 托管的 JS 页面，HTML 里
// 只有标题，Statuspage 式 /api/v2/* 返回 404 —— 能用的机器接口只有 RSS。
// 故障更新本来就是分钟级，5 分钟一轮足够，并做 in-flight 合并。
const STATUS_FEED_URL = 'https://status.deepseek.com/history.rss'
const STATUS_PAGE_URL = 'https://status.deepseek.com'
const STATUS_CHECK_TTL_MS = 5 * 60 * 1000
// 僵尸保护：RSS 卡住或某条一直没写 resolved 时，不要把陈年条目永远挂在界面上
const STATUS_MAX_AGE_MS = 12 * 60 * 60 * 1000
// 版本检测（Host 侧）：读取运行中 DSH 的版本（从其 package.json），定期拉取 npm
// 最新版，比较后决定是否在品牌行显示「有新版」。有新版才提示，无新版隐藏。
// 运行中 DSH 的安装根目录：realpath 解掉 bin/dsh 符号链接，避免 dirname(argv[1])/..
// 落到 nvm 根目录（无 package.json）。解不开则退回字面路径。
function resolveDshInstallRoot() {
  const literal = process.argv[1] || ''
  try {
    return join(dirname(realpathSync(literal)), '..')
  } catch {
    return join(dirname(literal), '..')
  }
}
const DSH_INSTALL_ROOT = resolveDshInstallRoot()
const DSH_PKG_JSON = join(DSH_INSTALL_ROOT, 'package.json')
const NPM_DIST_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh'
const RELEASES_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases'
const UPDATE_CHECK_TTL_MS = 3600 * 1000 // 1 小时 —— 版本变更极低频，避免频繁打 npm

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
// DeepSeek userToken 长度区间（实测 64/66 字符；放宽范围以防变化）。
// localStorage 值形如 {"value":"...","__version":"0"}，token 主体是 base64 运行。
const TOKEN_LEN_MIN = 55
const TOKEN_LEN_MAX = 85
const MAX_CANDIDATES = 40 // 候选上限：约束"无有效 token"时逐候选校验的成本

/** 从一段文本里提取一个 base64 token 候选（优先解析 JSON `{"value":"..."}`，兜底裸 base64）。 */
function tokenCandidateFrom (segment) {
  const jm = segment.match(/"value"\s*:\s*"([A-Za-z0-9+/=]{40,200})"/)
  if (jm) return jm[1]
  const rm = segment.match(/[A-Za-z0-9+/=]{40,200}/)
  return rm ? rm[0] : null
}

/** 在文本中查找 marker（userToken key / deepseek origin / "value":" JSON）邻近的候选。 */
function extractNearMarkers (text) {
  const out = []
  const seen = new Set()
  const add = (v) => { if (v && !seen.has(v)) { seen.add(v); out.push(v) } }
  for (const needle of ['userToken', 'platform.deepseek.com', '"value":"']) {
    let idx = 0
    while ((idx = text.indexOf(needle, idx)) !== -1) {
      const candidate = tokenCandidateFrom(text.slice(idx, idx + 400))
      if (candidate) add(candidate)
      idx += needle.length
    }
  }
  return out
}

function scanBrowserTokens () {
  // primary：含 platform.deepseek.com origin 的文件里的合理长度候选——最可靠，
  // 实测能命中有效 token 并天然排除其他网站/旧记录的 token。
  const primary = []
  const primarySeen = new Set()
  // fallback：marker 邻近候选（覆盖 key/value 跨 SSTable 且文件缺 origin 的场景）
  const fallback = []
  const fallbackSeen = new Set()
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
        const text = buf.toString('latin1')
        const hasOrigin = text.includes('platform.deepseek.com')
        // 独立 base64 运行：用 {40,200} 取完整运行（避免长二进制子串的假阳性），再按长度收敛。
        // 只在含 deepseek origin 的文件里收（排除其他网站/旧记录的 token 假阳性）。
        const re = /[A-Za-z0-9+/=]{40,200}/g
        let m
        while ((m = re.exec(text)) !== null) {
          const len = m[0].length
          if (len < TOKEN_LEN_MIN || len > TOKEN_LEN_MAX) continue
          if (hasOrigin && !primarySeen.has(m[0])) { primarySeen.add(m[0]); primary.push(m[0]) }
        }
        // marker 邻近候选兜底（key / origin / JSON）
        for (const v of extractNearMarkers(text)) {
          if (v && !primarySeen.has(v) && !fallbackSeen.has(v)) { fallbackSeen.add(v); fallback.push(v) }
        }
      }
    }
  }
  // primary 按长度接近 65 排序（实测 token 64/66），让最可能先被校验
  primary.sort((a, b) => Math.abs(a.length - 65) - Math.abs(b.length - 65))
  // 限制候选总量：正常情况有效 token 位于前段；同时约束"无有效 token"时的校验成本
  return [...primary, ...fallback].slice(0, MAX_CANDIDATES)
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
  exhaustedAt: null,   // 上次全量校验候选且无有效 token 的时间（避免每次查询重复校验）
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
    tokenState.exhaustedAt = null // 新候选集，重置"无有效 token"记忆
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
  // 已全量校验过且无有效 token：在下次扫描前不再重复校验，避免每次查询都校验全部候选
  if (forceRescan || tokenState.exhaustedAt === null || now - tokenState.exhaustedAt > BROWSER_SCAN_MS) {
    tokenState.exhaustedAt = now
    for (const candidate of tokenState.candidates) {
      if (await isValidToken(candidate)) {
        tokenState.browserValid = candidate
        tokenState.exhaustedAt = null
        return candidate
      }
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

/** 北京时间今日 00:00 的 epoch 秒。 */
function beijingTodayStartSec() {
  const shifted = new Date(Date.now() + BEIJING_OFFSET_MS)
  const startMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - BEIJING_OFFSET_MS
  return Math.floor(startMs / 1000)
}

/** 对 by_api_key/amount 的 biz_data 求和 tokens/requests（小时桶，实时准确）。 */
function sumByApiKeyAmount(biz) {
  let tokens = 0
  let requests = 0
  for (const s of biz.series || []) {
    for (const b of s.buckets || []) {
      const u = b.usage || {}
      tokens += (u.PROMPT_CACHE_HIT_TOKEN || 0) + (u.PROMPT_CACHE_MISS_TOKEN || 0) + (u.RESPONSE_TOKEN || 0)
      requests += (u.REQUEST || 0)
    }
  }
  return { tokens, requests }
}

/** 对 by_api_key/cost 的 biz_data 求和 cost（小时桶，实时准确）。 */
function sumByApiKeyCost(biz) {
  let cost = 0
  const data0 = (biz.data && biz.data[0]) || {}
  for (const s of data0.series || []) {
    for (const b of s.buckets || []) {
      const c = b.cost
      if (c !== undefined && c !== null && c !== '' && c !== 0) cost += Number(c) || 0
    }
  }
  return cost
}

function parseOfficialPayload(amountRes, costRes, summaryRes, byKeyAmount, byKeyCost) {
  const amountBiz = amountRes && amountRes.data && amountRes.data.biz_data
  const costBiz = costRes && costRes.data && costRes.data.biz_data
  for (const result of [amountRes, costRes, byKeyAmount, byKeyCost]) {
    if (result?.code !== 0 || !result?.data?.biz_data || isAuthError(result)) {
      throw new Error('official usage data unavailable')
    }
  }
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

  // 今日真实用量：by_api_key 按小时（实时准确）。按天接口今日滞后=0，故用 by_api_key 覆盖今日，
  // 本月仍用按天接口值（官方「本月」口径，今天按 0 滞后计，不重复叠加今日）。
  let liveTodayTokens = 0
  let liveTodayRequests = 0
  let liveTodayCost = 0
  const keyAmountBiz = byKeyAmount && byKeyAmount.data && byKeyAmount.data.biz_data
  if (keyAmountBiz) {
    const s = sumByApiKeyAmount(keyAmountBiz)
    liveTodayTokens = s.tokens
    liveTodayRequests = s.requests
  }
  const keyCostBiz = byKeyCost && byKeyCost.data && byKeyCost.data.biz_data
  if (keyCostBiz) liveTodayCost = sumByApiKeyCost(keyCostBiz)

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
    today: { tokens: liveTodayTokens, cost: liveTodayCost, requests: liveTodayRequests },
    // 本月用按天接口值（官方页「本月」口径，今天按 0 滞后计）。不要把今日再叠加进本月——会重复。
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
  // 今日窗口（北京时间 00:00 → 次日 00:00），by_api_key 按小时、实时
  const today0 = beijingTodayStartSec()
  const byKeyWindow = `?start=${today0}&end=${today0 + 86400}&tz=${BEIJING_OFFSET_MS / 1000}`

  const fetchBatch = (t) => {
    const signal = AbortSignal.timeout(15000)
    // P3：单请求失败不整体抛错——转成标记，避免 5xx 并发时掩盖同批的
    // 401/403 认证失败（__authError 仍需触发重扫）
    const wrap = (p) => p.catch((err) => ({ __httpError: String(err && err.message ? err.message : err) }))
    return Promise.all([
      wrap(fetchJson(`/api/v0/usage/amount${query}`, t, signal)),
      wrap(fetchJson(`/api/v0/usage/cost${query}`, t, signal)),
      wrap(fetchJson('/api/v0/users/get_user_summary', t, signal)),
      wrap(fetchJson(`/api/v0/usage/by_api_key/amount${byKeyWindow}`, t, signal)),
      wrap(fetchJson(`/api/v0/usage/by_api_key/cost${byKeyWindow}`, t, signal)),
    ])
  }

  let [amountRes, costRes, summaryRes, byKeyAmount, byKeyCost] = await fetchBatch(token)
  if ([amountRes, costRes, summaryRes, byKeyAmount, byKeyCost].some(isAuthError)) {
    // token 失效：全部失效 + 强制重扫（配置重读 + 浏览器重扫），用新 token 重试一次
    tokenState.manual = null
    tokenState.manualValid = false
    tokenState.browserValid = null
    tokenState.configCheckedAt = 0
    tokenState.scanCheckedAt = 0
    const retried = await resolveToken(true)
    if (retried === null) throw new Error('platform token invalid and no fresh candidate')
    ;[amountRes, costRes, summaryRes, byKeyAmount, byKeyCost] = await fetchBatch(retried)
  }
  return parseOfficialPayload(amountRes, costRes, summaryRes, byKeyAmount, byKeyCost)
}

// ---------------------------------------------------------------------------
// 版本检测（检测新版）
// ---------------------------------------------------------------------------

// 轻量 semver 比较（支持 -rc.N 预发布段，不引入外部依赖）：返回 a>b?1, a<b?-1, 相等 0。
// 纯 x.y.z 视为高于同版本 x.y.z-rcN 的预发布。
function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null || pb === null) return 0 // 无法解析则视为相等，避免误报
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1
  }
  // 主版本段相同：有预发布段 < 正式版；再按 prerelease 逐段比较
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  const len = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < len; i++) {
    const xa = pa.prerelease[i]
    const xb = pb.prerelease[i]
    if (xa === undefined) return -1
    if (xb === undefined) return 1
    const na = /^\d+$/.test(xa)
    const nb = /^\d+$/.test(xb)
    if (na && nb) {
      if (Number(xa) !== Number(xb)) return Number(xa) > Number(xb) ? 1 : -1
    } else if (na) {
      // 数字标识符 < 字母标识符
      return -1
    } else if (nb) {
      return 1
    } else {
      if (xa !== xb) return xa > xb ? 1 : -1
    }
  }
  return 0
}

function parseVersion(input) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(input).trim())
  if (m === null) return null
  const prerelease = m[4] ? m[4].split('.') : []
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease }
}

// 读取运行中 DSH 的安装版本（与其自身 --version 同源：bin.js 旁 package.json）。
function installedDshVersion() {
  try {
    const pkg = JSON.parse(readFileSync(DSH_PKG_JSON, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

// npm registry：@deepseek-ai/dsh 的 dist-tags.latest。（仅 GET，无副作用）
async function fetchLatestDshVersion() {
  const response = await fetch(NPM_DIST_URL, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`npm registry ${response.status}`)
  const json = await response.json()
  const latest = json && json['dist-tags'] && json['dist-tags'].latest
  return typeof latest === 'string' ? latest : null
}

// 版本检测缓存：TTL 1h，in-flight 合并，失败不毒化缓存（下次重试）。
let updateCache = null
let updateInFlight = null

async function updateSnapshot() {
  const now = Date.now()
  if (updateCache !== null && now - updateCache.at < UPDATE_CHECK_TTL_MS) return updateCache.data
  if (updateInFlight !== null) return updateInFlight.promise
  const promise = (async () => {
    try {
      const installed = installedDshVersion()
      const latest = await fetchLatestDshVersion()
      const data = {
        hasUpdate: installed !== null && latest !== null && compareVersions(latest, installed) > 0,
        installed,
        latest,
        url: RELEASES_URL,
      }
      updateCache = { at: Date.now(), data }
      return data
    } catch (err) {
      updateCache = null
      return { hasUpdate: false, installed: installedDshVersion(), latest: null, url: RELEASES_URL, error: String(err) }
    } finally {
      updateInFlight = null
    }
  })()
  updateInFlight = { promise }
  return promise
}

// ---------------------------------------------------------------------------
// DeepSeek 服务状态（status.deepseek.com）
// ---------------------------------------------------------------------------
// 每条 item 的 description 是转义过的 HTML，里面带
//   <strong>Status:</strong> resolved|investigating|...
//   <strong>Affected components:</strong> <组件列表>
// 所以「进行中」= 最新一条 item 的状态不是 resolved。
// 注意：RSS 是否收录「进行中」的条目，只能等一次真实故障再验证；若它其实只发
// 已恢复的历史，换源即可（下面的判定逻辑不用动）。
// 另：只有组件名带 "API" 的才算与 DSH 有关——搜索/上传/对话等服务异常不打扰用户。

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => (name.toLowerCase() in XML_ENTITIES ? XML_ENTITIES[name.toLowerCase()] : match))
}

function tagText(block, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
  if (m === null) return ''
  return decodeXml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim()
}

function isApiRelevantComponent(components) {
  return String(components).split(',').some((part) => /API/i.test(part))
}

// 「DeepSeek 网页/API 性能下降（DeepSeek Web/API Degraded Performance）」→「API 性能下降」
// 侧边栏只有 236px，完整官方标题放不下；完整标题进 tooltip。
function shortStatusLabel(title) {
  const short = String(title)
    .split(/[（(]/)[0]
    .trim()
    .replace(/^DeepSeek\s*/, '')
    .replace(/^网页\//, '')
    .trim()
  return short === '' ? '服务异常' : short
}

// 状态站没有单独的 severity 字段，从标题判断：中断/不可用 → 红，其余（性能下降等）→ 琥珀
function statusSeverity(title) {
  return /中断|不可用|unavailable|outage|down/i.test(String(title)) ? 'error' : 'warn'
}

function beijingHm(date) {
  const t = new Date(date.getTime() + BEIJING_OFFSET_MS)
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`
}

// feed 按时间倒序，取最新一条。没有可用条目时返回 null（调用方按「问不到」处理）。
function parseStatusFeed(xml) {
  const items = [...String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => m[1])
  if (items.length === 0) return null
  const block = items[0]
  const description = tagText(block, 'description')
  const statusMatch = /Status:\s*<\/strong>\s*([^<]*)/i.exec(description) ?? /Status:\s*([^\n<]*)/i.exec(description)
  const componentsMatch = /Affected components:\s*<\/strong>\s*([^<]*)/i.exec(description)
  const at = new Date(tagText(block, 'pubDate'))
  return {
    title: tagText(block, 'title'),
    link: tagText(block, 'link'),
    status: statusMatch === null ? '' : statusMatch[1].trim(),
    components: componentsMatch === null ? '' : componentsMatch[1].trim(),
    at: Number.isNaN(at.getTime()) ? null : at,
  }
}

// 判定「最新一条 item 算不算对用户有影响」——纯函数，便于对着真实 feed 校验。
// 三个条件缺一不可：进行中（未 resolved）、够新（防僵尸）、组件与 API 有关。
function evaluateStatusItem(item, now) {
  if (item === null) return idleStatus()
  const ongoing = item.status !== '' && !/^resolved$/i.test(item.status)
  const fresh = item.at !== null && now - item.at.getTime() < STATUS_MAX_AGE_MS
  if (!ongoing || !fresh || !isApiRelevantComponent(item.components)) return idleStatus()
  return {
    active: true,
    severity: statusSeverity(item.title),
    label: shortStatusLabel(item.title),
    title: item.title,
    components: item.components,
    since: item.at === null ? null : beijingHm(item.at),
    url: item.link === '' ? STATUS_PAGE_URL : item.link,
    updatedAt: now,
  }
}

// 状态快照：TTL 5 分钟 + in-flight 合并；失败不缓存（问不到 ≠ 出问题，下次轮询重试）。
let statusCache = null
let statusInFlight = null

function idleStatus() {
  return {
    active: false,
    severity: null,
    label: null,
    title: null,
    components: null,
    since: null,
    url: STATUS_PAGE_URL,
    updatedAt: Date.now(),
  }
}

async function statusSnapshot() {
  const now = Date.now()
  if (statusCache !== null && now - statusCache.at < STATUS_CHECK_TTL_MS) return statusCache.data
  if (statusInFlight !== null) return statusInFlight
  const promise = (async () => {
    try {
      const response = await fetch(STATUS_FEED_URL, {
        headers: { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8', 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`status feed ${response.status}`)
      const item = parseStatusFeed(await response.text())
      if (item === null) throw new Error('status feed: no items')
      const data = evaluateStatusItem(item, Date.now())
      statusCache = { at: Date.now(), data }
      return data
    } catch {
      statusCache = null
      return idleStatus()
    } finally {
      statusInFlight = null
    }
  })()
  statusInFlight = promise
  return promise
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export async function apply(ctx) {
  // 官方数据缓存 + in-flight 合并 + 配置变更失效。
  // balance 缺失（get_user_summary 偶发失败）时用短 TTL，快速重试而非毒化缓存。
  let officialCache = null
  let officialInFlight = null
  const BALANCE_WEAK_TTL_MS = 10_000

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
      && Date.now() - officialCache.at < (officialCache.weak ? BALANCE_WEAK_TTL_MS : CACHE_TTL_MS)) {
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
        if (data.balance === null) {
          // 余额接口偶发失败：不静默——记日志 + 短 TTL 快速重试
          ctx.logger.warn('usage-stats: balance unavailable (get_user_summary failed); will retry shortly')
        }
        officialCache = { at: Date.now(), data, generation: gen, weak: data.balance === null }
        return data
      } catch (err) {
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
          const payload = {
            source: 'official',
            status: 'unavailable',
            today: null,
            month: null,
            currency: null,
            balance: null,
            generatedAt: now,
          }
          const official = await officialSnapshot()
          if (official !== null) {
            // 保留接口原始货币与金额，不做硬编码汇率换算
            payload.status = 'ready'
            payload.today = { tokens: official.today.tokens, cost: official.today.cost, calls: official.today.requests }
            payload.month = { tokens: official.month.tokens, cost: official.month.cost, calls: official.month.requests }
            payload.currency = official.currency
            payload.balance = official.balance
          } else {
            payload.status = tokenState.manual === null && !tokenState.autoScan ? 'configuration_required' : 'unavailable'
            payload.officialError = payload.status === 'configuration_required'
              ? '请配置有效的 platformToken 以查看官方用量'
              : '官方数据暂不可用，请稍后重试'
            // P2-4：autoScan 开着却拿不到有效 token 时，明确提示（避免默默兜底让人困惑）
            if (tokenState.autoScan) {
              payload.scanHint = tokenState.candidates.length === 0
                ? 'autoScan 未在浏览器里找到 userToken，请登录 platform.deepseek.com 后重试，或手动配置 platformToken'
                : 'autoScan 找到的候选均无效（可能含过期/其他网站的 token），建议手动配置 platformToken'
            }
          }
          send(200, payload)
        } catch (err) {
          // 只回稳定错误码，细节留在 Host 日志
          ctx.logger.warn(`usage-stats: query route failed: ${String(err)}`)
          send(500, { ok: false, error: 'internal' })
        }
      },
    }), 'usage-stats: query route')

    // 版本检测路由：仅供本机页面读取「是否有新版」（非敏感，但同样回环+限流）。
    ctx.effect(() => server.register({
      kind: 'exact',
      path: UPDATE_ROUTE,
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
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
          const data = await updateSnapshot()
          send(200, { ok: true, ...data })
        } catch (err) {
          ctx.logger.warn(`usage-stats: update route failed: ${String(err)}`)
          send(500, { ok: false, error: 'internal' })
        }
      },
    }), 'usage-stats: update route')

    // 服务状态路由：同样回环 + 限流。抓取在 Host 做——status.deepseek.com 无 CORS
    // 头，浏览器端直接 fetch 拿不到；Host 侧结果 5 分钟缓存，客户端 5 分钟轮询。
    ctx.effect(() => server.register({
      kind: 'exact',
      path: STATUS_ROUTE,
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
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
          send(200, await statusSnapshot())
        } catch (err) {
          ctx.logger.warn(`usage-stats: status route failed: ${String(err)}`)
          send(500, { ok: false, error: 'internal' })
        }
      },
    }), 'usage-stats: status route')
  }
}

// 仅供本地校验解析逻辑（判据来自真实 feed 的真实形状）
export const __test = { parseStatusFeed, evaluateStatusItem, shortStatusLabel, statusSeverity, isApiRelevantComponent, decodeXml }
