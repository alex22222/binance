# Minara Harness 深度调研与当前项目借鉴报告

> - 调研对象：小红书/X 帖子所介绍的 Minara Harness
> - 原始帖子：https://x.com/ayi_ainotes/status/2098346305319743777?s=46
> - 调研日期：2026-09-13
> - 适用项目：`/Users/henry/projects/binance`
> - 结论口径：区分官方可核验事实、厂商自述、公开代码证据和仍待验证的营销主张。

## 1. 执行结论

Minara Harness 可以理解为一个面向金融研究和交易的闭源 Agent 工作台：用户用自然语言提出问题，多个研究角色调用数据、浏览器和代码工具，生成有来源的研究结论；Strategy Studio 再把策略描述转成可编辑代码、回测、Paper 和 Live 运行。帖子中展示的“4 个 Agent、7 个阶段”是一次任务配置，不应理解为一个已经公开、固定且被验证有效的投资算法。[^1][^2]

对当前项目，建议采取明确的两段式判断：

- **可以借鉴，而且优先级高**：研究过程留痕、证据与结论绑定、Agent 分歧可见、策略版本化、样本内与发布后样本外分开、资产能力登记、按策略隔离风险预算。
- **不建议直接接入或照搬**：Minara 托管签名和 Autopilot、代币化美股永续合约、策略市场跟投、自然语言直接发布 Live、用厂商 benchmark 代替交易收益验证。
- **对当前项目最合适的定位**：借鉴 Minara 的研究工作台和策略工件设计，保留现有的强制人工审批、可执行报价校验、Paper/Shadow/Live 隔离以及失败关闭规则。
- **直接使用存在现实阻断**：Minara 使用条款明确把中国大陆列为受限地区。若使用人居住或位于中国大陆，不应开户、连接钱包或运行 Autopilot。这里是合同文本判断，不构成法律意见。[^12]

Minara 最有价值的地方不是证明了某种高收益策略，而是把“研究、实现、回测、运行、审计”做成连续产品流程。它目前没有公开足够证据证明能稳定产生超额收益，也没有公开 Harness 核心编排器、策略引擎或风险控制服务端代码。[^24]

## 2. 调研方法与证据等级

本次核验覆盖以下材料：

1. 原始 X 帖子的索引文本和 Minara 官方发布文章。
2. Minara 官方文档仓库、公开 CLI、Agent Skill 和对应固定提交版本。
3. Minara 使用条款、隐私政策、SlowMist 审计报告。
4. Circle Ventures 官方生态名单、Hyperliquid 官方 HIP-3 与 API 文档。
5. 2026-09-13 对 Hyperliquid `perpDexs` 接口的只读查询。
6. 当前项目的 [README](../README.md)、[系统架构](./system-architecture.md) 和现有研究/Paper 边界。

证据按以下规则解释：

| 等级 | 含义 | 示例 |
| --- | --- | --- |
| A | 法律文件、固定提交公开代码、链上/交易所官方接口 | Terms、CLI 源码、Hyperliquid API |
| B | 官方产品文档或技术文章，但关键实现闭源 | TEE、Strategy Studio、Benchmark |
| C | 社交媒体演示、市场宣传或无法独立复现的收益 | X 帖子、策略收益案例 |

因此，“有这个功能”和“这个功能能稳定赚钱”是两件不同的事；“通过旧版本安全审计”和“当前 Harness 整体安全”也是两件不同的事。

## 3. 这个项目到底是什么

### 3.1 产品组成

官方材料显示，Minara Harness 主要由四层组成：

| 层次 | 主要能力 | 核验结果 |
| --- | --- | --- |
| 通用 Agent | 浏览、写代码、调用金融数据、生成文档 | 官方确认，具体编排内核闭源 |
| Institution Mode | 多角色 Roundtable，展示来源、假设、分歧和失败 | 官方确认；研究结论本身不授权交易 |
| Strategy Studio | 自然语言生成策略规格和代码，回测、优化、Paper、Live | 官方确认；回测方法细节主要是厂商自述 |
| Autopilot | 在永续合约子账户内持续运行预定义规则 | 官方确认；启用后不逐单人工确认 |

帖子所说的基本面、情绪/Polymarket、宏观政策、技术/订单簿四类 Agent，与 Institution Mode 的可配置 Roundtable 设计一致。不过，官方资料没有证明这四个角色是固定架构，也没有披露它们如何消除重复数据、相关性偏差或模型共同幻觉。[^1][^2]

