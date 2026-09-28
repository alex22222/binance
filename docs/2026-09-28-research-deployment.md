# A/F 独立研究定时部署

## 授权与范围

2026-09-28 用户授权“提交，部署，开启定时”。只发布首批 A（月度历史研究）和 F（公开观察采集）代码及其隔离调度，不代表六条路线全部完成，也不授权切换 Live、下单、登录钱包或修改现有风险规则。

运行成功不等于研究通过：A 的历史门槛失败照常归档；F 没有真实双向报价、期货归一化参考与公司行动证据时，仍是 `OBSERVATION_ONLY`，有效跨夜样本为零。重复历史回测不计为独立月末前向样本。此次没有接入 Dashboard 路由，也没有发送飞书报告。

## 发布结构与资源

- `/opt/binance-agentic-research/releases/<commit>`：从明确提交打包的独立代码及传递依赖；root 所有，研究用户不可改写。
- `/opt/binance-agentic-research/current`：当前发布软链接。
- `/var/lib/binance-agentic-research`：专用 `binanceresearch` 账号的数据目录；发布下的 `state/research` 链接到这里。不复制本地状态、钱包或生产环境变量。
- 两个 oneshot 服务共用非阻塞文件锁，最多同时运行一个研究任务。退出码 75 代表锁冲突跳过，不代表采集成功，须结合回执判断。
- 每个服务 CPU 上限 25%、内存软上限 192 MiB／硬上限 256 MiB、Node 堆上限 128 MiB；A 最长 6 分钟、F 最长 2 分钟。没有自动高频重试。
- `ProtectSystem=strict`、只写研究数据目录；显式禁止访问现有 Bot 目录、环境文件和钱包目录；不加载交易环境文件。
- `scheduled/monthly.json`、`scheduled/offhours.json` 原子记录 RUNNING → SUCCEEDED／FAILED；原始研究产物按唯一运行 ID 保留。进程被 OOM／超时杀死时，结合 systemd Result 判断未完成回执，不能把 RUNNING 当成功。

## 排期

以 systemd 的 `America/New_York` 为准，自动处理夏令时。

| 任务 | 纽约时间 | 北京时间（夏令时／冬令时） | 补跑规则 |
| --- | --- | --- | --- |
| A 月度历史更新 | 每月 1 日 06:10 | 当日 18:10／19:10 | 宕机恢复最多触发一次最新研究，不伪造遗漏月份的独立决策 |
| F 开盘前 | 周一至周五 09:20 | 当日 21:20／22:20 | 不补录过期快照 |
| F 开盘后 | 周一至周五 09:35 | 当日 21:35／22:35 | 不补录过期快照 |
| F 收盘后 | 周一至周五 16:10 | 次日 04:10／05:10 | 不补录过期快照 |
| F 晚间 | 周一至周五 20:00 | 次日 08:00／09:00 | 不补录过期快照 |

F 节假日也允许记录真实“关闭”状态，不能算交易日或可比较样本；提前收盘日 16:10 不是“收盘十分钟后”。这是低频基础观测排期，不是高频预测数据或有效跨夜报价验证的替代品。历史达到 1000 个快照／64 MiB 时停止并要求保留归档，不自动删除。按每天四次约一年以内需要处理存储上限。

另设本聊天每日北京时间 10:00 的只读巡检：检查回执、服务结果、下一次排期、研究证据变化；状态无变化时静默。服务器采集不依赖聊天或本地电脑在线；聊天巡检依赖 Codex 调度可用。

## 验证与回退

发布前运行全量测试；Linux 检查单元与时区排期、生产 preflight，保留保护状态摘要和文件哈希。新版本先手动执行两个隔离服务，确认真实产物与回执，再开启定时器。正常 oneshot 执行后为 inactive，不能仅据此判定故障。

回退只停止并禁用 `binance-agentic-monthly-research.timer` 与 `binance-agentic-offhours-research.timer`，等研究任务退出，再按备份恢复这四个单元及 research/current。所有研究证据保留；不重启 Bot、Dashboard、Caddy，不回滚交易状态或钱包。

## 已上线验收（2026-09-28 15:24 UTC）

