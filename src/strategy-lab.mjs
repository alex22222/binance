import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_STRATEGY_ID = "adaptive-momentum";

export const STRATEGIES = [
  {
    id: DEFAULT_STRATEGY_ID,
    name: "自适应动量",
    shortName: "动量",
    status: "ACTIVE",
    thesis: "15 分钟趋势超过波动门槛，方向一致且成本可覆盖时顺势进入。",
    entry: "≥ 0.75×ATR15，且 9/15 个一分钟变化上涨",
    exit: "-1R / +2R / ATR 移动保护",
    evidence: "启发式，待样本外验证",
    risk: "追涨与趋势反转"
  },
  {
    id: "executable-basis-reversion",
    name: "可执行折价回归",
    shortName: "折价回归",
    status: "ACTIVE",
    thesis: "用真实买入报价与底层美股×sharesMultiplier 比较，只买入足以覆盖全部成本的折价。",
    entry: "可执行折价净覆盖成本与最小边际",
    exit: "折价收敛，或触发统一 ATR 风控",
    evidence: "产品结构驱动，研究优先",
    risk: "底层报价延迟、盘外跳空与无对冲方向风险"
  },
  {
    id: "residual-reversal",
    name: "市场残差反转",
    shortName: "残差反转",
    status: "RESEARCH",
    thesis: "剔除 SPY/QQQ 因子后捕捉个股临时流动性冲击。",
    entry: "显著负残差且无公司行动",
    exit: "残差回归零轴",
    evidence: "学术证据较强，尚缺可执行报价验证",
    risk: "市场单边与交易成本"
  },
  {
    id: "session-momentum",
    name: "开收盘时段动量",
    shortName: "时段动量",
    status: "RESEARCH",
    thesis: "用开盘前半小时方向筛选收盘前半小时机会。",
    entry: "限定 SPY/QQQ 与美股特定时段",
    exit: "收盘前退出",
    evidence: "样本外研究支持，但不是任意 15 分钟动量",
    risk: "尾盘价差与事件日跳变"
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