### 3.2 研究范围大于可执行范围

Minara 声称可接入 FMP、Glassnode、CoinGlass、DeFiLlama、Arkham、CoinGecko 等 50 多类数据和工具，研究范围覆盖股票、加密货币、宏观和链上数据。[^22] 但其当前可执行重点是 Hyperliquid 和 Lighter 上的永续合约，并不是在传统券商买卖真实股票。

以 AAPL 为例：Hyperliquid HIP-3 允许第三方部署永续市场。2026-09-13 的官方接口中确实能看到多个部署方提供的 AAPL、NVDA、TSLA、SP500、USBOND、USTECH 等永续标的，但它们是不同部署方、不同预言机和不同风险参数下的合约。接口返回的 OI cap 是上限，不是实际成交深度或可实现流动性。[^20][^21]

Minara 官方股票文档也明确说明，这些“tokenized stocks”是永续合约，不提供股息、投票权或股票所有权，并带有资金费率、杠杆、强平和非美股时段流动性不足等风险。[^8]

这意味着帖子里的“AAPL 买入/持有/卖出”至少要拆成三层理解：

1. 研究对象可能是苹果公司和 AAPL 现货市场。
2. 回测数据可能来自 FMP 的传统市场历史数据。
3. 实际执行却可能是 Hyperliquid 某个部署方的 AAPL 永续合约。

三者的价格形成、交易时段、资金费率、滑点、预言机和尾部风险并不相同。官方跨截面策略文档自己也承认：传统市场回测使用 FMP，因为链上 RWA 永续历史太短；回测只能提供方向性证据，不能直接代表链上执行结果。[^6]

## 4. 对帖子主要主张的逐项核验

| 帖子主张 | 结论 | 科学评价 |
| --- | --- | --- |
| “金融界的 Codex” | 产品定位基本成立 | 是交互和工作流类比，不是收益能力证明 |
| 一句话启动 7 阶段研究 | 部分确认 | 自然语言触发成立；7 阶段更像演示配置，不是公开标准算法 |
| 4 个 Agent 并行分析 | 部分确认 | Roundtable 支持可配置角色；角色质量、独立性和冲突裁决未公开 |
| 过程、来源和分歧可见 | 官方确认 | 这是最值得借鉴的产品能力之一 |
| 自动写策略并回测 | 官方确认 | 可编辑 TypeScript/Python 策略、费用和滑点设置、交易日志、指标均有文档 |
| 可直接交易 AAPL | 容易误解 | 实际是链上永续合约，不是苹果股票 |
| 实盘需要人工确认 | 只对部分流程成立 | 普通策略发布有确认；Autopilot 获得范围授权后不逐单确认 |
| 获 Circle Ventures 投资 | 关系可信，细节未知 | Circle Ventures 生态页列出 Minara，但未找到公开金额、轮次和条款 |
| 能显著提高金融 Agent 表现 | 有自测支持，缺独立复现 | Benchmark 是厂商自发、自评，不能推导为投资收益或风控有效性 |

Circle Ventures 官方生态页确实列出了 Minara.ai，足以支持双方存在投资组合或生态关系；Circle Alliance 目录则只能证明合作伙伴身份。公开材料没有披露投资轮次、金额或治理关系。[^14]

## 5. 策略与回测能力评价

### 5.1 值得肯定的设计

Strategy Studio 的时间序列策略使用 TypeScript DSL，跨截面策略展示 Python 因子代码；用户可修改代码、参数、费用、滑点、再平衡周期和数据窗口。结果包含收益、回撤、Sharpe、Profit Factor、交易日志等，并保留策略版本。[^5][^6]

官方还强调三条曲线应分开：

- 回测样本内表现；
- 策略公开时点之后的 live-forward 样本外表现；
- 用户自己实际运行产生的记录。

这比只展示一条经过挑选的历史净值曲线更严谨，也是当前项目可以直接借鉴的原则。[^7]

### 5.2 仍不能证明的部分

官方 Strategy Studio 页面声称支持 10 年以上历史、walk-forward、样本外、市场状态切片、泄漏检查以及费用、资金费率、借贷和滑点。[^4] 但公开资料没有给出：

- 数据供应商不同版本之间如何复现；
- 退市、成分变更、幸存者偏差和公司行动如何处理；
- 自动优化的搜索空间、停止条件和多重检验校正；
- Hyperliquid/Lighter 的逐笔深度、排队成交和部分成交如何模拟；
- TradFi 数据与链上永续执行之间的基差、资金费率和夜间流动性如何校准；
- 完整、可独立运行的复现包。

