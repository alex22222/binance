# 周频 ETF 双动量防守轮动 Paper

策略 ID：weekly-etf-dual-momentum-defense。仅模拟，不接钱包，不替换原版。

## 规则

- 沿用 QQQ/IWM/DGRW/SPY，20日动量排序、Wilder RSI(14)≥40。
- 新增风险资产20日动量严格大于0。
- 全部风险资产不合格时，IEI20日动量严格大于0才持有，否则保持现金。
- IEI缺失、日期错位或信号不是上一交易日时失败关闭，不以现金伪装数据缺失。
- 每周首个NYSE交易日决策一次，周中上线等下一周，不补造过去成交。
- 成本沿用原版配置，仅实际买卖扣除；现金不计息，不代表USDT无风险。
- 同为PAPER_CANDLE_PROXY，非可执行报价或实盘成交。

## 运行与证据

命令：`node scripts/run-weekly-etf-rotation-paper.mjs --dual-momentum-defense`。
独立服务：`binance-agentic-weekly-etf-defense-paper.timer`，每15分钟错峰30秒运行。
独立账本：`state/weekly-etf-dual-momentum-paper/latest.json`；同目录包含events.jsonl、screening.json和daily/原始信号序列。

从新版首次周度决策开始比较同期净值变化，不把原版更早盈亏混入新增过滤效果。比较时保留原版原有持仓，不重置旧账本；两者起始持仓不同须明确注明。原版历史表现单独展示。

## 验证循环

目标：原版测试保持通过，新版覆盖零动量、债券趋势、缺失数据、现金持有、卖出转现金与再次买入；线上独立服务成功且原版账本不变。
隔离：不修改实盘参数、不重启Live Bot；测试与部署记录保留在本文件。
状态：2026-09-15部署；全量294项测试通过，服务器11项针对性测试及Linux生产预检通过。新timer active，首次服务Result=success/退出码0，50 USDT现金、0交易。原版latest.json部署前后SHA256一致。只重启Dashboard展示新条目，未重启Live Bot。

五只ETF数据采集screen-only通过。使用9月11日信号的测试结果为CASH（四只风险ETF及IEI动量均为负），仅为筛选，不追溯写入成交或收益。首轮正式周度决策预计9月21日常规时段，取决于当时有效数据。

策略库入口：原有“策略”页面，名称“周频 ETF 双动量防守轮动”。目录不把独立Paper浮盈混作Live已实现收益；阶段复盘须读取各自账本、事件和共同时间窗口。

未混入本次范围：原版收盘估值补齐、日频止损、历史回测、其他未提交的分类与研究页面变更。没有提交或推送整个工作区。
