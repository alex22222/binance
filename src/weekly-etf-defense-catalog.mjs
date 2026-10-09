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
  validationStatus: "LIVE_ELIGIBILITY_REVIEW_REQUIRED",
  thesis: "相对动量选强，绝对动量过滤下跌，债券也不合格时持有现金；新增实盘须通过证据门禁，审批方式由运行配置决定。",
  entry: "QQQ/SPY：20日动量>0且RSI(14)≥40，选择动量最高者；每周首个交易日决策",
  exit: "每周首个交易日换仓；风险ETF均不合格时，仅SGOV 20日动量>0才持有，否则现金；另保留8%灾难止损",
  evidence: "2026-10-04固定矩阵研究支持移除高度重叠的VTI/VTV，但未证明新池具有实盘优势。QQQ/SPY+SGOV周频20日代理在2008-06至2026-09、0.35%往返成本下年化3.74%、最大回撤36.46%；月频变体另建独立Paper，不自动替换Live。旧四ETF Paper保持原身份和历史",
  risk: "可能错过V形反弹；存在周内跳空、换手成本、代币流动性和USDT风险；灾难止损不能保证成交价",
  backtestData: "Yahoo复权日线生成周信号；Binance实时可执行报价决定是否允许提交；Paper账本继续独立跟踪",
  subStrategies: []
};