因此，这些能力应视为“产品功能声明”，不能视为已经完成同行审查的方法学。

### 5.3 Benchmark 不能替代 Alpha 证明

Minara 自行发布的 Harness benchmark 覆盖 6 类任务、3 个模型和 4 个 Harness，共 72 个组合。它在 FinReportBench 和部分浏览任务上表现较好，但结果并非全面领先：例如严格 HarnessBench 的 GPT 组合中，Minara 为 40.6%，Claude Code 为 41.5%；金融模型电子表格子集的准确率整体只有约 0% 到 3%。[^15]

这个 benchmark 最多说明 Harness 可能改善信息检索和工具调用，不能说明：

- 生成的策略有稳定样本外 Alpha；
- 回测没有过拟合；
- 真实订单能按模拟价格成交；
- Autopilot 在尾部行情中安全；
- 多 Agent 比单 Agent 加严格数据管道更有效。

在公开资料中，本次调研没有找到独立第三方对其交易收益、回测复现性或 Autopilot 风险的系统评估。

### 5.4 公开代码可验证，但不是核心策略引擎

本次对 Minara CLI 固定提交 `25e64ae6` 做了本地复核：构建通过，270 项测试全部通过；生产依赖审计为 0 个已知漏洞，开发依赖仍有 3 个中危和 4 个高危问题。README 写的是 251 项测试，和实际提交存在轻微文档漂移。

更重要的是，公开 CLI 主要是远程 API 客户端，核心交易和托管流程调用 Minara 的 `/v1/fully-managed/*`、`/v1/tx/*` 等服务。测试通过能证明这个客户端提交的内部一致性，不能验证闭源服务端的策略正确性、权限控制或成交质量。[^16][^24]

## 6. 安全、钱包与合规风险

### 6.1 “需要人工确认”不是统一规则

Minara 官方说明：Institution Mode 的建议不会自动授权交易，Strategy Studio 从 Paper 转 Live 要确认；但 Autopilot 在用户审核钱包、杠杆和限制并启动后，会在授权范围内自行下单，不再逐单确认。启动 Autopilot 还可能取消现有挂单，并要求 cross margin；符合条件的已有仓位可能被纳入管理。[^2][^3]

停止按钮也不是发出请求就完成，必须等运行状态真正变成 `STOPPED`。这类状态机细节值得借鉴，但也说明 Autopilot 不是普通的“建议助手”。

### 6.2 公开 CLI 暴露了文档与执行层不一致

Minara CLI README 称交易存在第二次确认，且不能被 `--yes` 绕过。[^16] 但固定提交的 swap 实现只在未传 `--yes` 时调用 `requireTransactionConfirmation`，而共享确认函数还可被配置关闭。[^17][^18] Minara Skill 文档反而明确禁止 Agent 使用 `--yes`，并要求跨轮次获得用户确认。[^19]

这不能直接证明当前网页 Harness 存在同样问题，因为服务端可能还有未公开拦截；但它能证明一个重要工程原则：

> 写在 Prompt、Skill 或 README 里的安全规则，不等于执行层的默认拒绝控制。

当前项目的强制审批、审批快照绑定、临近执行重新报价、写前订单意图和不确定结果不自动重试，应继续作为不可被配置或自然语言绕过的底层规则。

### 6.3 TEE 有价值，但证据边界有限

Minara 声称 Strategy Studio 会在浏览器加密策略代码，只在 AWS Nitro Enclave 内解密执行，并使用 attestation、短期 ECDH、AEAD、KMS 和签名回执。[^9] 这是合理的多租户策略隐私设计。

但本次没有在 Minara 公共 GitHub 组织中找到完整验证器、Harness 服务端或策略执行引擎。AWS Nitro 的证明可以验证某段 enclave 镜像，不能单独证明网页、控制平面、权限配置、数据源和交易路由均正确。因此目前应定性为“有技术设计和厂商说明，缺完整公开复核”。

对当前单用户、自托管项目，优先把精力放在本地密钥隔离、最小权限和审计日志，比引入 TEE 更划算。只有未来变成多租户、需要替他人运行私有策略时，TEE 才进入高优先级。

### 6.4 旧审计不能覆盖当前 Harness

