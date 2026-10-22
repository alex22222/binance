# 海龟 Paper 旧仓本金与历史收益纠正

## 问题与修复口径

2026-10-05 的 QQQ 模拟开仓金额为 50 USDT，数量为 0.06624167818955788。后续全局 `maxTradeUsdt` 改为 250 时，旧代码把新金额同时用于旧仓估值、平仓本金扣除和成本计算；成本率也由 1% 漂移为 0.84%。2026-10-14 平仓记录因此误报 -203.35806695892555 USDT（-81.34322678357022%）。

修复后，每笔仓位固定使用开仓 `notionalUsdt` 与 `roundTripCostPct`，并将成本率写入开仓事件。旧格式仓位若没有成本率，可从其已有 gross/net return 差值恢复；缺失或本金与数量不一致则报错，不能套用当前配置。后续新开仓仍使用当时配置，不改变信号、仓位数量、出入场条件。

历史纠正从原始 BUY 事件核对开仓金额、数量和价格，再由最早保留的估值记录反算原成本率。本次两笔交易的第一条估值均在开仓后约五分钟，均恢复出 1%。这些成本是 Paper 建模假设。

| 已平仓标的 | 原净盈亏 USDT | 纠正后净盈亏 USDT | 纠正后单笔收益率 |
|---|---:|---:|---:|
| DBC | -1.8698675372 | -1.8698675372 | -3.7397350744% |
| QQQ | -203.3580669589 | -1.7580669589 | -3.5161339179% |
| 累计 | -205.2279344961 | -3.6279344961 | 不推断账户收益率 |

累计模型成本由 2.6 USDT 改为 1 USDT。记录没有组合初始资金及现金流账户，不能把逐笔收益率相加当作组合收益率。

## 纠正范围与恢复

`src/turtle-paper-repair.mjs` 核对 BUY/MARK/SELL 的顺序、数量、价格、时间与 latest 中的交易明细，重算历史估值、交易盈亏、峰谷净收益及累计成本。原始成交时间、价格、数量、止损原因和事件条数不变；不拉取新行情，不重做信号，不生成补录成交。

`scripts/repair-turtle-paper-accounting.mjs` 默认仅预览。应用时必须传入预览的两个 SHA256，并先生成原文件备份与 `repair-report.json`。重复执行应为无变更。迁移两个文件期间须停海龟 Paper timer，并确认其 service 未运行；崩溃或部分失败时，先检查报告状态与输出哈希，必要时用同一备份恢复 latest 和 events 两个文件。

```sh
node scripts/repair-turtle-paper-accounting.mjs --directory /path/to/state/turtle-paper
node scripts/repair-turtle-paper-accounting.mjs --directory /path/to/state/turtle-paper \
  --apply --expect-state-sha256 PREVIEW_STATE_HASH --expect-events-sha256 PREVIEW_EVENTS_HASH \
  --backup-directory /path/to/reviewed-backup
```

原始证据归档、已发送日报和服务历史日志保留为当时快照，不覆盖；修复报告记录来源、前后值和文件哈希。当前 Dashboard 与后续日报从纠正后的账本读取。

## 独立发布

生产实盘授权哈希覆盖顶层 `src/*.mjs`，因此不覆盖生产顶层模块。部署到 `releases/turtle-paper-accounting-20261017/`，包含运行与修复脚本及所有递归相对导入依赖。`deploy/binance-agentic-turtle-paper.release.conf` 使用明确版本路径及绝对配置、状态路径，仅安装到海龟 Paper service 的 drop-in。保持实盘 Bot、Dashboard 进程及实盘配置不变。

## 验证记录

- 基线：海龟、估值与策略研究相关 14 项测试通过。
- 回归：先确认 50→250 USDT、成本率变化、旧仓恢复与零成本案例失败，再修复通过。
- 历史：预览识别 217 条待纠正事件；DBC 金额不变，QQQ 和累计值按上表恢复。
- 本地全量 529/529 通过；最后的资本校验收紧后，相关 20/20 再次通过。
- 服务器独立发布目录的全部文件 SHA256 校验通过，相关测试 20/20 通过，Linux preflight 成功。
- 2026-10-17 11:54 UTC（北京时间 19:54）应用迁移。原始账本及 `repair-report.json` 位于 `/var/backups/binance-agentic-stock-bot/turtle-paper-accounting-20261017/ledger/`；原 service/timer 也保存在上级目录。
- 迁移纠正 217 条事件，保留原 3023 条事件的次序和交易事实；新版本实际运行追加一条周末 `PAPER_MARKET_CLOSED`，未生成交易。再次预览 `changed=false`，无待纠正交易或事件。
- 使用独立于迁移模块的 `开仓数量 ×（卖出/估值价格 − 开仓价格）− 开仓本金 × 1%` 公式，核验全部 1530 条历史估值与两笔平仓；累计金额、成本、交易事实及原始非财务事件全部一致。
- systemd 实际执行明确版本路径，`Result=success`、`ExecMainStatus=0`；timer 为 active，下次触发为 10 月 19 日 13:00 UTC，市场时段检查仍由原逻辑决定。
- 认证 Dashboard `/health` 与 `/api/strategy-research` 均返回 200；海龟状态为 AVAILABLE，平仓两笔，累计 `-3.6279344961024265` USDT、成本 `1` USDT、当前无仓。公网未登录访问返回 303 `/login`。
- 实盘 Bot PID `4006730`、Dashboard PID `4133618` 保持原值。顶层源码哈希 `f42b7f29af0826b645c4ecebd885ca0f222554d7d48dc37e5aafd9da2c5678b5`、配置、策略/自动审批控制与实盘持仓内容哈希均保持原值。
