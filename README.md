# dsh-usage-stats

[![Vibe coded](https://img.shields.io/badge/vibe-coded-%23ff69b4?style=flat-square)](https://en.wikipedia.org/wiki/Vibe_coding)

DeepSeek Harness 插件：侧边栏左下角（设置按钮上方）显示**今日 / 本月** token
消耗、费用与**账户余额**；并在左上角品牌行（`deepseek HARNESS` 右侧）检测
**是否有新版** DSH，有则显示「有新版」徽章。

点击卡片标题「用量信息↗」可打开 DeepSeek 开放平台，查看官方详细用量数据。
点击「有新版」徽章可打开 [deepseek-harness Releases](https://github.com/deepseek-ai/deepseek-harness/releases)。

> 🎨 本项目由 **vibe coding**(AI 辅助开发)驱动——功能、测试与文档均在 AI agent 协作下迭代产出。

## 效果预览

![效果预览](example.png)

## 安装

```sh
dsh plugin --profile web add ./dsh-usage-stats   # 或发布后: github:<owner>/dsh-usage-stats
```

安装后重启 `dsh web`。

## 配置 token

插件只使用**官方用量、费用与余额**，需要有效的 token。
创建 `~/.dsh/dsh-usage-stats.json`：

```json
{ "platformToken": "你的 userToken" }
```

userToken 获取：打开 platform.deepseek.com → F12 → Application →
Local Storage → `https://platform.deepseek.com` → 复制 `userToken` 的 value。
改文件即生效。

不想手动填也可以**自动扫描本机浏览器**（Chrome / Edge / Brave / Arc），显式开启
（默认关闭）：

```json
{ "autoScan": true }
```

### autoScan 工作原理与已知限制

autoScan 会读取各浏览器 profile 的 `Local Storage/leveldb`，启发式提取
`platform.deepseek.com` 的 `userToken` 候选，再逐个发往 DeepSeek 校验，选有效的那个。

因为 Chrome 的 LevelDB 在压缩（compaction）时可能把一条记录的 **key 和 value 分散到
不同 SSTable 文件**，且 localStorage 值实际以 `{"value":"...","__version":"0"}` 形式存储，
纯文本扫描有时抓不到（或抓到**其他网站的旧 token**，校验会返回 40003 无效）。

插件为此做了两处收敛（`scanBrowserTokens`）：

- 优先收集**含 `platform.deepseek.com` origin 文件**里、长度在 `55–85` 的独立 base64
  运行（按接近 65 排序），能命中有效 token 并天然排除其他网站/旧记录的 token；
- 再用 `userToken` key / origin / `"value":"` **marker 邻近候选**兜底；
- 候选上限 `MAX_CANDIDATES`（40），并记住"已穷尽"状态，避免无有效 token 时每次查询
  重复校验全部候选。

**仍非 100% 可靠**（跨 SSTable 是 Chrome 固有限制）。若 autoScan 显示
`scanHint`（未找到有效 token），最稳的做法是手动填 `platformToken`。

## 检测新版

插件在左上角品牌行（`deepseek HARNESS` 右侧）检测 DSH 是否有新版：

- **判定**：读取运行中 DSH 的版本（与 `dsh --version` 同源，取自其 `package.json`），
  对比 npm 上 `@deepseek-ai/dsh` 的 `dist-tags.latest`；最新版比本地新即显示「有新版」，
  无更新则隐藏。支持 `-rc.N` 预发布版本比较。
- **频率**：本地缓存 1 小时、页面低频轮询（版本变更极低频），避免频繁请求 npm。
- **点击**：只跳转 [deepseek-harness Releases](https://github.com/deepseek-ai/deepseek-harness/releases)，
  不会误触发品牌行的「新建会话」（已做点击冒泡隔离）。
- 失败的 npm 请求不会被缓存，下次自动重试。

## 数据来源

- **唯一数据源为官方平台**（配置有效 token 后）：
  为账号全量数据（含其他客户端用量）
- 不监听本地请求、不统计会话、不维护价格表；token 和金额均来自官方接口。
- 保留“高峰 / 空闲”时段提示，沿用北京时间工作日 9–12、14–18 为高峰、周末及其他时段为空闲的展示规则；该标签不参与用量或金额计算。
- 未配置或 token 无效时显示配置提示；官方请求失败时显示暂不可用，不以零用量替代。
- 今日使用官方小时桶，本月使用官方日桶，两者可能有不同的更新延迟。

## 卸载

```sh
dsh plugin --profile web remove dsh-usage-stats
```

## License / 致谢

MIT（见 [LICENSE](LICENSE)）；架构参考 [dsh-liquid-glass-balance-card](https://github.com/SoDaZilla-zzz/dsh-liquid-glass-balance-card)。
早期本地统计逻辑曾参考 [dsh-token-stats](https://github.com/F1shn/dsh-token-stats)（MIT），现已移除。