SlowMist 报告的审计从 2025-07-30 开始，范围是当时的网站和一个旧的 `minara-core-for-audit` 提交。报告列出 23 项问题，包括交易系统错误、验证码暴力尝试和滑点过高等，均标记为已修复；但修复后的完整代码未提交给审计方，部分是黑盒验证。[^11]

该报告早于当前 Harness、Strategy Studio 和 TEE 架构，不能作为这些新模块已经通过安全审计的证据。

### 6.5 数据与签名架构存在文档漂移

隐私政策说明平台会收集余额、持仓、订单、资金费率、强平、交易历史、Autopilot 授权、完整策略版本和执行日志，以及用户 Prompt、对话和输出。[^13]

同时，公开资料对签名基础设施描述不一致：

- 使用条款提到 Privy；
- 隐私政策提到 Particle Network；
- 当前钱包安全文档又描述 EIP-7702 和 AWS KMS。[^10][^12][^13]

这可能来自产品迭代，但在连接真实资金前必须由厂商明确：当前生产架构是什么、谁能触发签名、能否导出或撤销权限、数据保留多久、删除是否覆盖备份、故障时如何停止。

## 7. 与当前 Binance 项目的对比

| 维度 | Minara Harness | 当前项目 | 判断 |
| --- | --- | --- | --- |
| 研究体验 | 多 Agent、来源/分歧可见、文档生成 | 有策略研究、回测和证据标签，但体验较分散 | 借鉴 Minara |
| 数据广度 | 官方声称 50+ 工具和数据源 | 聚焦 Binance Web3、RWA token 和项目内数据 | 不盲目追求数量，先做数据血缘 |
| 策略工件 | 代码、版本、回测、Paper、Live 连续流程 | 已有回测/Paper/Shadow/Live，但缺统一不可变策略工件 | 优先补齐 |
| 样本外展示 | 明确区分回测、发布后、个人运行 | 已强调 chronological OOS 和 Paper/Shadow 分离 | 继续强化并统一展示 |
| 交易资产 | 以 Hyperliquid/Lighter 永续为主 | BSC 上 RWA/ETF token 路由 | 两者都不等于持有真实股票/ETF |
| 做空与杠杆 | 永续原生支持，伴随资金费率和强平 | 当前策略边界不依赖永续做空 | 不为功能完整而新增尾部风险 |
| 人工审批 | 普通流程确认，Autopilot 范围授权后自动 | Live 强制审批且执行前重验 | 当前项目更严格，应保留 |
| 执行证据 | 文档声称 Paper/Live 连续，核心闭源 | 明确要求金额、方向、时间匹配的可执行报价 | 当前标准更适合验证真实收益 |
| 隐私 | TEE/KMS 厂商自述，多租户价值高 | 单用户本地/自托管，策略无需交给第三方 | 当前阶段保持简单 |
| 合规适用性 | Terms 限制中国大陆 | 仍需分别遵守 Binance、钱包和代币条款 | 不直接接入 Minara |

当前项目已经具备几项比 Minara 公开 CLI 更稳健的底座：

- Live 默认关闭，必须同时满足模式、环境开关和人工审批；
- 审批绑定精确标的、金额、报价和策略快照；
- 执行前重验报价、漂移和有效期；
- 写前记录订单意图，不确定结果不自动重复下单；
- Paper、Shadow、回顾性回放和真实成交明确分层；
- `CANDLE_PROXY`、`QUOTE_REPLAY` 和真实可执行报价不能混为一谈；
- 研究和 Paper 流程不接触钱包或 Live 候选链路。

因此，升级重点不应该是“给 Agent 更多下单权限”，而应该是“让研究证据、策略版本和后续结果更容易复核”。

## 8. 最值得借鉴的九项设计

### 8.1 Research Run Manifest

每次研究生成一个不可变清单，至少包含：

```text
run_id
prompt + requested_at
instrument_id + instrument_type + venue + execution_route
agents: role, model, tools, status, output_hash
sources: source_id, retrieved_at, effective_at, coverage, content_hash
claims: claim_id, evidence_ids, confidence, contradiction_ids
failures + missing_data + disagreements
strategy_artifact_id + code_hash + config_hash + data_cutoff
decision: research_only | shadow | paper | live_proposal
```

价值在于：以后看到一个结论，可以追溯它用了什么数据、何时获取、哪个 Agent 产生、哪里发生冲突，而不是只保存最终中文报告。

### 8.2 有类型的 Agent 输出，不做“开会表演”

