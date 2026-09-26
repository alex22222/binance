# 项目整体审查与改进建议

日期：2026-09-27。审查范围：当前分支 `codex/linux-server-deployment`（bbc6686）的源代码、测试、部署模板与 `docs/` 研究文档。`npm test` 结果：314/314 通过。

## 结论

工程质量明显高于一般个人交易机器人。主要风险不在代码风格，而在于：

1. Live 策略尚未证明有效；
2. 生产环境的安全承诺已被削弱；
3. 线上部署与代码仓库不一致；
4. 最关键的编排代码没有直接测试。

## 做得好的地方

- **失败关闭的设计贯穿始终**：下单前先落盘 order intent，swap 绝不重试，紧急停止跨重启持久，拒绝过期报价和报价漂移，Live 需要 `mode: live` 与 `BOT_LIVE=1` 双门禁。
- **可审计性强**：JSONL 动作审计（已脱敏）、runId / cycleId 贯穿、可回放的行情记录。
- **研究口径诚实**：文档清楚区分 Paper、Shadow、回测代理和 Live，并主动标注证据不足之处。

## 需要修正的问题（按优先级）

### 1. Live 策略没有达到项目自己的晋级标准

- [2026-09-11-us-etf-rotation-backtest.md](2026-09-11-us-etf-rotation-backtest.md) 显示轮动年化 4.57%，SPY 为 10.86%，文档自己写明"当前规则不具备实盘候选资格"。
- [2026-09-18-weekly-etf-liquidity-cutover.md](2026-09-18-weekly-etf-liquidity-cutover.md) 中新组合代理为年化 7.37%，同期静态 VTI / VTV / SPY 约 17%。
- 双动量防守版本从未带现金门槛单独回测；09-15 才开始 Paper，按 09-26 记录，线上已持有 QQQ 且自动审批开启。

建议：

- 退回 Paper，或明确将其定位为"带回撤过滤的市场暴露"；
- 使用同一成本模型，以链上买入持有 VTIon 作为基准；
- 将已有的 readiness 晋级门槛（≥100 个信号、PF ≥ 1.1）推广到所有策略，作为进入 Live 的前提。

### 2. 自动审批违背了 README 的安全承诺

- [bot.mjs:901](../src/bot.mjs) 在自动审批时自动填写 `auditUnavailableAcknowledged`。
- [README.md:494](../README.md) 写明该确认"cannot be pre-accepted"（不可预先接受）。
- 叠加 `allowUnsupportedAuditForOfficialRwa: true`，无安全审计的代币可在无人参与的情况下成交。

建议：对审计不可用的标的禁用自动审批，或同步修改 README 的承诺。

### 3. 公网登录没有暴力破解防护

- `POST /login`（[serve-live-dashboard.mjs:183](../scripts/serve-live-dashboard.mjs)）公网可达，没有限速或锁定。
- 同一个密码控制交易审批、自动审批开关和钱包登录流程。

建议：在 Caddy 或应用层加限速；更好的做法是把 Dashboard 放在 Tailscale / Cloudflare Access 之后，或增加第二因素。

### 4. 线上部署与任何提交都不一致

- 09-26 审查记录显示，服务器上的 Dashboard 入口文件采用"线上基线 + 本次增量"的手工拼接方式发布。
- 当前分支领先声明的主分支 `agent/traceable-rwa-shadow-bot` 63 个提交，主分支没有更新。

建议：只部署带标签的提交；在 `/health` 暴露已部署的 commit SHA；指定唯一的生产分支。

### 5. 最危险的代码没有直接测试

- `src/bot.mjs` 约 3,300 行，含模块级可变状态（`let currentCycleId`、`traceAction` 等），没有任何测试导入它；目前只有辅助函数有测试。
- 下单提交、不确定订单对账、审批流程、写入 intent 与 swap 之间的紧急停止都在其中。

建议：

- 把下单循环抽成独立模块，以参数注入 `baw`、时钟和文件读写；
- 增加场景测试：swap 抛错 → 标记 AMBIGUOUS → 对账匹配 0 / 1 / 2 笔；周期中审批过期；intent 落盘后触发紧急停止。

状态（2026-09-27 已处理）：下单提交、不确定订单对账、审批消费与紧急停止检查已抽到 `src/order-execution.mjs`，依赖注入，场景测试见 `test/order-execution.test.mjs`。测试发现：intent 落盘后、swap 前触发紧急停止时，原逻辑会把订单标为 AMBIGUOUS，恢复后必然进入 REVIEW_REQUIRED 并阻塞新订单；现已改为确定未提交时清除该 intent。

### 6. Live 信号依赖单一的非官方数据源

- 周度决策通过伪造浏览器 User-Agent 调用 Yahoo 非官方 chart API（[weekly-etf-live.mjs:63](../src/weekly-etf-live.mjs)）。
- 若第一个交易日全天失败，整周被跳过。

建议：增加第二数据源交叉校验，或至少在周度决策缺失时告警。

### 7. 系统规模远超资金规模

约 15.7k 行源码、12 个策略、8 个 systemd timer，另有 fund-manager、周度研究、Polymarket 与 GDELT 数据源，运行在可用内存约 488 MiB 的服务器上，管理的是 50 USDT 的仓位。

建议：只保留支撑实际决策的部分；归档已退役的策略，停用无人使用其输出的 timer。

### 8. 仓库卫生

- 没有 CI（缺少 `.github/`）：增加每次 push 运行 `npm test` 的 workflow。
- README 已过时：写着"最多三个仓位"，而配置为 `maxOpenPositions: 1`；描述的是日内动量策略，而当前 Live 是周频 ETF 轮动。
- AI 会话笔记与正式文档混放：根目录的 `design-qa.md`，以及包含 `/Users/henry/.codex/...` 路径和"用户已明确选择……"等内容的文档。建议移到单独目录，或不纳入 git。

## 行动顺序

1. **本周**：处理第 1、2 项，因为真实资金当前已暴露。
2. **随后**：第 5 项对代码本身的收益最大。
3. 其余各项按上述顺序逐步处理。
