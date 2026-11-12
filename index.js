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
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, chmodSync, realpathSync } from 'node:fs'

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
const ALERTS_ROUTE = '/api/usage-stats/alerts'
// 插件自己的设置（当前只有告警静音的组件），与 TOKEN_FILE 分开存：token 是密钥、用户会手改，
// 而设置由设置页写入 —— 混在一个文件里，写设置时失手就会把 token 抹掉。
const SETTINGS_FILE = join(homedir(), '.dsh', 'dsh-usage-stats.settings.json')
const CACHE_TTL_MS = 60000
// 服务状态（status.deepseek.com）：官方状态站是 FlashDuty 托管的 JS 页面，HTML 里
// 只有标题，Statuspage 式 /api/v2/* 返回 404 —— 能用的机器接口只有 RSS。
// 故障更新本来就是分钟级，5 分钟一轮足够，并做 in-flight 合并。
const STATUS_FEED_URL = 'https://status.deepseek.com/history.rss'
const STATUS_PAGE_URL = 'https://status.deepseek.com'
const STATUS_CHECK_TTL_MS = 5 * 60 * 1000
// 有告警时的缓存 TTL —— 它就是「官方已恢复、界面还挂着」的滞后上限：判定本身没问题
// （resolved → active:false），滞后是 host TTL 与客户端轮询叠加出来的。只在告警期提速：
// 事故更新本来就是分钟级，正常时仍 5 分钟一轮，不折腾 status.deepseek.com。
const STATUS_CHECK_TTL_ACTIVE_MS = 30 * 1000
// 僵尸保护：RSS 卡住或某条一直没写 resolved 时，不要把陈年条目永远挂在界面上
const STATUS_MAX_AGE_MS = 12 * 60 * 60 * 1000
// 版本检测（Host 侧）：读取运行中 DSH 的版本（从其 package.json），拉取官方「最新
// 可装版本」（npm registry 的 latest / next 两个发布 tag），比较后决定是否在品牌行显示
// 「有新版」。有新版才提示，无新版隐藏；只提示 release candidate 与正式版，**排除 alpha**
// （alpha 是内部构建、官方下一步往往自己就弃了，不该催用户升）。
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
// 只作徽章的跳转链接用 —— 版本检测本身只看 npm 的 dist-tags，不再请求 GitHub API。
const RELEASES_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases'
const UPDATE_CHECK_TTL_MS = 3600 * 1000 // 1 小时 —— 版本变更极低频，避免频繁打 npm

// ---------------------------------------------------------------------------
// 通用：TTL 缓存（三处快照共用一份实现）
// ---------------------------------------------------------------------------

/**
 * TTL 缓存 + in-flight 合并 + 失败不写缓存。
 *
 * 三处快照（官方数据、服务状态、版本检测）原本各手写了一份同样的骨架，差别只有三处：
 * TTL 怎么算、按什么分片、失败时给什么兜底。这个函数把三者都收成参数 ——
 * **兜底不硬合并**：三处的形状本来就不同（null / idleStatus() / 带 error 的对象），
 * 强行统一只会把差异藏进条件分支里。
 *
 * 失败不写缓存是刻意的：挂了就把上次的成功结果留在原处（它已经过期，下次自然会重抓），
 * 而不是让一个失败被缓存住、把界面钉在旧状态。
 *
 * @param fn - 取数据；抛错即走 onError（或不缓存地抛出）。
 * @param ttl - 有效期（毫秒），或 `(value) => ms`（按上一次的结果分档，如余额缺失 / 有告警时收紧）。
 * @param now - 时钟。测试注入假时钟才能量化「多久翻牌」。
 * @param onError - 失败时的兜底值；省略则把错误抛给调用方。
 * @returns `async (key = '') => value`，key 用于分片（官方数据按 token 分片）。
 */
function cached(fn, { ttl, now = Date.now, onError = null } = {}) {
  const ttlOf = typeof ttl === 'function' ? ttl : () => ttl
  const entries = new Map()
  let inFlight = null

  return async function call(key = '') {
    const at = now()
    const hit = entries.get(key)
    if (hit !== undefined && at - hit.at < ttlOf(hit.value)) return hit.value
    if (inFlight !== null && inFlight.key === key) return inFlight.promise
    const promise = (async () => {
      try {
        const value = await fn(key)
        entries.set(key, { at: now(), value })
        return value
      } catch (err) {
        if (onError === null) throw err
        return onError(err)
      } finally {
        if (inFlight !== null && inFlight.key === key) inFlight = null
      }
    })()
    inFlight = { key, promise }
    return promise
  }
}

// ---------------------------------------------------------------------------
// 官方端点（platform userToken → 私有 dashboard 接口）
// ---------------------------------------------------------------------------