四类 Agent 不必固定开启。应按任务选择角色，并要求统一结构：

- `claims`：每条主张必须绑定证据 ID；
- `assumptions`：无法核验的前提；
- `data_gaps`：缺失数据和影响；
- `counterarguments`：最强反证；
- `confidence`：置信度及原因；
- `as_of`：数据有效时点。

最终管理 Agent 不按多数票决策，而是生成“支持证据、反对证据、无法裁决项”。多 Agent 使用同一模型和同一数据源时高度相关，四票赞成不等于四份独立证据。

### 8.3 资产能力登记表

把“可以研究”和“可以交易”拆开。每个标的登记：

```text
canonical_asset
instrument_id
instrument_type: equity | etf | rwa_token | spot | perpetual
venue + chain_id + contract
ownership_rights + dividend_treatment
supports_short + leverage + funding + liquidation
trading_hours + oracle + settlement
allowed_modes: research | shadow | paper | live
```

这可以阻止把 AAPL 股票、AAPL 永续和跟踪 AAPL 总回报的 RWA token 当成同一资产，也能让前端在第一屏直接展示“这是代币/永续，不是股票”。

### 8.4 策略作为不可变版本工件

每次修改参数或代码都创建新版本，不覆盖旧结果。工件应绑定：

- 父版本和变更原因；
- 策略代码、参数、数据版本和截止时间；
- 交易成本、滑点、资金费率和成交假设；
- 样本内、验证集、样本外窗口；
- 回测输出、异常、失败和可复现命令；
- 策略作者是人、Agent 还是混合。

Minara 的策略 permalink 和版本历史方向正确。当前项目可采用本地内容哈希，不必依赖第三方 SaaS。

### 8.5 三段绩效必须分开展示

任何策略页面固定展示：

1. **Backtest In-Sample**：开发和调参所见数据；
2. **Publish-Forward OOS**：策略冻结之后、尚未用于调参的新数据；
3. **Paper/Live Actual**：实际信号、实际可得报价、真实成交或严格标注的 Paper 代理。

不能把三段拼成一条连续“漂亮曲线”。若策略更新，发布后样本外计数重新开始。

### 8.6 同一信号核心，分离执行适配器

Minara 宣传 Paper 与 Live 使用同一引擎，这个方向可以借鉴，但当前项目不应强行让代理 K 线和真实链上成交完全等价。更准确的设计是：

- 信号和仓位规则使用同一确定性核心；
- Backtest、Paper、Shadow、Live 使用不同执行适配器；
- 每个适配器明确记录报价来源、成交模型和缺失成本；
- 只有真实双向、金额匹配、时间匹配报价才能支持 Live 收益判断。

### 8.7 策略级风险信封

借鉴“子账户/范围授权”的思想，但先在当前系统内部实现：

- 允许标的集合；
- 单笔和累计名义金额；
- 最大持仓数；
- 每日损失和最大回撤；
- 授权有效期；
- 允许的执行路由；
- 强制人工批准是否仍然有效。

这个信封只能收紧底层全局限制，不能放宽；过期、数据不完整、路由变化或标的身份变化时自动失效。

### 8.8 Skill 只负责表达，执行层负责安全

Agent Skill 可以规定“先展示报价，再请求批准”，但最终订单服务必须独立验证授权、报价、金额、标的、路由和时效。任何 `--yes`、Prompt 或配置项都不能跳过 Live 强制审批。

### 8.9 Last Known Good 研究页面

研究 Agent、数据源或模型失败时，不应生成看似完整的新报告。页面保留最后一次完整结果，同时明确显示：

- 旧结果时间；
- 本次失败的数据源和 Agent；
- 哪些结论因此不可更新；
- 是否禁止产生新的 Paper/Live proposal。

这比“部分数据也继续给结论”更适合金融场景。

## 9. 不建议照搬的部分

### 9.1 不直接集成 Minara 钱包或 Autopilot

原因包括中国大陆条款限制、签名架构文档不一致、核心服务闭源、用户交易和 Prompt 数据集中到第三方，以及 Autopilot 获得授权后可持续交易。若未来在合规地区重新评估，也必须先完成法律主体、权限撤销、数据删除、当前审计范围和故障停止机制的尽调。

### 9.2 不把代币化股票永续当作 ETF 轮动的等价替代

当前 ETF 轮动研究的经济含义是资产配置；换成永续后会新增资金费率、强平、预言机、部署方、24/7 薄流动性和基差风险。历史 ETF/FMP 回测不能直接迁移为链上永续收益预期。

