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
  entry: "QQQ/IWM/DGRW/SPY：20日动量>0且RSI(14)≥40，选择动量最高者；每周首个交易日决策",
  exit: "每周首个交易日换仓；风险ETF均不合格时，仅IEI20日动量>0才持有，否则现金；另保留8%灾难止损",
  evidence: "已有历史代理回测和独立50 USDT Paper；前向样本仍少，Live保持50 USDT上限与人工审批，不能声称已验证超额收益",
  risk: "可能错过V形反弹；存在周内跳空、换手成本、代币流动性和USDT风险；灾难止损不能保证成交价",
  backtestData: "Yahoo复权日线生成周信号；Binance实时可执行报价决定是否允许提交；Paper账本继续独立跟踪",
  subStrategies: []
};