/**
 * 读取配置文件。返回 `{ token }`；`token: null` 表示"配置里没有可用 token"
 * （含文件不存在）。返回 `null` 表示**读取/解析失败**——调用方保留上一次生效的配置，
 * 不因为一次 IO 抖动或半写入的 JSON 把已配置的 token 判死（那会误报"请配置 platformToken"）。
 */
function readConfigFile() {
  let text
  try {
    // 明文 token 文件必须 owner-only；权限过宽则自动收紧到 0600
    const st = statSync(TOKEN_FILE)
    if ((st.mode & 0o077) !== 0) chmodSync(TOKEN_FILE, 0o600)
    text = readFileSync(TOKEN_FILE, 'utf8')
  } catch (err) {
    // 文件被删掉 = 用户明确撤销配置；其他 IO 失败不清空
    if (err && err.code === 'ENOENT') return { token: null }
    return null
  }
  if (!text) return { token: null }
  try {
    const j = JSON.parse(text)
    // 只有一种格式：`{ "platformToken": "..." }`。早期为别的工具兼容留的 `j.value` /
    // `platformToken.value` 两种写法已删——它们从第一个提交起就在，README 从来只文档化
    // `platformToken`，没有「已发布格式」的包袱。
    const raw = j && j.platformToken
    const token = typeof raw === 'string' && raw.trim() ? raw.trim() : null
    return { token }
  } catch (err) {
    return null
  }
}

function isAuthError(payload) {
  // HTTP 401/403（fetchJson 标记的 __authError）与平台业务码 40002/40003
  if (payload && payload.__authError) return true
  const code = payload && payload.code
  const bizCode = payload && payload.data && payload.data.biz_code
  return code === 40002 || code === 40003 || bizCode === 40002 || bizCode === 40003
}

/** HTTP 401/403 只有**平台自己以 JSON 拒绝**时才算 token 失效；WAF 拦截页同样用
 *  403/429，但返回 text/html（"Request Blocked"）——那是"没问到"，不是"token 无效"。 */
function isAuthHttpResponse(response) {
  if (response.status !== 401 && response.status !== 403) return false
  return String(response.headers.get('content-type') || '').includes('json')
}

// 手动 token 被平台**明确拒绝**后的冷却：期间不发请求（背压），期满自动再试一次。
// 关键是只有"明确拒绝"才进冷却——超时 / 429 / WAF 拦页不算，不能把配置好的 token 判死。
const MANUAL_RETRY_MS = 10 * 60 * 1000

/**
 * token 解析器：手动配置优先，**不做前置探测**。
 *
 * 为什么不做前置探测：token 是否有效由真实数据请求判定（`fetchOfficial` 的 auth 分支）。
 * 前置探测会把 429 / 超时 / WAF 拦截页误当"token 无效"，丢掉配置好的有效 token，界面随之
 * 误报"请配置有效的 platformToken"——2026-09-19 修的就是这个。
 *
 * 每次 `resolve()` 都**直接读配置**：文件几十字节、一次查询一次，成本可忽略。所以
 * 「改文件即生效」不需要 stat 签名、也不需要 TTL 兜底重读——以前那套（inode+mtime+size
 * 签名 + 5 分钟 TTL + configGeneration）是为了省一次 readFileSync，省得不成比例。
 *
 * 工厂形态是为了给测试留缝：注入 `readConfig` 与 `now`，就能用假配置 + 假时钟把
 * 「不做前置探测 / 冷却窗口 / 换 token 立刻复位 / IO 抖动沿用上次 token / ENOENT 撤销」
 * 这几条边界钉住（见 `Scripts/test-token-resolver.mjs`）。这条路径此前没有任何自动化测试，
 * 而它是本仓历史上最严重误报的出处。
 *
 * @param readConfig - 读配置：`{ token }` / `{ token: null }`（明确无 token）/ `null`（读失败）。
 * @param now - 时钟。
 * @param retryMs - 被明确拒绝后的冷却时长。
 */
function createTokenResolver({
  readConfig = readConfigFile,
  now = Date.now,
  retryMs = MANUAL_RETRY_MS,
} = {}) {
  let manual = null          // 配置文件读到的 token（只由配置文件决定，不因请求结果丢弃）
  let lastRejectedAt = null  // 平台明确拒绝该 token 的时间（null = 没被拒过）

  return {
    /** 当前该用的 token；`null` = 没有可用 token 或正在冷却。 */
    resolve() {
      const cfg = readConfig()
      // 读不到配置（IO 抖动 / 半写入的 JSON）时保留上一次生效的配置
      if (cfg !== null && cfg.token !== manual) {
        manual = cfg.token
        lastRejectedAt = null // 换了 token，重新给一次机会
      }
      const at = now()
      const cooling = lastRejectedAt !== null && at - lastRejectedAt < retryMs
      if (manual !== null && !cooling) {
        lastRejectedAt = null
        return manual
      }
      return null
    },
    /** 平台**明确拒绝**当前 token 时记账；瞬时失败不要调（那会把有效 token 判死）。 */
    noteRejected() { lastRejectedAt = now() },
    hasToken: () => manual !== null,
    isRejected: () => lastRejectedAt !== null,
  }
}

