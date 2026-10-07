# BTC 风控雷达

日期：2026-10-01。来源：claude.ai 看板「BTC 风控雷达」及其定时任务「BTC 风控雷达更新」。

## 迁移内容

- 页面：Dashboard 菜单「BTC 风控」，路径 `/btc-radar`，需要登录。布局、配色、因子卡片、持仓标尺和评分走势沿用原看板。
- 数据：`GET /api/btc-radar`（需要登录）读取 `state/btc-radar/latest.json` 和 `history.json`，页面每 60 秒刷新一次。
- 计算：`scripts/run-btc-radar.mjs`，由 `binance-agentic-btc-radar.timer` 每 4 小时运行（北京时间 00:43、04:43……20:43，与原定时任务同一时刻）。
- 模型：`src/btc-radar-model.mjs` 是原 `btc_alert.py` 的 Node 移植版。`test/btc-radar-model.test.mjs` 用两组样例与 Python 输出逐字节对照，包括 Python 四舍六入五成双的取整。

## 数据来源

| 因子 | 权重 | 来源 | 是否需要凭证 |
|---|---:|---|---|
| 预测市场 | 25% | Polymarket 本周、本月 BTC 触价盘 | 否 |
| 美联储利率预期 | 20% | Polymarket 议息盘、年内加息盘、年内降息次数盘 | 否 |
| 美债收益率 | 20% | 美国财政部每日收益率 CSV | 否 |
| BTC 技术面 | 15% | OKX BTC-USDT 日线与最新价 | 否 |
| 黄金 | 10% | OKX XAUT-USDT 日线 | 否 |
| 衍生品与情绪 | 10% | OKX 资金费率、持仓量历史；舆情来自 OKX 新闻情绪接口 | 舆情需要 |
| 持仓叠加 | — | OKX 合约马丁格尔（`tradingBot/dca`） | 需要 |

## 参考指标（只展示，不计分）

| 指标 | 显示位置 | 来源与口径 |
|---|---|---|
| RSI(14) 日线收盘 / 含当日盘中 | BTC 技术面 | OKX BTC-USDT UTC 日线，最近 300 根，Wilder 平滑。"收盘"只用已收盘 K 线，"盘中"包含当天未收盘的 K 线 |
| 恐惧贪婪指数 | 衍生品与情绪 | alternative.me 每日数值与分级（极度恐惧、恐惧、中性、贪婪、极度贪婪） |

两项都不进入因子分和综合分，评分仍与原 `btc_alert.py` 逐字节一致。取数失败时沿用上次的值并标注；从未取到时不显示，也不会让评估失败。不同网站的 RSI 读数常相差几个点，主要差在是否计入当天未收盘的 K 线，以及日线按 UTC 还是北京时间收盘。

## 趋势状态（200 日均线）

- **规则**：OKX BTC-USDT 已收盘的 UTC 日线，收盘价高于 200 日均线 3% 以上为「多头环境」，低于 3% 以下为「回避环境」，在 ±3% 之内维持原状态。只看已收盘的日线，盘中波动不会触发切换。
- **含义**：回避环境只表示不持有多头，不是做空信号。调研中，做空方向的规则在 2022 年以后都没有通过检验。
- **依据**：见 `docs/2026-10-06-btc-strong-signal-research.md`。2022 年以来按此规则持有现货（次日执行、含手续费），最大回撤 −39%；一直持有为 −67%。约每年切换 3 次。回测脚本 `scripts/btc-signal-study/robust.mjs` 与线上共用 `src/btc-trend.mjs`。
- **推送**：状态切换时单独发一条飞书，附上雷达评分、恐惧贪婪、日线 RSI、资金费率作为参考，并注明这些参考在回测中没有稳定预测力。部署后第一次读到的状态只记录、不推送。推送失败时，下一次评估用同一个消息 ID 重试。
- **数据窗口**：每次取最近 300 根日线，算出约 100 天的状态。「状态开始」只在这个窗口内能看到切换时才显示。

## 持仓风险测算与拖动预览

