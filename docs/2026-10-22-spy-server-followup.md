# SPY 开盘核验迁移到服务器

范围：仅迁移2026-10-22北京时间21:45（UTC13:45）的单次只读核验及现有飞书通知；服务器验收后取消聊天 heartbeat `spy`。不实施自动续签，不下单、不审批、不改策略/风险/授权，不重启交易服务。

## 验收循环

触发：本次用户确认迁移。停止条件：相关测试通过、独立复核通过、服务器隔离权限/哈希与飞书业务回执通过、单次timer的下一次时间正确，最后删除本地跟进。进度保存于本文件，服务器证据写入独立检查目录。

- [x] 失败用例：提交不算成交，旧记录不算今晚成交，证据缺失不能判空仓或归因。
- [x] 独立检查器：流式读取完整相关日志，核对真实终态/持仓，保留明确阻断与未知边界。
- [x] 发送锁、固定去重ID、持久化报告及飞书业务回执。
- [x] 独立发布和systemd单次timer，禁止写生产状态及访问钱包/交易环境。
- [x] 回归、独立复核与服务器预验收通知通过。
- [x] 受保护哈希与服务PID不变，下一次触发为UTC2026-10-22 13:45。
- [x] 服务器验收后取消本地heartbeat `spy`，保留A/F等其他任务。

## 安全边界

检查器只解释已存在的证据，不调用交易/钱包CLI或重算/重置周信号。缺少明确的入场阻断日志时保留“原因未确认”，不会把授权有效误报成执行成功。独立通知环境仅包含现有飞书字段，不复制钱包或Dashboard凭据。预验收通知明确标为部署测试，不能当作开盘后成交确认。

## 本地验证

新增16项用例，相关回归35/35；完整测试545/545通过。独立复核发现并复现的精确数量空值误匹配、延迟跨日执行、旧cycle及持仓/终态冲突均已修正。超过计划15分钟的执行只报告延迟，不能补造开盘检查。

本机`preflight:linux`因未加载生产私密环境、macOS平台而未通过；不为此复制生产凭据，改在服务器原环境执行只读检查。生产状态目录700及文件600保持不变；检查器沿用读取身份，但单独挂载只读文件系统、屏蔽整个`/proc`，禁止进程内存/FD读取与外发信号调用，并用非敏感dummy做远程阳性/阴性对照后验收。

## 服务器验收与接管

2026-10-22北京时间11:30–11:32完成验收。独立release位于`/opt/binance-agentic-spy-open-check/releases/20261022-v1`，当前链接为该目录；通知环境单独保存且只有3个现有飞书App字段（root:binancebot，640）。不复制钱包会话、交易开关或Dashboard密码。

- `binance-agentic-spy-open-check.timer`：enabled、active/waiting；下一次UTC2026-10-22 13:45:00，即北京时间21:45；目标`binance-agentic-spy-open-check@scheduled.service`。仅此一次，不是每日任务。正式检查尚未执行，也无`scheduled.receipt.json`。
- 预验收服务：`Result=success / ExecMainStatus=0`，完成后inactive是正常。最终限制下重复运行成功，并读到`duplicateSkipped=true`，没有再次发送。
- 飞书：`preflight.receipt.json`为`SENT/app`；业务回执`om_x100b62ac69786ca4cfb00c92ddf352b`，北京时间11:26:51发送。消息归档哈希一致；通知明确是部署测试，非成交结论。
- 隔离：v4对照在root持有0755目录中、使用清空环境的dummy；沙箱外4项阳性成立，沙箱内7项防护全部成立，exit0。生产状态不可写、交易env与钱包目录不可访问；专属状态目录可写。初次发现的`/run`写入漏洞已修正，失败证据保留；测试没有读取真实秘密或向交易Bot发信号。
- 身份与运行：Live代码哈希仍为`f42b7f29af0826b645c4ecebd885ca0f222554d7d48dc37e5aafd9da2c5678b5`，9个受保护文件哈希不变（含原config/env/授权/控制与A/F单元）。Bot PID4006730、Dashboard PID4133618、Caddy PID2355857不变；原授权仍allowed。
- 健康：服务器Linux preflight通过；认证后Dashboard `/health`为200/ok，公网未认证仍303到登录页。
- 完成服务器验收后，应用工具确认删除本地heartbeat `spy`（`deleteStatus=deleted`）。A/F及其他本地/服务器任务未删除或调整。

服务器验收证据保存于`/var/backups/binance-agentic-stock-bot/spy-open-check-2026-10-22T03-24-42-747Z/`（`before.json / acceptance.json / final-health.json / completion.json`及新单元修正前备份）；检查报告、消息和回执在`/var/lib/binance-agentic-spy-open-check/`。`completion.json`确认验收后删除本地任务及本地任务文件已不存在；原`acceptance.json`保留删除前的阶段记录。

本次没有提交、push、重启交易服务、下单或自动续签。今晚只读核验开始后还需完成日志核对与飞书发送，可能晚于21:45约1–2分钟收到结果。通知会区分已确认成交、未买入/明确阻断、在途和证据不足；当前代码静默分支造成的原因未知会如实标注，不补买、不猜测。
