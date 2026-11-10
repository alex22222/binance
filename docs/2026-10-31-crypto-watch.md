# 数字货币 · OKX 收藏日报

目标：在共享导航新增“数字货币”，包含“收藏日报”和原“BTC 风控”。每日北京时间 08:00 从 OKX 公共行情生成逐交易品种摘要；保留现货、永续及 TradFi 品种身份。页面、API 和数据仍受现有 Dashboard 登录保护。

## 数据与触发

- 收藏来源是用户已登录 OKX Desktop 的“行情 → 自选 → 全部”，不是账户余额或平台热门榜。收藏列表保存到 `state/crypto/watchlist.json`，包含来源、读取时间和完整 `instId`；私人名单不入 Git。
- 首次核对于北京时间 2026-10-31，读到 18 个交易品种、17 个基础标的。GRASS 的现货和永续分别监控；SPCX、ANTHROPIC 永续按 TradFi/Pre-IPO 标记，不当作链上代币或实际股票持仓。
- `scripts/run-crypto-watch.mjs` 仅调用公共 GET，不使用账户密钥、钱包或交易接口。汇总价格、24 小时涨跌/高低、可核实成交额、买卖价差、已收盘日线的七日表现及永续资金费率；来源时间和缺失项随报告保存。新闻公告由独立模块接入同一每日任务，详见下节。
- `binance-agentic-crypto-watch.timer` 每日北京时间 08:00 运行，服务器恢复时补跑。行情日报不依赖本机开机；收藏变化的读取依赖本机及已登录 OKX 可用。不能将最近一次名单冒充持续实时同步。
- 本聊天的每日任务在 07:50 读取 OKX 自选变化，验证完整列表后原子更新服务器名单；读取失败保留上一份名单并报告失败，不以空列表覆盖。名单超过 36 小时未同步，页面明确提示。

## 验证循环与隔离

先读取现有模块与相关测试、运行基线，再实现导航、采集、页面和认证后路由；运行行为测试、整套正式测试、Linux 发布校验及浏览器检查。完成条件是已认证页面显示真实名单和首份采集结果，定时器有明确下次触发时间，原 BTC 路由可访问。

发布使用 `/opt/binance-agentic-personal-assets/releases/` 独立不可变版本，精确扩充两项模块名单及必要附带文件。不得把新模块或导航同步到生产交易 `src/`；不得改交易身份、策略、授权、续签基线、保护停止或配置。仅重启 Dashboard，安装只读日报独立 service/timer。运行时数据仅写新建的 `state/crypto/`。

## 状态

- [x] 读取原生 OKX 自选页，确认完整品种身份。
- [x] 现有导航与个人资产路由相关基线通过。
- [x] 新模块与失败/缺失/过期测试通过。
- [x] 独立发布及每日任务启用、首份真实日报可查看。
- [x] 浏览器核对收藏日报及 BTC 风控入口。

## 本次验收

- 正式测试 `node --test --test-concurrency=1 test/*.test.mjs watch/test-bridge.mjs`：1087 项，1085 通过、2 项按平台条件跳过、0 失败。后续补充空名单与低价币精度回归，最终页面及认证路由专项 10/10 通过。
- 服务器 Linux preflight 成功；完整 62 文件隔离包通过 check、stage 和加载器哈希验收。最终独立版本 `/opt/binance-agentic-personal-assets/releases/20261031-crypto-watch-v2`。
- 首份报告为北京时间 2026-10-31 16:36 采集：18/18 品种完整，15 个现货与 3 个永续；这是手动初始化，不当作首次自然定时周期成功。
- 每日行情 timer 已 enabled/active，下次北京时间 2026-11-01 08:00（随机延迟不超过 60 秒）。本机收藏同步 heartbeat `okx` 已 ACTIVE，每天 07:50；同步辅助脚本实际回读 18 品种，无增删。首次自然周期尚待到时运行。
- 浏览器已确认数字货币下拉包含收藏日报/BTC 风控，日报 18/18；NFT 价格 `0.0000002332` 完整显示。HTML 和 API 登录保护及无交易状态写入通过测试。
- 生产全 src 身份保持 `f42b7f29af0826b645c4ecebd885ca0f222554d7d48dc37e5aafd9da2c5678b5`，受保护配置/控制/授权文件哈希、Bot/Caddy PID 均不变。仅 Dashboard 重启。既有授权 `HALTED / STRATEGY_CONTROL_CHANGED` 原样保留，未恢复或重绑。
- 私有运行说明与同步辅助程序：`artifacts/crypto-watch/RUNBOOK.md`、`artifacts/crypto-watch/sync-favorites.py`。服务器备份与发布回执：`/var/backups/binance-agentic-stock-bot/20261031-crypto-watch/`。本地回归/发布日志：`artifacts/crypto-watch/deploy-20261031/`。