const tokenResolver = createTokenResolver()

async function fetchJson(path, token, signal) {
  const response = await fetch(`${PLATFORM_BASE}${path}`, {
    headers: { ...OFFICIAL_HEADERS, Authorization: `Bearer ${token}` },
    signal,
  })
  if (!response.ok) {
    // 平台以 JSON 体的 401/403 拒绝 = token 失效，标成 __authError 让 isAuthError 认出来
    // （而不是直接抛错绕过鉴权判定）。注意 WAF 拦截页也用 403/429 但返回 text/html，
    // 那是"没问到"，不能当成 token 失效（否则界面会误报"请配置有效的 platformToken"）。
    if (isAuthHttpResponse(response)) {
      return { __authError: true, __status: response.status }
    }
    throw new Error(`HTTP ${response.status}`)
  }
  return response.json()
}

function sumUsage(items) {
  let tokens = 0
  for (const item of items || []) {
    if (typeof item !== 'object' || item === null) continue
    const type = String(item.type || '').toUpperCase()
    const amount = Number(item.amount)
    if (!Number.isFinite(amount)) continue
    if (type === 'PROMPT_CACHE_HIT_TOKEN' || type === 'PROMPT_CACHE_MISS_TOKEN' || type === 'RESPONSE_TOKEN') tokens += amount
  }
  return tokens
}

function sumModels(modelUsages) {
  let tokens = 0
  for (const mu of modelUsages || []) tokens += sumUsage(mu && mu.usage)
  return tokens
}

/** 北京时间今日 00:00 的 epoch 秒。 */
function beijingTodayStartSec() {
  const shifted = new Date(Date.now() + BEIJING_OFFSET_MS)
  const startMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - BEIJING_OFFSET_MS
  return Math.floor(startMs / 1000)
}

/** 对 by_api_key/amount 的 biz_data 求和 tokens（小时桶，实时准确）。 */
function sumByApiKeyAmount(biz) {
  let tokens = 0
  for (const s of biz.series || []) {
    for (const b of s.buckets || []) {
      const u = b.usage || {}
      tokens += (u.PROMPT_CACHE_HIT_TOKEN || 0) + (u.PROMPT_CACHE_MISS_TOKEN || 0) + (u.RESPONSE_TOKEN || 0)
    }
  }
  return tokens
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

  // 本月：用官方按天接口的「本月」口径（今天按 0 滞后计，所以下面用 by_api_key 覆盖今日、不叠加进本月）
  let monthTokens = 0
  for (const day of amountBiz.days || []) {
    if (typeof day !== 'object' || day === null || !day.date) continue
    monthTokens += sumModels(day.data)
  }
  let monthCost = 0
  for (const day of (costBiz && costBiz[0] && costBiz[0].days) || []) {
    if (typeof day !== 'object' || day === null || !day.date) continue
    monthCost += sumModels(day.data)
  }

  // 今日真实用量：by_api_key 按小时（实时准确），覆盖按天接口的今日值
  let liveTodayTokens = 0
  let liveTodayCost = 0
  const keyAmountBiz = byKeyAmount && byKeyAmount.data && byKeyAmount.data.biz_data
  if (keyAmountBiz) liveTodayTokens = sumByApiKeyAmount(keyAmountBiz)
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
    today: { tokens: liveTodayTokens, cost: liveTodayCost },
    month: { tokens: monthTokens, cost: monthCost },
    currency,
    balance,
  }
}

/**
 * 拉一次官方用量。token 由调用方（`officialSnapshot`）从解析器取好传进来——
 * 这样缓存与 in-flight 都能以同一个 token 为 key，不必再靠 configGeneration 失效。
 */
