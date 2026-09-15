# 基金经理日报执行手册

工作目录：`/Users/henry/projects/binance`。角色定义在同目录 `SOUL.md`。由 Codex 本任务的每日定时跟进执行；没有新增付费 API 依赖。

## 每次执行

1. 阅读 SOUL.md，以 Asia/Shanghai 确定今天日期。执行 `node scripts/run-fund-manager.mjs status`；SENT 就结束。若 SENDING，先读取本地同日 report.md 与回执，只能原文重试；超过 50 分钟的不确定结果需查飞书后处理。
2. 执行 `node scripts/run-fund-manager.mjs collect`。该命令通过已有 SSH 通道读取 VPS 配置、状态、Paper 和 Shadow，并调用既有每日回溯模块重建当期实盘证据；不运行 Bot 或 Paper 策略。读取输出中的 evidence.json，核查数据质量。若采集失败，保留失败原因并写数据降级版，不能拿旧快照冒充当天。
3. 阅读最近一份正式 `state/fund-manager/*/report.md`（不要把 preview.md 当上一日报）。联网核实全球动态、美联储、黄金、美股和重大事件，保存带来源链接、时间戳的摘要到同日 `research.md`。以内部证据为业绩依据。
4. 按 SOUL.md 的 10 个标题撰写内部内容稿 `state/fund-manager/YYYY-MM-DD/report.md`。正式交付格式是 HTML，发送命令会自动排版和归档，不要直接让模型生成可执行脚本。核对金额/单位、实盘与 Paper 分离、数据时效、事件时间、结论与反证；不超过 16 KB。检索应在 08:40 前结束。
5. 执行 `node scripts/run-fund-manager.mjs send`。命令将完整 HTML 归档到系统 `/fund-manager`，并通过现有飞书发送经理结论卡片与完整 HTML 报告按钮；生产凭据留在 VPS，发送进程以 binancebot 身份运行。确认 `status=SENT`、`format=html`、`reportUrl`、`messageId`（App 渠道）及时间。重复运行会跳过已发送日期。本地同时保存 report.html。
6. 最多两次同文重试，间隔约 30 秒，且遵守 SENDING 的不确定结果规则。发送成功后记入当天 operation.md；正常成功无需在 Codex 重复通知用户。失败或需要用户处理时在当前任务明确通知。静默只控制 Codex 通知，不能省略每天飞书日报。

若现在已经过 09:00，按真实时间生成“延迟补报”，不要伪造按时发送。当前日期已成功发送则不补发。初次验收用独立 `preview.md` 和 `node scripts/run-fund-manager.mjs preview`，不会占用正式日报去重记录。

## 验证与运行记录

- `node --test test/trade-review-reader.test.mjs test/trade-review.test.mjs test/fund-manager.test.mjs`
- 生产回溯原来一次读取整个 action-trace 导致 OOM，新增逐行读取器保留同一回溯语义。定时复盘仍由原服务负责；日报采集也复用该模块。
- 本地报告/证据：`state/fund-manager/YYYY-MM-DD/`；服务器发送归档/回执：`state/fund-manager/YYYY-MM-DD-daily.*`。
- 系统入口：`/fund-manager`，沿用 Dashboard 登录；可用 date 和 edition 选择历史日报/预览。飞书提供原生卡片和 HTML 页面入口，HTML 不在消息正文中执行。
- 仅给旧归档补 HTML、不重发消息：`node scripts/run-fund-manager.mjs publish YYYY-MM-DD 报告.md`；预览加 `--preview`，必须与原归档正文一致。
- 当前仍由本地 Codex 撰写与调度。用户询问了 OpenAI API 迁移，但尚未提供 API Key；接入后需把撰写和调度部署到 VPS、启用联网检索并验证真实发送，成功后才停用本地自动任务。API 费用独立计量。
- 锁文件只表示正在发送或进程中断，不能直接当作已发送。排障时先核对进程和消息回执再清理本角色自己的锁。
- 不改 Live 权限、仓位、钱包、数据库、原策略配置或其他未提交工作。