### 9.3 不上线“自然语言到 Live”直通路径

自然语言可以生成研究草案和策略代码，但必须经过：静态校验、单元测试、确定性回放、成本压力测试、时间序列样本外、Paper forward，以及独立人工批准。Agent 不能自行解释测试失败并继续发布。

### 9.4 不采用策略市场跟投作为近期功能

Minara 的策略市场给创作者按实际利润分成，产品增长逻辑成立，但会产生选择偏差、收益展示偏差、拥挤交易和激励冲突。[^23] 当前项目样本仍少，优先建立可信证据，不应把策略传播速度放在验证之前。

### 9.5 不用厂商 benchmark 或胜率作为准入门槛

准入依据仍应是实际执行口径：金额和方向匹配的买卖报价、费用、Gas、深度/成交率、Profit Factor、最大回撤、尾部损失、MAE/MFE 和独立时间样本外，而不是模型答题分数、回测年化或小样本胜率。

## 10. 推荐落地路线

### P0：证据和资产语义，2 至 3 天

目标：不改交易，不接钱包，只统一研究证据。

- 定义 `research-run-manifest` 和 JSON Schema；
- 建立资产能力登记表，显式区分股票、ETF、RWA token、现货和永续；
- 给现有回测/Paper 报告补 `data_cutoff`、`source_hash`、`code_hash`、`execution_assumption`；
- 页面固定展示数据缺口和代理标签。

验收标准：任意结论都能追到来源、有效时点、策略版本和执行假设；未知不能自动填成 0。

### P1：只读多 Agent 研究，约 1 周

目标：复制 Minara 最有价值的研究体验，不产生订单提案。

- 按任务启用基本面、宏观、情绪、技术/微观结构角色；
- 所有输出采用结构化 Claim/Evidence/Counterargument；
- 管理 Agent 只汇总分歧，不用投票覆盖分歧；
- 数据源失败时生成不完整状态，不生成伪完整结论；
- 整条链路保持 `research_only`，不读取钱包、不写交易状态。

验收标准：随机抽取 20 条主张，100% 有证据 ID 和时间戳；关键来源缺失时最终建议必须降级或拒绝。

### P2：策略版本账本和可复现回测，1 至 2 周

目标：每个策略结论可以重跑、比较和冻结。

- 生成不可变 `strategy_artifact_id`；
- 同一信号核心连接 Backtest、Paper 和 Shadow 执行适配器；
- 保存交易成本、滑点、资金费率、数据覆盖和失败记录；
- 分开显示样本内、冻结后 OOS、Paper forward；
- 每次 Agent 修改策略都生成父子差异，不覆盖旧版本。

验收标准：同一数据哈希和配置哈希重跑结果一致；策略改版后 OOS 从新版本发布时间重新累计。

### P3：研究与 Paper 控制台，1 至 2 周

目标：把证据、分歧、策略版本和跟踪结果放在同一页面。

- 左侧显示任务和策略版本；
- 主区显示结论、来源和分歧；
- 单独显示数据质量、执行代理类型和最近成功更新时间；
- Paper、Shadow、Live 指标永不合并；
- 失败时展示 Last Known Good，不伪造新状态。

验收标准：用户无需看日志即可判断“这是回测、Paper、Shadow 还是真实成交”，并能找到每个数字的口径。

### P4：仅在长期 Paper 达标后评估有限自动化

不建议现在移除人工审批。若未来评估自动化，只允许短期、可撤销、策略级风险信封，并继续受全局金额、损失、标的和路由限制。任何越界、数据过期、身份变化或停止状态不明确都要失败关闭。

进入评估至少需要：

- 数据完整度和双向报价成功率均不低于 95%；
- 中位全成本不高于 0.45%，P90 不高于 0.70%；
- 至少 20 个独立候选，且不是重叠持仓造成的伪样本；
- 扣除全成本后平均收益为正，Profit Factor 不低于 1.1；
- 回撤和尾部损失不劣化；
- 至少 5 个后续交易日的冻结后样本外证据。

这些只是进入下一轮评估的最低门槛，不是自动转 Live 的授权。

## 11. 直接使用 Minara 前的尽调清单

若使用人不在受限地区，并且未来仍考虑 Minara，只读试用前至少书面确认：

