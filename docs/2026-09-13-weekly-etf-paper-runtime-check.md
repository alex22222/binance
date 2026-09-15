# 周频 ETF Paper 运行验收

检查时间：2026-09-13，北京时间10:33左右。

## 目标与隔离

确认生产周频 ETF 动量 RSI 轮动能被定时唤醒、读取数据、产生模拟决策。沿用Loop Engineering的检查、验证和留痕流程。本次没有改代码、部署、重启Live Bot或改动实盘参数。

## 已验证

- `binance-agentic-weekly-etf-paper.timer` 为 enabled / active / waiting；下次触发2026-09-14 13:00 UTC。
- 服务为oneshot，正常退出后inactive不是故障。最近例行执行退出码0；本次手动调用该Paper服务退出码0，正确记录market_closed。
- 生产状态为paper / PAPER_CANDLE_PROXY，初始模拟资金50 USDT，无持仓、无轮动成交，lastDecisionWeek为null。
- 9月11日盘中日志为PAPER_WAITING_FOR_WEEKLY_DECISION：当天不是周内首个交易日，符合规则。
- 服务只允许写入state/weekly-etf-rotation-paper；不加载钱包环境，不调用Live交易入口。
- 生产脚本及核心模块SHA256与本地已审阅版本一致。
- 用binancebot身份在独立临时目录执行screen-only成功：QQQ/IWM/DGRW/SPY/IEI的BSC ETF身份全部通过；四个风险ETF信号日期均为2026-09-11。筛选结果DGRW，仅为当次筛选，不是模拟成交或实盘建议。
- 相关策略及定时部署测试10项通过。

## 下一运行节点

按当前日历和15分钟调度，9月14日北京时间21:30触发时第一根分钟线尚未完成，因此跳过；21:45预计进行首轮周度决策。后续交易日每15分钟更新持仓估值，每周仅首次交易日允许决策，同周重复运行不重复买入。

## 边界与未验收

已确认定时、权限、行情和选池链路，不提前伪造周一时间写入生产模拟账本。周一实际代币分钟行情仍需届时有效，数据源中断或未取得完成分钟线会报错而不生成成交。不能把运行就绪说成未来成交保证。

screen-only临时证据保留于服务器`/tmp/weekly-etf-check.5GbZ9K`，没有覆盖正式screening或交易记录。本次未增设额外定时任务。
