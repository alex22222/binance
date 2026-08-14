import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_STRATEGY_ID = "adaptive-momentum";

export const SHADOW_MARKET_REGIME_FILTER = Object.freeze({
  id: "shadow-market-regime-filter",
  name: "市场状态过滤器",
  mode: "SHADOW",
  enforced: false,
  rule: "SPY与QQQ的60分钟方向同时为负，且至少一个满足持续下跌条件时标记 WOULD_BLOCK",
  evidence: "跨策略共同记录，尚未启用入场否决",
  risk: "可能错过市场急跌后的V形反弹"
});

export const SHADOW_DOWNTREND_VETO = Object.freeze({
  id: "shadow-downtrend-veto",
  name: "单边下跌否决器",
  mode: "SHADOW",
  enforced: false,
  rule: "代币15分钟收盘价：60分钟≤-1.0×ATR15、120分钟≤-1.5×ATR15，且价格位于下行EMA8下方",
  evidence: "前向观测中，尚未证明能提高成本后收益",
  risk: "可能把V形反转误判为不可买"
});

export const SHADOW_ENTRY_FAILURE_STOP = Object.freeze({
  id: "shadow-entry-failure-stop",
  name: "早期入场失败保护",
  mode: "SHADOW",
  enforced: false,
  rule: "持仓15–30分钟内：原信号失效、最大浮盈≤+0.2R、可执行收益≤-0.5R，且连续两次检查均满足",
  evidence: "仅记录反事实退出，尚未证明能改善成本后收益",
  risk: "过早退出可能把正常回撤误判为突破失败"
});

function shadowRiskOverlays(role) {
  return [
    {
      ...SHADOW_MARKET_REGIME_FILTER,
      role: "为所有只做多策略标记共同市场逆风"
    },
    { ...SHADOW_DOWNTREND_VETO, role },
    {
      ...SHADOW_ENTRY_FAILURE_STOP,
      role: "记录入场后立即失效且没有形成有效浮盈的机会"
    }
  ];
}

export const STRATEGIES = [
  {
    id: DEFAULT_STRATEGY_ID,
    name: "自适应动量",
    shortName: "动量",
    status: "ACTIVE",
    direction: "LONG_ONLY",
    thesis: "15 分钟趋势超过波动门槛，方向一致且成本可覆盖时顺势进入。",
    entry: "≥ 0.75×ATR15，且 9/15 个一分钟变化上涨",
    exit: "-1R / +2R / ATR 移动保护",
    evidence: "启发式，待样本外验证",
    risk: "追涨与趋势反转",
    subStrategies: shadowRiskOverlays("识别大级别持续下跌中的短周期反弹")
  },
  {
    id: "trend-pullback-confirmation",
    name: "趋势回撤再确认",
    shortName: "回撤确认",
    status: "SHADOW",
    direction: "LONG_ONLY",
    thesis: "先确认60分钟上升趋势，再等待0.3–0.8×ATR回撤和一分钟重新转强。",
    entry: "60分钟≥0.75×ATR15；回撤0.3–0.8×ATR15；1分钟突破此前3分钟收盘高点",
    exit: "仅记录15/30/60/120分钟反事实结果，不下单",
    evidence: "针对追高和盈亏不对称的前向实验",
    risk: "强趋势中可能等不到回撤，或把下跌中继误判为回撤",
    subStrategies: shadowRiskOverlays("区分健康回撤与大级别持续下跌")
  },
  {
    id: "regime-relative-pullback-momentum",
    name: "状态过滤的相对强度回撤动量",
    shortName: "相对强度回撤",
    status: "SHADOW",
    direction: "LONG_ONLY",
    thesis: "市场状态允许时，只跟踪相对SPY/QQQ更强且完成受控回撤再确认的股票。",
    entry: "SPY/QQQ允许；60分钟相对收益为正且排名前30%；回撤再确认；可执行成本覆盖",
    exit: "仅记录15/30/60/120分钟反事实结果，不下单",
    evidence: "独立前向Shadow；审批复核仅复用不超过2分钟且带时间戳的完整横截面上下文，并统计真实成交下的避免亏损与错过盈利",
    risk: "横截面较小、基准beta近似为1，可能遗漏低beta强势股",
    subStrategies: shadowRiskOverlays("避免把个股反弹误判为相对强势回撤")
  },
  {
    id: "executable-basis-reversion",
    name: "可执行折价回归",
    shortName: "折价回归",
    status: "ACTIVE",
    direction: "LONG_ONLY",
    thesis: "用真实买入报价与底层美股×sharesMultiplier 比较，只买入足以覆盖全部成本的折价。",
    entry: "可执行折价净覆盖成本与最小边际",
    exit: "折价收敛，或触发统一 ATR 风控",
    evidence: "产品结构驱动，研究优先",
    risk: "底层报价延迟、盘外跳空与无对冲方向风险",
    subStrategies: shadowRiskOverlays("区分可回归折价与趋势性下跌造成的折价")
  },
  {
    id: "residual-reversal",
    name: "市场残差反转",
    shortName: "残差反转",
    status: "RESEARCH",
    direction: "LONG_ONLY",
    thesis: "剔除 SPY/QQQ 因子后捕捉个股临时流动性冲击。",
    entry: "显著负残差且无公司行动",
    exit: "残差回归零轴",
    evidence: "学术证据较强，尚缺可执行报价验证",
    risk: "市场单边与交易成本",
    subStrategies: shadowRiskOverlays("避免把持续下跌误识别为临时负残差")
  },
  {
    id: "session-momentum",
    name: "开收盘时段动量",
    shortName: "时段动量",
    status: "RESEARCH",
    direction: "LONG_ONLY",
    thesis: "用开盘前半小时方向筛选收盘前半小时机会。",
    entry: "限定 SPY/QQQ 与美股特定时段",
    exit: "收盘前退出",
    evidence: "样本外研究支持，但不是任意 15 分钟动量",
    risk: "尾盘价差与事件日跳变",
    subStrategies: shadowRiskOverlays("标记开盘方向性下跌中的假动量机会")
  }
];