1. 签约法律主体、注册地址、监管和争议解决主体；
2. 中国大陆及其他地区限制的实际执行规则；
3. 当前生产签名架构究竟是 Privy、Particle、EIP-7702/KMS 还是组合；
4. Minara、钱包供应商和 Agent 各自能发起什么交易；
5. 授权的链、合约、金额、期限和撤销方式；
6. Autopilot 停止请求到真正 `STOPPED` 的最大时间和故障处置；
7. 当前 Harness、Strategy Studio、TEE 和 Autopilot 的独立审计报告；
8. 策略代码、Prompt、持仓和执行日志的保留、导出和删除政策；
9. 回测数据版本、公司行动、退市、成分历史和幸存者偏差处理；
10. TradFi 历史数据到 HIP-3 永续执行的基差、资金费率和深度校准；
11. 每个 HIP-3 市场的部署方、预言机、杠杆、结算和流动性来源；
12. 一组可独立重跑、包含失败案例的策略复现包。

在这些问题没有明确答案之前，只适合把它当作产品设计参考，不适合托管真实资金或私有策略。

## 12. 最终建议

**Go：本地实现 Minara 风格的“可审计研究工作台”。** 第一阶段只做 Research Run Manifest、资产能力登记、结构化多 Agent 证据和策略版本账本；第二阶段接现有 Paper/Shadow，不碰钱包和 Live。

**No-Go：直接接入 Minara、复制其 Autopilot 或把美股永续纳入当前 ETF 策略。** 主要原因不是产品一定无效，而是法律适用性、资产语义、闭源控制面、签名/隐私文档漂移和独立收益证据不足。

一句话概括：**借鉴它如何组织研究，不借用它替你承担交易判断和资金权限。**

## Sources

