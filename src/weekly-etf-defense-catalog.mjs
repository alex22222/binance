export const WEEKLY_ETF_DEFENSE_CATALOG = {
  id: "weekly-etf-dual-momentum-defense",
  name: "周频 ETF 双动量防守轮动",
  shortName: "ETF双动量防守",
  status: "RESEARCH",
  direction: "LONG_ONLY",
  family: "TREND_MOMENTUM",
  horizon: "SWING",
  riskCluster: "MARKET_BETA",
  timeframe: "WEEKLY_SIGNAL_REGULAR_SESSION_EXECUTION",
  validationStatus: "PAPER_TRACKING",
  thesis: "独立Paper对照：相对动量选强，绝对动量过滤下跌，债券也不合格时持有现金。",
  entry: "QQQ/IWM/DGRW/SPY：20日动量>0且RSI(14)≥40，选择动量最高者；每周首个交易日决策",
  exit: "周度换仓；风险ETF均不合格时，仅IEI20日动量>0才持有，否则现金；无周内止损",
  evidence: "独立50 USDT Paper；原版保持不变；尚无足够前向数据，不能声称提高收益",
  risk: "可能错过V形反弹；存在周内跳空、换手成本和USDT风险；不等于无风险避险",
  backtestData: "Yahoo复权日线；Binance已完成分钟K线代理；独立账本weekly-etf-dual-momentum-paper",
  subStrategies: []
};
