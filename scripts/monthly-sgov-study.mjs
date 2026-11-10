// Offline research only. Never imported by the Live Bot or a Paper runner.
// Same accounting as weekly-sgov-study.mjs (sizing, costs, delays, loss limit,
// stop proxy, terminal liquidation); only the decision calendar and the signal
// are injected, so a parity test can replay the weekly engine exactly.
import { weeklyPaperWeek } from "../src/weekly-etf-rotation-paper.mjs";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";
import { allocationPlan, ALLOCATION_STRATEGY_ID } from "../src/weekly-etf-allocation.mjs";

const TICKERS = ["QQQ", "SPY", "SGOV"];
const RISK = ["QQQ", "SPY"];
const DAY = 86400000;
const POLICY = {
  defaultStrategyId: ALLOCATION_STRATEGY_ID, maxOpenPositions: 1, maxTradeUsdt: 250,
  disasterStopLossPct: 8, maxRoundTripCostPct: 0.7, executionBufferPct: 0.1, slippagePct: 0.5,
  weeklyEtfAllocation: { allocationPct: 50, cashReservePct: 50, maxSingleLossUsdt: 20 }
};

// Frozen 2026-10-26 grid; see docs/2026-10-26-monthly-dual-momentum-sgov.md.
export const MONTHLY_RULES = Object.freeze({
  M6_B0: { lookback: 126, band: 0 },
  M6_B2: { lookback: 126, band: 0.02 },
  M12_B0: { lookback: 252, band: 0 },
  M12_B2: { lookback: 252, band: 0.02 }
});

// First NYSE session of each calendar month.
export const monthlyDue = (rows, index) => rows[index].date.slice(0, 7) !== rows[index - 1].date.slice(0, 7);

// Dual momentum against SGOV with a symmetric band: enter stocks only when the
// best one beats SGOV by more than `band`, keep a held stock until it falls
// `band` below SGOV, and switch stocks only when the other leads by `band`.
export function monthlyDualMomentumSignal(rows, index, { lookback, band }, held) {
  if (!Number.isInteger(lookback) || lookback < 1 || !Number.isFinite(band) || band < 0) throw new Error("Invalid monthly rule");
  const start = index - lookback - 1;
  if (start < 0 || TICKERS.some(ticker => !rows[start].prices[ticker] || !rows[index - 1].prices[ticker])) throw new Error("Insufficient real history");
  const momentum = ticker => rows[index - 1].prices[ticker].close / rows[start].prices[ticker].close - 1;
  const defensiveMomentum = momentum("SGOV");
  const assets = RISK.map(ticker => ({ ticker, momentum: momentum(ticker), excess: momentum(ticker) - defensiveMomentum }));
  const ranked = [...assets].sort((a, b) => b.momentum - a.momentum || a.ticker.localeCompare(b.ticker));
  const best = ranked[0];
  const holding = assets.find(asset => asset.ticker === held);
  let target;
  if (holding && holding.excess > -band) {
    const other = assets.find(asset => asset.ticker !== held);
    target = other.momentum - holding.momentum > band && other.excess > -band ? other.ticker : held;
  } else if (best.excess > band) {
    target = best.ticker;
  } else {
    target = defensiveMomentum > 0 ? "SGOV" : "CASH";
  }
  return { target, signalDate: rows[index - 1].date, allRiskAssets: assets, defensiveMomentum, lookback, band };
}

function validateRows(rows) {
  const defensiveStart = rows.findIndex(row => row.prices?.SGOV);
  if (!Array.isArray(rows) || rows.length < 22 || rows.some((row, i) => !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
    || (i && row.date <= rows[i - 1].date) || (i < defensiveStart ? RISK : TICKERS).some(ticker =>
      ![row.prices[ticker]?.open, row.prices[ticker]?.close].every(value => Number.isFinite(value) && value > 0)))) {
    throw new Error("Invalid aligned daily history");
  }
  const expected = researchTradingDates(rows[0].date, rows.at(-1).date);
  if (JSON.stringify(expected) !== JSON.stringify(rows.map(row => row.date))) throw new Error("Missing or extra NYSE session");
}

