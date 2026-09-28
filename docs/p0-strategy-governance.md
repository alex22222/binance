# P0 策略证据与实盘资格治理

## 目标与边界

一次性实施：证据归档、研究资格与运行/审批状态拆分、买入执行门禁。
完成条件：门禁负例及卖出隔离回归通过；服务健康、页面/API、代码哈希及受保护状态经部署验证。
不修改钱包、标的池、风控阈值、自动审批、持仓或既有研究报告。不执行测试交易。

运行状态 ACTIVE 只表示代码支持该策略，不代表已获实盘资格。
证据缺失、过期、规则/代码/配置不匹配、未通过独立复核：禁止新增 Live BUY。
已有 SELL、止损、订单查询与恢复不经过该门禁，仍遵循原有审批、报价和风控。

## 证据档案

`state/strategy-evidence/<sha256>.json` 是按规范化内容寻址的不可覆盖对象。
历史、报告内前向、Paper、Shadow、Live 日志窗口分别登记，保留亏损和零交易。
捕获工具只能保存已有数据，不访问钱包、不回测、不采集报价、不启动 Paper。
命令为 `node scripts/capture-strategy-evidence.mjs`，每天 23:30 UTC 定时捕获一次。
这是每日已保存结果快照，不承诺收集两次捕获之间被覆盖的中间结果或完整历史成交账本。
归档服务禁止网络访问；损坏来源报告失败，但不删除已归档对象。
旧报告没有生成时版本/代码/配置/标的池证明时，identity=null，明确 UNBOUND_LEGACY；
不得用捕获时版本冒充生成时版本，不能用于实盘晋级。捕获时间不是数据截止时间。
后续研究生产者需在生成结果时保存 identity、author、generatedAt、dataCutoff、validUntil、
costModel、sourceHash 和 evidenceLevel；历史数据与实盘执行证据不可混同。

## 实盘资格

`strategy-governance/authorizations.json` 由运维人工审阅发布，初始为空。
生产该目录与文件须与代码同属 root，目录 755、文件 644/640，服务用户无写权限。
Dashboard、Bot、基金经理报告没有写入授权的接口；本次部署不签发任何 PASS。
授权绑定 identityHash、按序 evidenceIds、approvedBy/approvedAt/expiresAt。
review 必须绑定相同 identityHash/evidenceIds，提供独立 reviewer、PASS、reviewedAt，
并明确确认 costs/independentForward/risk/benchmark/execution；reviewer 不能是证据 author。
至少包含 HISTORICAL、FORWARD、PAPER；前向不能仅为 K 线或反事实代理。
数值盈利/风险标准由独立研究复核按事先冻结的研究协议验收，本模块不降低或重写这些标准。
身份基于规则定义、src 全部模块内容哈希、白名单运行参数与标的池。任何代码变化保守地使旧授权失配。
进程启动固定代码身份；磁盘文件改变而进程未重启时拒绝新增 BUY，不借用新版本授权。
研究作者与 checker 的真实独立性由运维审核负责，字符串不同本身不是身份认证。

最终提交前再次读取并验证；审批中的 identityHash、授权 ID 变化时旧审批不能沿用。
决策、审批、意向与持仓携带门禁凭证，终态日志可追溯至证据 IDs 和运维授权。

## 迭代状态

- [x] 只读确认生产 QQQ 持仓、无在途订单与审批；用户明确允许保留持仓短暂重启。
- [x] 读取执行/策略/报告/审批实现，新增门禁负例测试并确认未实现时失败。
- [x] 实现及独立代码复核；版本漂移与错误审计先红后绿修复，47 项独立窄测通过。
- [x] 最终全套 338 项通过；生产受保护环境 Linux 预检通过，本地未加载凭据的预检失败不作生产结论。
- [x] 精确路径提交、推送、备份、窄范围部署与状态验证，代码提交 `0a0ea5b`。

## 2026-09-28 生产验收

- 本地最终 338 项测试通过；服务器以生产旧依赖叠加发布包的隔离目录测试 50 项通过。
- 独立 checker 复核通过；原先发现的进程/磁盘版本混淆和错误 allowed 审计均有回归测试。
- 13:54:18 UTC 开始停服务，13:54:19 UTC Bot 与 Dashboard 启动；13:54:26 UTC QQQ 可执行报价监控恢复。
- 鉴权 `/health`、`/api/strategy-research`、`/api/snapshot` 和 `/strategies` 均成功；公网未登录 303 到 `/login`。
- 线上新增买入门禁 `NO_LIVE_AUTHORIZATION`；真实审批状态仍为 AUTO，钱包 CONNECTED。
- QQQ 数量 `0.068565020872654946`、成本 50 USDT、原入场订单未变；无待提交/待审批订单，无新错误。
- 生产 config、环境文件、策略控制和审批开关哈希前后一致；未覆盖钱包或状态，未执行测试交易。
- 首次只读归档 22 个对象，HISTORICAL / FORWARD / PAPER / SHADOW；当前读取的终态成交日志窗口无 Live 对象，不代表完整历史从未成交。
- 归档任务退出码 0、无缺失来源和错误；每日 23:30 UTC（北京时间次日 07:30）运行，随机延迟最多 60 秒。
- 所有发布文件哈希一致；备份位于服务器 `/var/backups/binance-agentic-stock-bot/p0-0a0ea5b.NIQq4X/`。
- 为当前 Dashboard 入口补齐已提交的四个只读周报依赖模块；没有启动周报采集、同步研究报告或修改生产策略。
- 不相关的 `docs/weekly-research-loop.md` 与 `docs/strategy-research-page.md` 本地改动保留，未纳入本次提交。

后续仍需真实成本与独立前向研究，以及明确的独立复核和运维授权；本次工程验收不代表策略已被证明盈利。
