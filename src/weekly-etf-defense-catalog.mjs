export const WEEKLY_ETF_DEFENSE_CATALOG = {
  id: "weekly-etf-dual-momentum-defense",
  name: "周频 ETF 双动量防守轮动",
  shortName: "ETF双动量防守",
  status: "ACTIVE",
  direction: "LONG_ONLY",
  family: "TREND_MOMENTUM",
  horizon: "SWING",
  riskCluster: "MARKET_BETA",
  timeframe: "WEEKLY_SIGNAL_REGULAR_SESSION_EXECUTION",
  validationStatus: "LIVE_MANUAL_APPROVAL",
  thesis: "相对动量选强，绝对动量过滤下跌，债券也不合格时持有现金；Live仅在人工逐笔审批后执行。",
  entry: "QQQ/VTI/VTV/SPY：20日动量>0且RSI(14)≥40，选择动量最高者；每周首个交易日决策",
  exit: "每周首个交易日换仓；风险ETF均不合格时，仅SGOV 20日动量>0才持有，否则现金；另保留8%灾难止损",
  evidence: "2026-09-18改用SGOV防守并将低链上规模的IWM/DGRW替换为VTI/VTV；新组合10/50/100 USDT双向报价通过。2020-07至2026-09基础轮动代理在单边5bps成本下年化7.37%、最大回撤31.00%、Sharpe 0.51，弱于同期静态风险ETF，且尚未覆盖Live全部执行约束",
  risk: "可能错过V形反弹；存在周内跳空、换手成本、代币流动性和USDT风险；灾难止损不能保证成交价",
  backtestData: "Yahoo复权日线生成周信号；Binance实时可执行报价决定是否允许提交；Paper账本继续独立跟踪",
  subStrategies: []
};