// `isDue(rows, index)` says whether a decision falls on this session and
// `decide(rows, index, held)` returns { target, signalDate }. `warmup` is the
// real SGOV history the signal needs before the first selected session.
export function runRotationBacktest({ rows, rule, isDue, decide, warmup, startDate, endDate = rows.at(-1)?.date,
  initialCapitalUsd = 435.32, roundTripCostPct = 0.8, gasPerSideUsd = 0.05, buyDelaySessions = 0, buyDelayByWeek = {} }) {
  validateRows(rows);
  if (typeof rule !== "string" || typeof isDue !== "function" || typeof decide !== "function" || !Number.isInteger(warmup) || warmup < 1
    || !Number.isFinite(initialCapitalUsd) || initialCapitalUsd <= 0
    || !Number.isFinite(roundTripCostPct) || roundTripCostPct < 0 || roundTripCostPct >= 100
    || !Number.isFinite(gasPerSideUsd) || gasPerSideUsd < 0
    || !Number.isInteger(buyDelaySessions) || buyDelaySessions < 0 || buyDelaySessions > 3
    || Object.entries(buyDelayByWeek).some(([week, lag]) => !/^\d{4}-\d{2}-\d{2}$/.test(week)
      || weeklyPaperWeek(week) !== week || !Number.isInteger(lag) || lag < 0 || lag > 3)) throw new Error("Invalid research configuration");
  const selected = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.date >= startDate && row.date <= endDate);
  const defensiveStart = rows.findIndex(row => row.prices.SGOV);
  if (selected.length < 2 || defensiveStart < 0 || selected[0].index <= defensiveStart + warmup) throw new Error("Insufficient range or real warmup");
  const rate = roundTripCostPct / 200;
  const trades = [], decisions = [], equityCurve = [], blocks = [];
  let cash = initialCapitalUsd, position = null, pendingBuy = null, pendingStop = null, blockedWeek = null;
  let dayRealized = 0;
  function sell(row, field, reason, signalDate) {
    const price = row.prices[position.ticker][field], quantity = position.quantity;
    const notionalUsd = quantity * price, costUsd = notionalUsd * rate + gasPerSideUsd;
    const realizedPnlUsd = notionalUsd - costUsd - position.budgetUsd - position.entryGasUsd;
    cash += notionalUsd - costUsd;
    trades.push({ side: "SELL", ticker: position.ticker, date: row.date, signalDate, reason, price,
      quantity, notionalUsd, costUsd, gasUsd: gasPerSideUsd, realizedPnlUsd, cashAfterUsd: cash });
    dayRealized += realizedPnlUsd;
    position = null;
  }
  function buy(row, decision) {
    const plan = allocationPlan(POLICY, null, { cashUsdt: cash, positionValueUsdt: 0,
      gasUsdt: gasPerSideUsd * 2, nativeGasValueUsdt: 1, checkedAt: `${row.date}T13:30:00Z` });
    if (!plan.allowed) { blocks.push({ date: row.date, reason: plan.reason }); return; }
    const budget = Math.min(Number(plan.amountUsdt), cash / 2 - gasPerSideUsd);
    if (!(budget >= 1)) { blocks.push({ date: row.date, reason: "INSUFFICIENT_TICKET" }); return; }
    const price = row.prices[decision.target].open;
    const costUsd = budget * rate + gasPerSideUsd;
    const quantity = (budget - budget * rate) / price;
    cash -= budget + gasPerSideUsd;
    position = { ticker: decision.target, quantity, budgetUsd: budget, entryGasUsd: gasPerSideUsd };
    trades.push({ side: "BUY", ticker: decision.target, date: row.date, signalDate: decision.signalDate,
      decisionDate: decision.date, reason: "REBALANCE", price,
      quantity, notionalUsd: budget, costUsd, gasUsd: gasPerSideUsd, cashAfterUsd: cash });
  }
  for (const { row, index } of selected) {
    dayRealized = 0;
    const week = weeklyPaperWeek(row.date);
    if (pendingStop) {
      sell(row, "open", "CLOSE_TRIGGER_NEXT_OPEN_STOP_PROXY", pendingStop.signalDate);
      pendingStop = null; pendingBuy = null; blockedWeek = week;
    }
    if (isDue(rows, index) && week !== blockedWeek) {
      // The band compares against what the strategy holds or is about to buy.
      const held = position?.ticker || pendingBuy?.target || "CASH";
      const decision = { date: row.date, ...decide(rows, index, held) };
      decisions.push(decision);
      pendingBuy = null;
      if (decision.target !== (position?.ticker || "CASH")) {
        if (position) sell(row, "open", "REBALANCE", decision.signalDate);
        if (decision.target !== "CASH") pendingBuy = { ...decision, dueIndex: index + (buyDelayByWeek[week] ?? buyDelaySessions) };
      }
    }
    if (pendingBuy && !position && index >= pendingBuy.dueIndex && week !== blockedWeek) {
      if (dayRealized <= -2) {
        blocks.push({ date: row.date, reason: "DAILY_LOSS_LIMIT", realizedPnlUsd: dayRealized });
        pendingBuy.dueIndex = index + 1;
      } else {
        buy(row, pendingBuy);
        pendingBuy = null;
      }
    }
    const markPrice = position ? row.prices[position.ticker].close : 0;
    const equityUsd = cash + (position ? position.quantity * markPrice : 0);
    equityCurve.push({ date: row.date, equityUsd, cashUsd: cash, quantity: position?.quantity || 0,
      markPrice, holding: position?.ticker || "CASH" });
    // A daily-close proxy never assumes that an 8% stop could have filled intraday.
    if (position && (position.quantity * markPrice * (1 - rate) - gasPerSideUsd) / position.budgetUsd - 1 <= -0.08) {
      pendingStop = { signalDate: row.date };
    }
  }
  const beforeLiquidation = position?.ticker || "CASH";
  if (position) {
    sell(selected.at(-1).row, "close", "TERMINAL_LIQUIDATION", null);
    Object.assign(equityCurve.at(-1), { equityUsd: cash, cashUsd: cash, quantity: 0, markPrice: 0, holding: "CASH" });
  }
  let previous = initialCapitalUsd, peak = initialCapitalUsd, maxDrawdownPct = 0;
  const returns = equityCurve.map(({ equityUsd }) => {
    peak = Math.max(peak, equityUsd); maxDrawdownPct = Math.max(maxDrawdownPct, (1 - equityUsd / peak) * 100);
    const value = equityUsd / previous - 1; previous = equityUsd; return value;
  });
  const years = (Date.parse(equityCurve.at(-1).date) - Date.parse(equityCurve[0].date) + DAY) / (365.2425 * DAY);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const vol = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1));
  return { evidenceLevel: "HISTORICAL_ADJUSTED_OHLC_PROXY", automaticTradingEligible: false,
    rule, initialCapitalUsd, roundTripCostPct, gasPerSideUsd, buyDelaySessions, buyDelayByWeek,
    trades, decisions, equityCurve, blocks, pendingBuy, pendingStop,
    metrics: { startDate: equityCurve[0].date, endDate: equityCurve.at(-1).date, tradingDays: equityCurve.length,
      endingEquityUsd: cash, netPnlUsd: cash - initialCapitalUsd, totalReturnPct: (cash / initialCapitalUsd - 1) * 100,
      cagrPct: ((cash / initialCapitalUsd) ** (1 / years) - 1) * 100, maxDrawdownPct,
      worstDayPct: Math.min(...returns) * 100, annualVolatilityPct: vol * Math.sqrt(252) * 100,
      sharpeZeroRf: vol ? mean / vol * Math.sqrt(252) : null,
      totalCostUsd: trades.reduce((sum, trade) => sum + trade.costUsd, 0), orders: trades.length,
      switches: trades.filter(t => t.side === "SELL" && t.reason === "REBALANCE").length,
      stops: trades.filter(t => t.reason === "CLOSE_TRIGGER_NEXT_OPEN_STOP_PROXY").length,
      lossCapBlocks: blocks.filter(b => b.reason === "DAILY_LOSS_LIMIT").length,
      stockDays: equityCurve.filter(r => RISK.includes(r.holding)).length,
      cashDays: equityCurve.filter(r => r.holding === "CASH").length, beforeLiquidation } };
}

export function runMonthlyBacktest({ rule, ...options }) {
  const config = MONTHLY_RULES[rule];
  if (!config) throw new Error("Unknown monthly rule");
  return runRotationBacktest({ ...options, rule, isDue: monthlyDue, warmup: config.lookback,
    decide: (rows, index, held) => monthlyDualMomentumSignal(rows, index, config, held) });
}