## 新闻公告接入

用户追加要求接入新闻公告。沿用每天北京时间 08:00 的服务，不新增定时器、不更改收藏同步或交易控制。

- 新闻源：[CoinDesk RSS](https://www.coindesk.com/arc/outboundfeeds/rss)、[Cointelegraph RSS](https://cointelegraph.com/rss)、[Decrypt RSS](https://decrypt.co/feed)。仅读标题、原始链接、发布时间及采集时间，不抓取或转存全文。
- 公告源：[OKX 全球中文最新公告公开页](https://www.okx.com/zh-hans/help/section/announcements-latest-announcements)的已完成 SSR 数据。官方公告 API 在本服务器 IP 上返回地区子集，不能代表全球永续公告，故未将其作为全球来源。
- 扫描的是各来源当前提供的最新标题子集；七天仅为发布时间过滤，不是完整七天搜索。逐币匹配使用已核对的品牌名和必要上下文，防止把 Litentry、芯片新闻、一般 NFT 或普通 near/grass/pump 词语关联到当前币种。官方公告允许精确的大写代号/交易对匹配；未知新币种标记尚未配置消歧。
- GRASS 现货与永续使用同一个基础标的新闻集合。SpaceX/Anthropic 显示公司相关新闻，不将公司消息称为代币发行或股票持仓。平台公告另列，不把所有平台公告自动分发到每个币种。
- 新增 `src/crypto-news.mjs`，只依赖 Node 内置模块；固定来源 GET、10 秒超时、每源最多 2 MB、发布时间与 URL 校验、去重及最多逐币五条摘要。页面逐币展示最多三条，保留原始来源和时间。
- `state/crypto/news.json` 独立保存。行情全部失败时，当日新闻仍可显示；价格保留旧时间。来源失败时仅复用同源且重新校验的历史标题，标记缓存并保留原采集时间；有效空列表与来源失败分别展示，不把未匹配当作没有事件。
- 独立发布名单仅精确增加 `crypto-news.mjs`，仍不修改生产交易 `src/` 或其身份算法。进度与验收日志保存在 `artifacts/crypto-watch/news-20261031/`。

新闻验收已完成：

- 新闻/行情/页面/认证路由/发布专项 55/55 通过；独立复核无阻断问题。完整正式回归 1107 项，1105 通过、2 项按平台条件跳过、0 失败。
- 最终独立版本 `/opt/binance-agentic-personal-assets/releases/20261031-crypto-news`，63 文件清单通过守卫检查/暂存及加载器验证。服务器 Linux preflight 成功。
- 北京时间 2026-10-31 16:51 真实采集：四来源全部正常，媒体标题分别 25/30/38 条、七日过滤后的 OKX 公告 10 条；当次匹配 BTC、HYPE、SPCX、ANTHROPIC，其余标的明确显示未匹配。行情仍为 18/18 完整。此为上线初始化，尚不代表首次自然定时周期成功。
- 已认证公网页面与 API 回读成功，未认证页面/API 均拒绝；原 BTC 风控可访问。浏览器已确认“来源 4 · 正常 4 · 缓存 0 · 失败 0”、逐币来源/发布时间/采集时间及平台公告独立区。
- 只重启 Dashboard；原生产全 src 身份、受保护文件哈希、Bot/Caddy PID 及既有授权状态均不变。08:00 日报 timer 仍 active，07:50 收藏同步计划未更改。
- 服务器备份及前后验收回执：`/var/backups/binance-agentic-stock-bot/20261031-crypto-news/`；本地日志：`artifacts/crypto-watch/news-20261031/`。未提交或 push Git。