async function fetchOfficial(token) {
  // 月份按北京时间计算，避免每月 1 日 00:00–07:59（UTC 仍在上一月）查错月份
  const shifted = new Date(Date.now() + BEIJING_OFFSET_MS)
  const month = shifted.getUTCMonth() + 1
  const year = shifted.getUTCFullYear()
  const query = `?month=${month}&year=${year}`
  // 今日窗口（北京时间 00:00 → 次日 00:00），by_api_key 按小时、实时
  const today0 = beijingTodayStartSec()
  const byKeyWindow = `?start=${today0}&end=${today0 + 86400}&tz=${BEIJING_OFFSET_MS / 1000}`

  const fetchBatch = (t) => {
    const signal = AbortSignal.timeout(15000)
    // 单请求失败不整体抛错——转成标记，避免 5xx 并发时掩盖同批的
    // 401/403 认证失败（__authError 要能被 isAuthError 认出来：它决定界面说
    // 「已被平台拒绝」还是「暂不可用」，两者不能混）
    const wrap = (p) => p.catch((err) => ({ __httpError: String(err && err.message ? err.message : err) }))
    return Promise.all([
      wrap(fetchJson(`/api/v0/usage/amount${query}`, t, signal)),
      wrap(fetchJson(`/api/v0/usage/cost${query}`, t, signal)),
      wrap(fetchJson('/api/v0/users/get_user_summary', t, signal)),
      wrap(fetchJson(`/api/v0/usage/by_api_key/amount${byKeyWindow}`, t, signal)),
      wrap(fetchJson(`/api/v0/usage/by_api_key/cost${byKeyWindow}`, t, signal)),
    ])
  }

  const [amountRes, costRes, summaryRes, byKeyAmount, byKeyCost] = await fetchBatch(token)
  // token 被平台**明确拒绝**：记下拒绝时间（**不丢掉配置里的 token**），此后冷却期内不再发请求。
  // 只有"明确拒绝"才记账——超时 / 429 / WAF 拦页走的是 unknown，绝不能把有效 token 判死。
  // 记账与判定必须都在：只 throw 不记账的话，界面就分不清「已被平台拒绝」和「暂时拿不到数据」。
  if ([amountRes, costRes, summaryRes, byKeyAmount, byKeyCost].some(isAuthError)) tokenResolver.noteRejected()
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

// npm registry 的发布 tag（仅 GET，无副作用）：`next` 是预发布通道的指针，rc 版本
// 常常先挂在这里，而 `latest` 要等它转正才动。两个 tag 都要看 —— 只看 `latest` 会让
// 跑 rc 的用户永远检测不到新版（2026-09-23 就是这个漏报）。
async function fetchNpmDistTags() {
  const response = await fetch(NPM_DIST_URL, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`npm registry ${response.status}`)
  const json = await response.json()
  const tags = json && json['dist-tags']
  if (tags === null || typeof tags !== 'object') return {}
  return tags
}

// alpha 是内部构建，不催用户升（见文件头版本检测注释）。
function isAlphaVersion(version) {
  const parsed = parseVersion(version)
  return parsed !== null && parsed.prerelease.includes('alpha')
}

// 「最新可装版本」= npm 的 `latest` 与 `next` 里较高的那个（排除 alpha）。
//
// 为什么只看 npm：npm 的版本集合是 GitHub Releases 的**超集** —— 实测 2026-09-26
// 有 27 个版本，其中 `0.1.5-rc.3` 只在 npm 上（GitHub Releases 没有），而排除 alpha 后
// 两边最高版一致。所以看不出 GitHub 能多给什么，少一个源就少一份限流/抖动的可能。
//
// rc 的版本号本身带 `-rc.N`，compareVersions 已经把预发布段算进去（正式版 > 同号 rc，
// rc.2 > rc.1），所以不用区分通道，只取最大值。npm 挂了就抛错 → 不缓存、下次重试；
// 「没有可提示的版本」（全 alpha / 空）返回 null —— 那不是错误。
async function fetchLatestDshVersion({ npmDistTags = fetchNpmDistTags } = {}) {
  const tags = await npmDistTags()
  let best = null
  for (const value of [tags.latest, tags.next]) {
    if (typeof value !== 'string' || parseVersion(value) === null) continue
    if (isAlphaVersion(value)) continue // alpha 是内部构建，不催用户升（用户口径）
    if (best === null || compareVersions(value, best) > 0) best = value
  }
  return best
}

/** 「有新版」快照的组装（纯函数，便于直接断言口径）。 */
function updateInfo(current, latest) {
  return {
    hasUpdate: current !== null && latest !== null && compareVersions(latest, current) > 0,
    installed: current,
    latest,
    url: RELEASES_URL,
  }
}

// 版本检测快照：1 小时缓存（版本变更极低频）。失败给带 error 的对象 —— **形状与另外两处
// 不同**（那两处是 null / idleStatus()），所以兜底留给这里，缓存机制在 cached() 里。
// 工厂形态只为给测试留缝（假 fetchLatest + 假时钟）。
function createUpdateSnapshot({ fetchLatest = fetchLatestDshVersion, installed = installedDshVersion, now = Date.now } = {}) {
  return cached(async () => updateInfo(installed(), await fetchLatest()), {
    ttl: UPDATE_CHECK_TTL_MS,
    now,
    onError: (err) => ({ hasUpdate: false, installed: installed(), latest: null, url: RELEASES_URL, error: String(err) }),
  })
}

const updateSnapshot = createUpdateSnapshot()

// ---------------------------------------------------------------------------
// DeepSeek 服务状态（status.deepseek.com）
// ---------------------------------------------------------------------------
// 每条 item 的 description 是转义过的 HTML，里面带
//   <strong>Status:</strong> resolved|investigating|...
//   <strong>Affected components:</strong> <组件列表>
// 所以「进行中」= 最新一条 item 的状态不是 resolved。
// RSS 确实收录「进行中」的条目 —— 2026-09-23 的真实故障验证过（15:35 的性能下降被
// 正常捕获）；若官方哪天改成只发已恢复的历史，换源即可（下面的判定逻辑不用动）。
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

// 一条 <item> → 结构。description 是转义过的 HTML，里面带
//   <strong>Status:</strong> resolved|investigating|...
//   <strong>Affected components:</strong> <组件列表>
function parseStatusItem(block) {
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

// feed 按时间倒序。**全部**条目都要留着：只看第一条时，一条更新的非 API 故障
// （如「搜索服务异常」）会把仍进行中的 API 故障挤出视野，于是该报的不报。
function parseStatusFeedItems(xml) {
  return [...String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => parseStatusItem(m[1]))
}

// 最新一条；没有条目时返回 null（调用方按「问不到」处理）。
function parseStatusFeed(xml) {
  return parseStatusFeedItems(xml)[0] ?? null
}

// ---------------------------------------------------------------------------
// 告警组件（对齐官方「订阅更新 → 订阅特定组件」）
// ---------------------------------------------------------------------------

// 官方状态页的可订阅组件（2026-10-27 实测）：
//   DeepSeek V4 Pro API服务 / DeepSeek V4.1 Flash API服务 / 搜索API服务 / 抓取API服务 /
//   对话服务（展开是 对话服务(Chatservice) + 上传文件服务(File Upload Service)）
// RSS 里「受影响组件」的写法与状态页略有出入（如「搜索服务(Search Service)」没带 API），
// 所以按关键词认，不按全名匹配。键**刻意不含版本号**：V4 → V4.1 只是版本变迁，静音不该失效。
//
// group 只用于设置页分组：api = 模型/检索接口，web = 网页版（对话、上传文件）。
// 默认只提示 api 组（见 DEFAULT_MUTED）——DSH 用户走 API，网页版故障与自己无关。
const COMPONENT_RULES = [
  { key: 'pro', group: 'api', test: /pro/i, label: 'Pro' },
  { key: 'flash', group: 'api', test: /flash/i, label: 'Flash' },
  { key: 'search', group: 'api', test: /search|搜索/i, label: '搜索 API' },
  { key: 'fetch', group: 'api', test: /fetch|抓取/i, label: '抓取 API' },
  { key: 'upload', group: 'web', test: /upload|上传/i, label: '上传文件服务' },
  { key: 'chat', group: 'web', test: /chat|对话/i, label: '对话服务' },
]
// `other` = 认不出的组件兜底：官方以后加新组件时不至于漏提示，也还能一键静音
const OTHER_KEY = 'other'
const COMPONENT_KEYS = [...COMPONENT_RULES.map((rule) => rule.key), OTHER_KEY]
// 没配置过时默认静音网页版：DSH 走 API，对话/上传的故障不该打扰
const DEFAULT_MUTED = ['chat', 'upload']

/** 单个组件串 → 组件键（认不出的归 other）。 */
function componentKeyOf(part) {
  const hit = COMPONENT_RULES.find((rule) => rule.test.test(part))
  return hit === undefined ? OTHER_KEY : hit.key
}

/** 组件键的分组（设置页分卡片用）。 */
function componentGroupOf(key) {
  const hit = COMPONENT_RULES.find((rule) => rule.key === key)
  return hit === undefined ? 'api' : hit.group
}

/** 一条告警影响的组件键集合；空数组 = 官方没写受影响组件，按「说不清就不打扰」跳过。 */
function componentKeys(components) {
  const keys = new Set()
  for (const part of String(components).split(',')) {
    if (part.trim() === '') continue
    keys.add(componentKeyOf(part))
  }
  return [...keys]
}

/** 组件标签：Pro/Flash 用官方组件名（带版本号，好认），其余用固定中文名。 */
function componentLabelOf(key, components) {
  if (key !== 'pro' && key !== 'flash') {
    const hit = COMPONENT_RULES.find((rule) => rule.key === key)
    return hit === undefined ? '其它 API' : hit.label
  }
  for (const part of String(components || '').split(',')) {
    if (componentKeyOf(part) !== key) continue
    const name = part
      .split('(')[0]
      .trim()
      .replace(/^DeepSeek\s*/i, '')
      .replace(/\s*API服务\s*$|\s*API\s*Service\s*$/i, '')
      .trim()
    if (name !== '') return name
  }
  return key === 'pro' ? 'Pro' : 'Flash'
}

/** 设置页的组件清单：官方可订阅组件 + 其它 API，标签优先取 feed 里的真实组件名。 */
function alertsOptions(items) {
  const seen = new Map()
  for (const item of items || []) {
    for (const part of String(item.components || '').split(',')) {
      if (part.trim() === '') continue
      const key = componentKeyOf(part)
      if (!seen.has(key)) seen.set(key, part)
    }
  }
  // 顺序与官方订阅框一致：模型 → 检索接口 → 兜底 → 网页版
  const order = ['pro', 'flash', 'search', 'fetch', OTHER_KEY, 'chat', 'upload']
  return order.map((key) => ({
    key,
    group: componentGroupOf(key),
    label: componentLabelOf(key, seen.get(key)),
    // 官方组件原文：设置页当副标题，说明这一项具体指什么（没见过就留空）
    component: seen.get(key) ?? null,
  }))
}

// ---------------------------------------------------------------------------
// 告警设置（~/.dsh/dsh-usage-stats.settings.json）
// ---------------------------------------------------------------------------

/** 只保留已知组件键（手改出错 / 旧版本遗留的未知值一律丢弃）。 */
function normalizeMuted(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const key = entry.trim().toLowerCase()
    if (COMPONENT_KEYS.includes(key) && !out.includes(key)) out.push(key)
  }
  return out
}

/**
 * 读设置。三种情形刻意区分：
 *   文件不存在 → 默认值（网页版静音，只提示 API）
 *   文件损坏 / 半写入 → **全都提示**（坏配置不该悄悄吞掉告警 —— 少报故障比多报更坏）
 *   正常 → 文件内容（未知键由 normalizeMuted 丢掉）
 */
function readAlertsSettings(file = SETTINGS_FILE) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return { muted: err && err.code === 'ENOENT' ? [...DEFAULT_MUTED] : [] }
  }
  try {
    const json = JSON.parse(text)
    return { muted: normalizeMuted(json && json.alerts && json.alerts.muted) }
  } catch {
    return { muted: [] }
  }
}