- 发布提交：`d96e058e50bdec21354bd9d1eb3989aefac8ae00`，已推送 `origin/codex/linux-server-deployment`。本节为后续文档回执，不要求改动已冻结的运行发布。
- 发布包 SHA-256：`0fc22d5334d469bdb2e6c692254f27477208cfdff1cf433aa341c07860104dd7`。29 个明确选择的运行／依赖／测试／文档文件逐一校验，已安装四个单元与提交内容一致。
- 独立复核：静态部署无阻断；正常暂停的误报先通过失败测试复现再修复。最终本地全量 **384/384**，服务器 Node 22.23.1 隔离专项 **41/41**，Linux preflight 和 systemd 单元检查通过。
- A 首跑 `15:21:03–15:22:00 UTC`，`SUCCEEDED`、退出 0；CPU 用时 14.611 秒，256 MiB 硬上限内正常完成，未出现 OOM／超时。该主机在 oneshot 退出后返回 `MemoryPeak=[not set]`，没有把此值记成 0 或虚构精确峰值。
- A 原始数据截止 `2026-09-25`：VTI／QQQ／SPY／VTV 各 1692 行，SGOV 1589 行，各自缺失日为 0；原始数据、输入哈希及源码哈希一致。A1/A2 仍为 `HISTORICAL_GATE_FAILED`，独立前向月末样本仍为 0。
- F 首跑 `15:23:28–15:23:31 UTC`，`SUCCEEDED`、退出 0；6 次公开请求，0 错误。SPY／QQQ 两个 `regular` 观察均 `NO_QUOTE`，`validPairs=0`、`reviewEligible=false`。这是连通性验收，不是休市收敛验证。
- 两个定时器已 **enabled / active (waiting)**。首次自然触发尚未发生：F 下次为 `2026-09-28 20:10 UTC`（北京时间 **9 月 29 日 04:10**）；A 下次为 `2026-10-01 10:10 UTC`（北京时间 **10 月 1 日 18:10**）。跨 DST 验证：11 月 2 日纽约 09:20 对应 14:20 UTC。
- 聊天巡检 `a-f` 已 ACTIVE，绑定本聊天，每日北京时间 **10:00**；只读与异常／重大变化提醒，不重复通知已知 A 失败或 F 缺报价结论。尚未发生首次巡检。

### 真实产物与回退记录

数据根目录为 `/var/lib/binance-agentic-research`：

- A：`monthly-trend/2026-09-28T15-21-03-447Z-5a442c19/report.json` 与 `report.md`；报告 SHA-256 `6b0779b6362d1d3a7d8a943b6495556b4e6fb1600e666415b30efd7619d36750`。
- F：`offhours-basis/2026-09-28T15-23-31-100Z-0b7679c8-abeb-44e0-8bd7-8c8ff039793c.json`；内容校验哈希 `2a73e81c7d9758a7bbd9623c7dd0795384c67a424dbfb69eb6ee76ca1009a2a7`。
- 调度回执 ID：A `c9a5291b-2aad-444f-8ed4-388c46f5c57c`，F `5a4a7966-6b20-4260-bb22-13c66eeae07c`。
- 回退清单：`/var/backups/binance-agentic-stock-bot/2026-09-28T15-19-41-815Z-af-research-d96e058e/preinstall.json`。此次全部是新目录和新单元，清单记录原目标不存在；没有覆盖任何旧交易文件，不需要恢复旧钱包或交易状态。

### 受保护状态核验

15:14:49 与 15:24:25 UTC 前后比较：Bot 的 src／scripts／deploy 聚合哈希、生产 config、环境文件、审批开关、策略授权、QQQ 持仓身份／数量／成本摘要、待单／待审批、紧急停止及 Bot／Dashboard 单元哈希 **全部一致**。持仓报价等自然更新字段不要求冻结；未读写钱包内容。

Bot／Dashboard／Caddy PID 分别仍为 `3202173 / 3202140 / 2355857`，均 active、NRestarts=0。认证 `/health` 为 HTTP 200、`status=ok`；公网未认证 `/strategies` 为 HTTP 303 → `/login`。没有新的交易服务错误；观察时待单、待审批为空，紧急停止为 false。

本轮依照 deploy-binance-vps 的精确发布与保护状态规则、Loop Engineering 的独立复核及实际产物验收、Binance 证券信息技能的公开接口与身份／乘数边界执行。后续补报价／期货参考／公司行动适配器需单独实现与验证，不由定时巡检自行改写。
