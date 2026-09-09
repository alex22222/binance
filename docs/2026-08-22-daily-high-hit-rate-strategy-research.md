# 美股代币跨周期高命中候选研究

## 结论

本轮不把策略限制在 15 分钟。当前配置的保守往返摩擦约为 1.0%（0.7% 报价成本上限 + 0.1% 执行缓冲 + 0.2% Gas/50 USDT），所以优先选择日线或跨日机会，而不是增加高换手信号。

登记的三项都保持 `RESEARCH`，不能在策略页面热切换为实盘：

| 策略 | 公开证据 | 本项目映射 | 主要缺陷 |
|---|---|---|---|
| 日线 RSI(2) 趋势内反转 | 开源规则为收盘高于 SMA200、RSI(2)<5，收盘重新高于 SMA5 时退出 | 上一交易日确认信号，下一常规时段开盘后用代币分钟价成交 | 高胜率均值回归可能以少数危机损失偿还全部小盈利 |
| 日线 Double 7 趋势回撤 | 原始公开结果中 SPY 153 笔、80.4% 正确，QQQ 68 笔、79.4%；近期独立回测 2021–2025 为 77.1%，但收益落后买入持有 | 上一交易日创 7 日收盘新低且高于 SMA200，下一常规时段执行；7 日新高退出 | 公开样本主要是指数 ETF，不能把 80% 直接外推到单股代币 |
| 日线 IBS 指数反转 | 十年国家 ETF 研究支持低 IBS 的次日反转；QuantConnect LEAN 有可复现实现 | 仅允许 SPY/QQQ，上一日 `IBS=(close-low)/(high-low)≤0.2` 且高于 SMA200，下一常规时段进入并当日退出 | 公开研究不是本项目成本后胜率证明，且 QuantConnect 示例使用零手续费 |

## 为什么没有选常见的日内策略

- 开盘区间突破（ORB）有论文和较完整的 GitHub 回放，但一套十年公开实现的胜率约 50.3%，更像正盈亏比策略，不属于高命中方向。
- 普通 VWAP+RSI 均值回归在一套公开的 2020–2024 成本后复核中，六个版本的 PSR 都低于 1%，即使加趋势过滤也只把损失缩小，并未证明存在统计优势。
- 正向完整跳空的研究命中率约 55%–60%，但 Nasdaq 100/SP500 的平均日内漂移约 0.3%–0.5%，低于本项目约 1.0% 的保守往返摩擦，不适合直接登记为优先策略。
- 负向跳空并不天然等于可买的“补缺口”；研究显示 Nasdaq 100 的负跳空后漂移很弱，不能把视觉上的 gap fill 当作稳定优势。

## 数据和回测口径

回测器使用两层数据：

1. Yahoo Finance 日线底层 OHLCV，默认保留 450 个自然日，为 SMA200、RSI(2)、七日高低和 IBS 提供只读信号历史。
2. Binance 美股代币一分钟 K 线用于下一常规时段延迟成交；若以后积累了金额匹配的历史可执行报价，则切换为严格 quote replay。代币 K 线的 volume 保留字段不作为真实成交量，成交量研究只使用底层数据。

每个策略仍应用统一的代币初始止损、灾难止损、交易时段和标的限制。历史回放明确扣除固定往返成本；没有可执行报价的结果只能标记为 `CANDLE_PROXY`，不能作为上线依据。

## 科学验证门槛

外部胜率不写入本项目绩效。每个候选至少满足以下条件后，才讨论从 `RESEARCH` 升级为 Shadow：

- 至少 100 笔已完成交易，并分离参数期、样本外期和真正前向期；
- 成本后 Profit Factor > 1.2，且不是由单一标的、单一年份或少数极端盈利贡献；
- 在 1.0 倍和 1.5 倍当前成本压力下仍为正期望；
- 同时报告胜率、平均盈亏比、最大回撤、最差 R、MAE/MFE 和连续亏损；
- 分 SPY/QQQ、单股、牛市、震荡、急跌状态报告，禁止只看合计胜率；
- 三项策略同属短期均值回归风险簇，不能按三个独立策略叠加仓位。

## 首次本地回放（2026-07-27 至 2026-08-21）

这只是管线验收，不是策略结论。三项都只有 3 笔完成交易，成交证据均为 `CANDLE_PROXY` 并按 1.0% 往返成本扣减：

| 策略 | 交易 | 胜率 | PnL（50 USDT/笔） | PF | 判断 |
|---|---:|---:|---:|---:|---|
| 日线 RSI(2) 趋势内反转 | 3 | 66.7% | +0.706 USDT | 4.92 | 唯一暂时为正；平均 MAE -2.77%，过程风险远大于最终盈利，必须继续采样 |
| 日线 Double 7 趋势回撤 | 3 | 33.3% | -1.776 USDT | 0.24 | 外部约 80% 胜率没有在本地小样本复现 |
| 日线 IBS 指数反转 | 3 | 0% | -1.542 USDT | 0.00 | 当前版本不值得升级；保留 RESEARCH 作为反证样本 |

RSI(2) 的三笔分别为 QQQ、AAPL、AMZN；其中两笔扣费后只接近盈亏平衡，不能用“2 胜 1 负”掩盖收益安全垫很薄。Double 7 和 IBS 都出现了同一轮 QQQ 下跌暴露，进一步说明三项不是独立风险来源。

## 主要来源

- [TuringTrader：Connors RSI(2) 与 Double 7 开源规则](https://github.com/fbertram/TuringTrader/blob/master/BooksAndPubs/Connors_ShortTermTrading.cs)
- [Double 7 原始章节与历史结果](https://c.mql5.com/forextsd/forum/56/sttstw_chap10.pdf)
- [Pinkfish：Double 7 日线回测与信号示例](https://github.com/fja05680/pinkfish/tree/master/examples/strategies/double-7s)
- [近期 Double 7 回测与买入持有对照](https://www.backtestedstrategies.com/strategies/connors-double-7s-backtest/)
- [IBS 十年 ETF 研究](https://arxiv.org/abs/2306.12434)
- [QuantConnect LEAN：IBS 开源实现](https://github.com/QuantConnect/Lean/blob/master/Algorithm.Python/Alphas/GlobalEquityMeanReversionIBSAlpha.py)
- [美股开盘跳空研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC10017064/)
- [成本后否定 VWAP+RSI 的公开研究仓库](https://github.com/Patience-Fuglo/systematic-alpha-research)
- [带样本外审计的 gap 数据工程案例](https://github.com/SeiKahi/gapper-analysis)
- [十年 ORB 开源回放与约 50% 命中结果](https://github.com/sam-bateman/trading-orb)
