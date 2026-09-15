# 海龟 55/20 ETF 研究池

## 范围与选择依据

2026-09-09 按 Binance 官方 Ondo 目录核实：以下八个 ticker 均有唯一 BSC (`chainId=56`) ETF (`assetType=3`) 合约。这里的美国 ETF 指美国上市 ETF，包含海外股票、债券及商品资产。选择在回测之前固定，以覆盖不同风险来源，不按近期收益挑选。

| 标的 | 暴露 | 风险组 |
|---|---|---|
| SPY | 美国大盘 | 美国股票 |
| QQQ | Nasdaq-100 | 美国股票 |
| IWM | 美国小盘 | 美国股票 |
| EFA | 发达市场，美国和加拿大除外 | 海外股票 |
| EEM | 新兴市场 | 海外股票 |
| TLT | 20年以上美国国债 | 久期 |
| GLD | 黄金 | 黄金 |
| DBC | 综合商品期货 | 商品 |

首批不重复配置 IVV/VTI/ITOT、IAU；不纳入杠杆、反向、备兑及短期现金管理 ETF。风险组只是暴露标签，并不表示组间不相关。DBC 有期货展期风险，TLT 有利率风险。ETF 底层流动性不能证明代币的可执行流动性。

## 执行与数据

- 现有海龟 Paper 定时器每5分钟在可能的美股常规时段触发，实际开市由纽约交易日历判定。
- 独立八标的 Paper 池，不继承实盘动量 `entryBlockedSymbols`；实盘配置不变。
- 一次只持有一个标的，无加仓；55日突破、20日低点退出、2×ATR20止损保持原规则。
- 同日已经评估过入场时不重置状态；旧标的若已有 Paper 持仓，仍读取其日线和价格以完成退出。
- `state/turtle-paper/etf-screening.json` 保存候选池、动态合约/乘数、日线根数、信号和观测时间。
- `state/turtle-paper/daily/` 保存日线；`latest.json` 与 `events.jsonl` 保留原 Paper 账户和事件记录。
- `node scripts/run-turtle-paper.mjs --screen-only` 只采集筛选数据，不更新 Paper 持仓或当日评估状态。
- 初次采集：八标的各307根日线，最后完整信号日2026-09-08；仅DBC突破55日高点。这是日线信号，不是成交证明。
- Paper 使用代币分钟收盘价和固定成本假设，证据级别 `PAPER_CANDLE_PROXY`，不能视为可执行报价或真实交易。

## 可重复历史验证

```sh
BOT_CONFIG=config/turtle-etf-validation.json STRATEGY_VALIDATION_DIR=state/turtle-etf-validation NODE_USE_ENV_PROXY=1 node scripts/run-strategy-validation.mjs
```

独立验证目录避免混入原股票回测，单笔50 USDT、单仓、往返成本假设1%。首次启动之前的数据归入 historical；forward 从新记录的启动时间开始，不把历史重放包装为前向收益。该命令沿用策略库验证器，结果中查看 `daily-turtle-55-20`。

## 来源

- [Binance Ondo官方资产目录](https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=1)
- [SPY](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy)、[QQQ](https://www.invesco.com/qqq-etf/en/home.html)
- [iShares ETF目录](https://www.ishares.com/us/products/etf-investments)、[TLT](https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf)
- [GLD](https://www.ssga.com/us/en/individual/etfs/spdr-gold-shares-gld)

## 验证进度

- 本地全量测试254/254通过；服务器海龟相关测试8/8通过。
- 已备份原Paper脚本及状态，原实盘Bot进程保持运行。
- 服务器验证已确认八标的池完整生效，Paper执行成功、timer为active，实盘Bot PID仍为2141760，配置SHA256保持不变。

## 首轮结果

采集范围2026-08-12至2026-09-08，共19个交易日、8×19个标的日文件、59,280根代币分钟K线。八标的各有307根完整底层日线用于预热。完整结果在 `state/turtle-etf-validation/latest.json` 的 historical 部分，证据级别为 CANDLE_PROXY。

| 交易 | 时间 | 成本后结果（单笔50 USDT） |
|---|---|---:|
| IWM | 8月13日入场，8月28日2N止损 | -1.8232 USDT（-3.6464%） |
| DBC | 9月2日入场，9月8日末仍持仓 | 浮盈+0.4382 USDT（+0.8764%） |

已实现加期末浮盈约-1.3850 USDT。闭合交易序列回撤1.8232 USDT并不等于包含未实现盈亏的完整账户最大回撤。只有一笔已平仓，无足够证据支持胜率、PF或优于原股票池的结论，也没有因这笔亏损剔除IWM。当前单仓机制会让较早占仓的标的阻止其他信号入场，8标的不等于8个并行仓位。

海龟Paper继续从真实启动时刻积累记录，不导入历史IWM亏损或DBC持仓。新池上线当天原账户已完成入场评估，因此保留当日不重复评估的规则，次交易日开始按新池评估新入场。1%成本是建模假设，后续应以同金额可执行双向报价验证，特别注意低波动ETF的成本负担。
