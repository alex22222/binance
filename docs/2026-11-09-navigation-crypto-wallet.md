# 导航、数字货币单页与 OKX Agentic Wallet

## 本次需求及验收

1. 导航“币安Agent Wallet”改为“Agentic wallet”。
2. polymarket改为“Poly 跟单”，与Polymtrade继续保留新标签页打开。
3. GMGN归入“数字货币”。
4. 收藏日报和BTC风控真正整合为一个重构页面，BTC内容优先；保留现有数据质量、风险含义及原路径可达。
5. Agentic wallet下整合OKX Agentic Wallet，优先复用既有系统与只读来源，展示明确数据时点、账户/链和未核实状态。

执行为一次性开发及隔离发布；并行按文件分工，先读既有实现/测试与生产版本，再确定最小接口、实现、测试、独立复核、浏览器和生产HTTP验收。记录在本文与 artifacts/navigation-crypto-20261109/。成功条件为五项用户可见行为完成、相关/正式测试通过、生产页面真实可用且交易身份/策略/授权/凭据/钱包与Bot/Caddy不变。当前任务未授权交易、签名或钱包会话迁移。

## 当前进度

- [x] 已读取现有导航、收藏日报、路由、发布隔离约束及OKX Skill的安全边界。
- [x] 确认实际生产BTC版本与可复用的OKX系统/只读来源。
- [x] 确认单页组合及钱包接入接口。
- [x] 完成UI、导航和路由。
- [ ] 专项/正式测试、独立复核和可视验收。
- [ ] 隔离发布及HTTPS/受保护交易身份验收。

## 实现及边界

- `/crypto` 与 `/btc-radar` 展示同一个 BTC 优先的服务端页面，依次为 BTC 概览、持仓风险、趋势、评分因子、同模型每日证据、收藏与新闻。`/btc-radar?view=detail` 保留原有情景预览及资金设置；`/api/crypto` 保持兼容，新增 `/api/digital-currency`。
- 生产 BTC 仍由既有 `20261025-score-history-5af5158` 独立发布加载，口径为 `pressure-v2-no-touch-probability`。本轮不发布本地 v3 风控代码；失效快照不显示当前评分或评级，摘要标为历史。
- `/agentic-wallet/okx` 与对应只读 API 展示个人资产中精确标记为 OKX Agentic Wallet 的记录及现有 Mac OKX 系统的脱敏状态。资产不再次合计，不复制钱包、凭据、地址或会话。
- Mac 仅从 7 个既有 JSON 文件读取状态，原始完成时间分别保留。专用桥每 5 分钟将脱敏快照发送到受权限保护的独立目录；失败不覆盖服务器上次有效状态。执行/健康超过 3 分钟、筛选/账本超过 15 分钟均标旧，快照搬运不产生新的健康时间。不会运行或启停源策略。
- UI 使用独立不可变 release 与原子 current 切换；仅重启 Dashboard。保护交易 src 全量身份、配置、授权、BTC release 和 Bot/Caddy PID。