- **风险测算**（持仓面板下方）：止损触发时的亏损（先成交的补仓单计入在内）、止盈触发时的盈利、补仓全部成交后的强平价估算、打平所需的止盈比例，以及按 Polymarket 本周触价盘插值的触及概率。
- **拖动预览**：在标尺上拖动「止损」「止盈」，或用键盘聚焦后按方向键（每步 0.1%，PageUp/PageDown 每步 1%，Esc 恢复），只在页面里重新计算，不会修改 OKX。服务器只有只读 Key，页面没有任何修改策略的接口。
- **总资金**：在页面输入后保存到服务器 `state/btc-radar/settings.json`，只用于计算亏损和盈利占总资金的比例。
- **补仓计数**：OKX 的 `fillSafetyOrds` 包含手动加仓。雷达改为读取本轮订单（`tradingBot/dca/orders`），只统计自动补仓，并取剩余补仓挂单作为阶梯；订单接口不可用时按 `fillSafetyOrds − fillManualOrds` 估算，页面提示阶梯数据不完整。
- **估算口径**：吃单手续费 0.05%、维持保证金率 0.4%，未计滑点；强平价估算假设每笔补仓按杠杆增加逐仓保证金。

## 与原定时任务的差异

- **不再依赖大模型。** 数据采集和评分都是确定性的代码；原任务每次运行都由 Claude 调用工具、组装输入。
- **持仓与舆情需要 OKX 只读 API Key。** 未配置时持仓显示"未接入"，舆情一项按中性计分（对综合分影响最多约 ±2 分），页面明确标注"未接入"。
- **已结算的 Polymarket 价位一并纳入。** 例如本周已经触及的 84,000 记为概率 1。原任务通常只取未结算的盘口。这只影响目标价恰好落在已结算价位附近时的插值，结果更贴近事实。
- **年内降息概率**统一按"1 − 年内零次降息的概率"计算；取不到时用下次与下下次议息降息概率中的较大者，与原任务的兜底规则一致。
- **数据源失败**：沿用该来源上一次成功的值，并在页面标出"沿用旧数据"；从未成功过的来源会让本次评估失败，不写入新结果。
- **提醒**只在以下情况通过飞书发送：综合等级升高；持仓距止损不到 3%，或由安全变为离止损不到 5%；自动补仓次数增加；止损消失；策略结束或改为跟踪新的策略；BTC 较上次评估涨跌超过 4%。不再每次都推送"例行更新"。200 日均线趋势状态切换时另发一条，见上文。

claude.ai 上的原看板和定时任务没有改动，仍在运行。确认服务器版正常后，可以自行在 claude.ai 停用原定时任务，避免重复提醒。

## 配置 OKX 只读 API Key

1. 在 OKX 创建 API Key：权限只勾选「读取」，IP 白名单填服务器 IP。
2. 在服务器上把 Key 写入单独的文件，不要放进 `/etc/binance-agentic-stock-bot.env`：

   ```bash
   sudo install -m 640 -o root -g binancebot /dev/null /etc/binance-agentic-btc-radar.env
   sudoedit /etc/binance-agentic-btc-radar.env
   ```

   字段见 `deploy/binance-agentic-btc-radar.env.example`。下一次运行自动生效，不需要重启服务。

3. 立即验证：

   ```bash
   sudo systemctl start binance-agentic-btc-radar.service
   journalctl -u binance-agentic-btc-radar.service -n 5 --no-pager
   ```

   日志里 `okxConfigured` 为 `true`、`position` 有值即表示接入成功。

雷达只发送签名的 GET 请求，客户端没有下单、改单、停止策略的能力。

## 文件

- `state/btc-radar/latest.json`：最近一次评估。
- `state/btc-radar/history.json`：评分走势，保留 60 天，页面显示最近 180 次。
- `state/btc-radar/inputs.json`：各数据源最近一次成功的原始输入，用于失败时沿用。
- `state/btc-radar/state.json`：正在跟踪的策略 ID、最近一次提醒的结果，以及最近一次已推送的趋势状态（`trend.notified`）。