[^1]: ayi_ainotes，原始 X 帖子，2026-09-11。[https://x.com/ayi_ainotes/status/2098346305319743777](https://x.com/ayi_ainotes/status/2098346305319743777)
[^2]: Minara, “Introducing Minara Harness: A General-Purpose Agent Built to Master Finance.” [https://minara.ai/blog/introducing-minara-harness/](https://minara.ai/blog/introducing-minara-harness/)
[^3]: Minara Documentation, “Trading Autopilot.” [https://minara.ai/docs/features/trading-autopilot](https://minara.ai/docs/features/trading-autopilot)
[^4]: Minara, “Strategy Studio” product manifest. [https://minara.ai/manifest.json/product/strategy-studio](https://minara.ai/manifest.json/product/strategy-studio)
[^5]: Minara Documentation, “Create Time-Series Strategies,” fixed commit `e1d9e515`. [https://github.com/Minara-AI/Documentation/blob/e1d9e515f603fb8a0146e9a61dd90227b8b329e3/trade/strategy-studio/create-time-series-strategies.md](https://github.com/Minara-AI/Documentation/blob/e1d9e515f603fb8a0146e9a61dd90227b8b329e3/trade/strategy-studio/create-time-series-strategies.md)
[^6]: Minara Documentation, “Create Cross-Sectional Strategies,” fixed commit `e1d9e515`. [https://github.com/Minara-AI/Documentation/blob/e1d9e515f603fb8a0146e9a61dd90227b8b329e3/trade/strategy-studio/create-cross-sectional-strategies.md](https://github.com/Minara-AI/Documentation/blob/e1d9e515f603fb8a0146e9a61dd90227b8b329e3/trade/strategy-studio/create-cross-sectional-strategies.md)
[^7]: Minara Documentation, “Evaluate a Strategy,” fixed commit `e1d9e515`. [https://github.com/Minara-AI/Documentation/blob/e1d9e515f603fb8a0146e9a61dd90227b8b329e3/trade/strategy-market/evaluate-a-strategy.md](https://github.com/Minara-AI/Documentation/blob/e1d9e515f603fb8a0146e9a61dd90227b8b329e3/trade/strategy-market/evaluate-a-strategy.md)
[^8]: Minara Documentation, “Stocks,” fixed commit `e1d9e515`. [https://github.com/Minara-AI/Documentation/blob/e1d9e515f603fb8a0146e9a61dd90227b8b329e3/trade/trade-assets/stocks.md](https://github.com/Minara-AI/Documentation/blob/e1d9e515f603fb8a0146e9a61dd90227b8b329e3/trade/trade-assets/stocks.md)
[^9]: Minara, “Strategy Code Privacy with AWS Nitro Enclaves.” [https://minara.ai/blog/strategy-code-privacy-aws-nitro-enclaves/](https://minara.ai/blog/strategy-code-privacy-aws-nitro-enclaves/)
[^10]: Minara Documentation, “Wallet Security,” fixed commit `e1d9e515`. [https://github.com/Minara-AI/Documentation/blob/e1d9e515f603fb8a0146e9a61dd90227b8b329e3/technology/wallet-security.md](https://github.com/Minara-AI/Documentation/blob/e1d9e515f603fb8a0146e9a61dd90227b8b329e3/technology/wallet-security.md)
[^11]: SlowMist, “Minara AI Audit Report,” audit started 2025-07-30. [https://static.minara.ai/audit/Minara%20AI%20-%20SlowMist%20Audit%20Report.pdf](https://static.minara.ai/audit/Minara%20AI%20-%20SlowMist%20Audit%20Report.pdf)
[^12]: Minara, “Terms of Use,” last updated 2026-06-18. [https://minara.ai/doc/terms-of-use.pdf](https://minara.ai/doc/terms-of-use.pdf)
[^13]: Minara, “Privacy Policy,” last updated 2026-05-11. [https://minara.ai/doc/privacy-policy.pdf](https://minara.ai/doc/privacy-policy.pdf)
[^14]: Circle Ventures, ecosystem portfolio; Circle Alliance, Minara.ai partner page. [https://www.circle.com/ventures-ecosystem](https://www.circle.com/ventures-ecosystem), [https://partners.circle.com/partner/minaraai](https://partners.circle.com/partner/minaraai)
[^15]: Minara, “From 10.5% to 68.5%: How the Harness Reshapes AI Performance.” [https://minara.ai/blog/from-10-5-to-68-5-how-the-harness-reshapes-ai-performance/](https://minara.ai/blog/from-10-5-to-68-5-how-the-harness-reshapes-ai-performance/)
[^16]: Minara CLI README, transaction confirmation section, fixed commit `25e64ae6`. [https://github.com/Minara-AI/minara-cli/blob/25e64ae6f14561dddabb51c1edbcd141866c4456/README.md#L331-L356](https://github.com/Minara-AI/minara-cli/blob/25e64ae6f14561dddabb51c1edbcd141866c4456/README.md#L331-L356)
[^17]: Minara CLI `swap.ts`, fixed commit `25e64ae6`. [https://github.com/Minara-AI/minara-cli/blob/25e64ae6f14561dddabb51c1edbcd141866c4456/src/commands/swap.ts#L123-L136](https://github.com/Minara-AI/minara-cli/blob/25e64ae6f14561dddabb51c1edbcd141866c4456/src/commands/swap.ts#L123-L136)
[^18]: Minara CLI shared confirmation utility, fixed commit `25e64ae6`. [https://github.com/Minara-AI/minara-cli/blob/25e64ae6f14561dddabb51c1edbcd141866c4456/src/utils.ts#L339-L356](https://github.com/Minara-AI/minara-cli/blob/25e64ae6f14561dddabb51c1edbcd141866c4456/src/utils.ts#L339-L356)
[^19]: Minara Agent Skill, transaction confirmation requirements, fixed commit `b93aba10`. [https://github.com/Minara-AI/minara-skills/blob/b93aba1029827c37cf5ad82b19bfa8c289912091/skills/minara/SKILL.md#L95-L157](https://github.com/Minara-AI/minara-skills/blob/b93aba1029827c37cf5ad82b19bfa8c289912091/skills/minara/SKILL.md#L95-L157)
[^20]: Hyperliquid, “HIP-3: Builder-Deployed Perpetuals.” [https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals)
[^21]: Hyperliquid, perpetuals info endpoint. 本次用 `POST https://api.hyperliquid.xyz/info` 和 `{"type":"perpDexs"}` 做只读查询，访问日期 2026-09-13。[https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
[^22]: Minara Documentation, “Tools Integration.” [https://minara.ai/docs/technology/tools-integration](https://minara.ai/docs/technology/tools-integration)
[^23]: Minara, “Wizard Strategy Creator Rewards.” [https://minara.ai/blog/minara-wizard-strategy-creator-rewards/](https://minara.ai/blog/minara-wizard-strategy-creator-rewards/)
[^24]: Minara GitHub organization. 截至调研日公开仓库包括 CLI、Skills 和 Documentation，未见 Harness 核心服务端实现。[https://github.com/Minara-AI](https://github.com/Minara-AI)