/** 原子写设置（同目录临时文件 + rename）：半写入的 JSON 会让下次读回默认值。 */
function writeAlertsSettings(muted, file = SETTINGS_FILE) {
  const normalized = normalizeMuted(muted)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ alerts: { muted: normalized } }, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  return { muted: normalized }
}

/** 缓存分片键：静音的组件不同 = 不同的一份状态快照。 */
function mutedKeyOf(muted) {
  return normalizeMuted(muted).slice().sort().join(',')
}

// idle 快照：没有影响（或问不到）时的形状。active:false 就是客户端撤掉告警的信号。
function idleStatus() {
  return {
    active: false,
    severity: null,
    label: null,
    title: null,
    components: null,
    componentKeys: [],
    since: null,
    url: STATUS_PAGE_URL,
    updatedAt: Date.now(),
  }
}

// 判定「这批条目里有没有一条该打扰用户」——纯函数，便于对着真实 feed 校验。
// 四个条件缺一不可：进行中（未 resolved）、够新（防僵尸）、有受影响组件、至少一个组件没被静音。
// 从新到旧找第一条成立的：更新的无关故障不会盖住仍进行中的故障。
function evaluateStatusItems(items, now, muted = []) {
  const mutedSet = new Set(normalizeMuted(muted))
  for (const item of items || []) {
    if (item === null || item === undefined) continue
    const ongoing = item.status !== '' && !/^resolved$/i.test(item.status)
    const fresh = item.at !== null && now - item.at.getTime() < STATUS_MAX_AGE_MS
    if (!ongoing || !fresh) continue
    const keys = componentKeys(item.components)
    if (keys.length === 0) continue
    // 条目影响的所有组件都被静音才不报；还有一项亮着就报
    if (keys.every((key) => mutedSet.has(key))) continue
    return {
      active: true,
      severity: statusSeverity(item.title),
      label: shortStatusLabel(item.title),
      title: item.title,
      components: item.components,
      componentKeys: keys,
      since: item.at === null ? null : beijingHm(item.at),
      url: item.link === '' ? STATUS_PAGE_URL : item.link,
      updatedAt: now,
    }
  }
  return idleStatus()
}