export function strategyById(strategyId) {
  return STRATEGIES.find((strategy) => strategy.id === strategyId) || null;
}

export function assertSwitchableStrategy(strategyId) {
  const strategy = strategyById(strategyId);
  if (!strategy || strategy.status !== "ACTIVE") throw new Error("Strategy is not switchable");
  return strategy;
}

export function executableBasisDecision({
  executableBuyPrice,
  underlyingPrice,
  sharesMultiplier,
  allInCostPct,
  minNetEdgePct
}) {
  const values = [executableBuyPrice, underlyingPrice, sharesMultiplier, allInCostPct, minNetEdgePct];
  if (values.some((value) => !Number.isFinite(Number(value))) || !(executableBuyPrice > 0) || !(underlyingPrice > 0) || !(sharesMultiplier > 0)) {
    return { allowed: false, reason: "INVALID_BASIS_INPUT" };
  }
  const fairTokenPrice = underlyingPrice * sharesMultiplier;
  const basisPct = ((executableBuyPrice / fairTokenPrice) - 1) * 100;
  const grossEdgePct = -basisPct;
  const netEdgePct = grossEdgePct - allInCostPct;
  return {
    allowed: basisPct < 0 && netEdgePct >= minNetEdgePct,
    reason: basisPct >= 0 ? "NO_EXECUTABLE_DISCOUNT" : netEdgePct < minNetEdgePct ? "DISCOUNT_DOES_NOT_COVER_COSTS" : "EXECUTABLE_DISCOUNT",
    fairTokenPrice,
    executableBuyPrice,
    basisPct,
    grossEdgePct,
    netEdgePct
  };
}

export function basisExitReached({ executableSellPrice, fairTokenPrice, exitBasisPct = -0.1 }) {
  if (!(executableSellPrice > 0) || !(fairTokenPrice > 0)) return false;
  return ((executableSellPrice / fairTokenPrice) - 1) * 100 >= exitBasisPct;
}

export async function readStrategyControl(path, fallback = DEFAULT_STRATEGY_ID) {
  try {
    const control = JSON.parse(await readFile(path, "utf8"));
    return { ...control, strategyId: assertSwitchableStrategy(control.strategyId).id };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { strategyId: assertSwitchableStrategy(fallback).id, updatedAt: null, updatedBy: "config" };
  }
}

export async function writeStrategyControl(path, strategyId, updatedBy = "dashboard") {
  assertSwitchableStrategy(strategyId);
  const control = { strategyId, updatedAt: new Date().toISOString(), updatedBy };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(control, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
  return control;
}

function performanceFor(strategyId, traceRecords) {
  const trades = traceRecords
    .filter((record) => (
      (record.event === "sell_submission" && record.status === "simulated") ||
      (record.event === "pending_order" && record.status === "finished" && record.details?.side === "SELL")
    ))
    .filter((record) => record.details?.strategyId === strategyId)
    .map((record) => Number(record.details.realizedPnlUsdt))
    .filter(Number.isFinite);
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsdt = 0;
  for (const pnl of trades) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
  }
  const wins = trades.filter((pnl) => pnl > 0).length;
  return {
    trades: trades.length,
    wins,
    winRatePct: trades.length ? (wins / trades.length) * 100 : null,
    realizedPnlUsdt: trades.reduce((sum, pnl) => sum + pnl, 0),
    maxDrawdownUsdt
  };
}

export function buildStrategyComparison(activeStrategyId, traceRecords) {
  return STRATEGIES.map((strategy) => ({
    ...strategy,
    active: strategy.id === activeStrategyId,
    switchable: strategy.status === "ACTIVE",
    performance: performanceFor(strategy.id, traceRecords)
  }));
}