// 单条判定的入口（既有测试与调用仍用它）：等价于「只看这一条」。
function evaluateStatusItem(item, now, muted = []) {
  return evaluateStatusItems(item === null ? [] : [item], now, muted)
}

// 状态快照：TTL 取决于上一份快照是不是「有告警」——有告警时盯恢复要快（30s），无告警时
// 保持 5 分钟一轮。缓存机制（TTL + in-flight + 失败不缓存）在 cached() 里。
/** 服务状态的 TTL 分档：有告警时收紧（恢复要尽快翻牌），无告警时 5 分钟内不折腾 status 站。 */
const statusTtlOf = (data) => (data.active === true ? STATUS_CHECK_TTL_ACTIVE_MS : STATUS_CHECK_TTL_MS)

/** 拉一次 feed 并判定；`mutedKey` 是静音组件的缓存键（见 mutedKeyOf）。 */
async function fetchStatusSnapshot(mutedKey = '') {
  const response = await fetch(STATUS_FEED_URL, {
    headers: { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8', 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`status feed ${response.status}`)
  const items = parseStatusFeedItems(await response.text())
  if (items.length === 0) throw new Error('status feed: no items')
  return {
    ...evaluateStatusItems(items, Date.now(), mutedKey === '' ? [] : mutedKey.split(',')),
    // 设置页要的组件清单（标签来自 feed 里的真实组件名）：顺手带上，省掉第二次抓 feed
    available: alertsOptions(items),
  }
}

// 服务状态快照。抓不到就按「问不到 ≠ 出问题」返回空闲 —— 兜底形状与另外两处不同。
// 工厂形态只为给测试留缝（假 fetchSnapshot + 假时钟量化恢复滞后），缓存机制在 cached() 里。
function createStatusSnapshot({ fetchSnapshot = fetchStatusSnapshot, now = Date.now } = {}) {
  return cached(fetchSnapshot, { ttl: statusTtlOf, now, onError: () => idleStatus() })
}

const statusSnapshot = createStatusSnapshot()

/** 请求体不合法（太大 / 不是 JSON）：路由层据此回 400 而不是 500。 */
class BadRequest extends Error {}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export async function apply(ctx) {
  // 余额接口偶发失败时用短 TTL 快速重试，别让缺失的余额撑满一个常规周期
  const BALANCE_WEAK_TTL_MS = 10_000

  // 官方数据：按 token 分片（token 一换缓存自然失效），余额缺失时用短 TTL 快速重试。
  // 失败兜底是 null（形状与状态/版本两处不同），缓存机制在 cached() 里。
  const officialCached = cached(
    async (token) => {
      const data = await fetchOfficial(token)
      if (data.balance === null) {
        // 余额接口偶发失败：不静默——记日志 + 短 TTL 快速重试
        ctx.logger.warn('usage-stats: balance unavailable (get_user_summary failed); will retry shortly')
      }
      return data
    },
    {
      ttl: (data) => (data.balance === null ? BALANCE_WEAK_TTL_MS : CACHE_TTL_MS),
      onError: () => null,
    },
  )

  async function officialSnapshot() {
    // 解析器每次调用都重读配置；冷却期内它返回 null → 这里不发任何请求（背压）
    const token = tokenResolver.resolve()
    if (token === null) return null
    return officialCached(token)
  }

  // 仅允许回环地址访问（余额/用量属账户隐私）；DSH 若配置 all-interfaces，同网段也读不到。
  //
  // 这里**刻意不做限流**：三个路由的请求全部来自本机回环，唯一有效的门就是回环检查本身。
  // 而所有页面共用一个 60 次/分钟的桶时，批量打开 / 重载 / 会话恢复十几页就会顶破它，
  // 表现为用量卡片莫名「暂不可用」（开发时反复刷新正是这个模式）。删掉它，突发不再误伤。
  function isLoopback(addr) {
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  /** 请求体不合法（太大 / 不是 JSON）——路由层要把它和「内部错误」分开回 400。 */
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      // 上限 4KB：只用来收一个组件数组，别让本机请求把进程内存拖住
      const LIMIT = 4096
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > LIMIT) {
          reject(new BadRequest('body too large'))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.trim() === '') return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new BadRequest('invalid json'))
        }
      })
      req.on('error', reject)
    })
  }

  /**
   * 注册一个本地路由（默认只读 GET）。
   *
   * 所有路由的四道检查完全一样——405 / 回环 / `Cache-Control: no-store` / 异常走 500——
   * 只有「正常返回什么」不同。抽出来之后每个路由只剩「取数据」那一句（原先几份复制粘贴的
   * handler 共 120 行）。日志里保留各自的路由名，出错时还认得出是谁。
   *
   * @param name - 路由名（日志与 effect 标签用）。
   * @param path - 精确路径。
   * @param getBody - 取返回体，收到 `{ method, body }`；抛错即 500（细节留在 Host 日志，不回给浏览器）。
   * @param methods - 允许的 HTTP 方法，默认只放 GET。
   * @param json - 是否先把请求体读成 JSON（POST/PUT 用）。
   */
  function route(name, path, getBody, { methods = ['GET'], json = false } = {}) {
    return ctx.effect(() => server.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const send = (status, body) => {
          // 余额/用量属隐私数据，禁止浏览器 HTTP 缓存
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        try {
          if (!methods.includes(req.method)) {
            send(405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!isLoopback(req.socket.remoteAddress || '')) {
            send(403, { ok: false, error: 'forbidden' })
            return
          }
          const body = json ? await readJsonBody(req) : undefined
          send(200, await getBody({ method: req.method, body }))
        } catch (err) {
          // 请求体不合法是调用方的问题（400），其余一律 500：细节留在 Host 日志
          if (err instanceof BadRequest) {
            send(400, { ok: false, error: 'bad request' })
            return
          }
          ctx.logger.warn(`usage-stats: ${name} route failed: ${String(err)}`)
          send(500, { ok: false, error: 'internal' })
        }
      },
    }), `usage-stats: ${name} route`)
  }

  const server = ctx.get('webServer') ?? ctx.get('httpServer')
  if (server !== undefined && typeof server.register === 'function') {
    // 查询路由：官方用量 / 费用 / 余额
    route('query', QUERY_ROUTE, async () => {
      const payload = {
        status: 'unavailable',
        today: null,
        month: null,
        currency: null,
        balance: null,
      }
      const official = await officialSnapshot()
      if (official !== null) {
        // 保留接口原始货币与金额，不做硬编码汇率换算
        payload.status = 'ready'
        payload.today = { tokens: official.today.tokens, cost: official.today.cost }
        payload.month = { tokens: official.month.tokens, cost: official.month.cost }
        payload.currency = official.currency
        payload.balance = official.balance
      } else {
        // 只有"确实没有可用 token"或"平台明确拒绝了这个 token"才让用户去改配置；
        // 拉取失败（超时/限流/WAF/服务端 5xx）是"暂不可用"，不能谎称 token 没配好。
        const noToken = !tokenResolver.hasToken()
        const rejected = tokenResolver.isRejected()
        payload.status = (noToken || rejected) ? 'configuration_required' : 'unavailable'
        payload.officialError = noToken
          ? '请配置有效的 platformToken 以查看官方用量'
          : rejected
            ? 'platformToken 已被平台拒绝（可能已过期），请重新获取后更新配置'
            : '官方数据暂不可用，请稍后重试'
      }
      return payload
    })

    // 版本检测：仅供本机页面读取「是否有新版」（非敏感）
    route('update', UPDATE_ROUTE, async () => ({ ok: true, ...(await updateSnapshot()) }))

    // 服务状态：抓取在 Host 做——status.deepseek.com 无 CORS 头，浏览器端直接 fetch 拿不到；
    // Host 侧结果有缓存（无告警 5 分钟 / 有告警 30 秒），客户端按同样的节奏轮询。
    // 静音组件进缓存键：改了设置就是另一份快照，不必等旧缓存过期。
    route('status', STATUS_ROUTE, () => statusSnapshot(mutedKeyOf(readAlertsSettings().muted)))

    // 告警设置：设置页读写。GET 返回可订阅组件（来自官方「受影响组件」）+ 当前静音项；
    // POST 整份覆盖静音项（幂等，便于以后加字段）。只动 SETTINGS_FILE，不碰 token 文件。
    route('alerts', ALERTS_ROUTE, async ({ method, body }) => {
      if (method === 'GET') {
        const snapshot = await statusSnapshot('') // key '' = 不静音任何组件，顺带拿到全量组件清单
        return {
          ok: true,
          muted: readAlertsSettings().muted,
          options: Array.isArray(snapshot.available) ? snapshot.available : alertsOptions([]),
        }
      }
      // POST：`muted` 必须是数组；未知/非法组件键由 normalizeMuted 丢弃（不报错，宽松写）
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('body must be an object')
      if (body.muted !== undefined && !Array.isArray(body.muted)) throw new BadRequest('muted must be an array')
      const saved = writeAlertsSettings(body.muted ?? [])
      return { ok: true, muted: saved.muted }
    }, { methods: ['GET', 'POST'], json: true })
  }
}

// 仅供本地校验解析与缓存策略（判据来自真实 feed 的真实形状）
export const __test = {
  cached,
  createTokenResolver,
  parseStatusFeed,
  parseStatusFeedItems,
  evaluateStatusItem,
  evaluateStatusItems,
  componentKeys,
  componentKeyOf,
  componentLabelOf,
  componentGroupOf,
  alertsOptions,
  COMPONENT_KEYS,
  DEFAULT_MUTED,
  normalizeMuted,
  readAlertsSettings,
  writeAlertsSettings,
  mutedKeyOf,
  shortStatusLabel,
  statusSeverity,
  decodeXml,
  createStatusSnapshot,
  compareVersions,
  parseVersion,
  isAlphaVersion,
  createUpdateSnapshot,
  updateInfo,
  statusTtlOf,
  idleStatus,
  fetchLatestDshVersion,
  SETTINGS_FILE,
}
