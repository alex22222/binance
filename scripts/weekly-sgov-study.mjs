// Offline research only. Never imported by the Live Bot or a Paper runner.
import assert from "node:assert/strict";
import { studySignal } from "./etf-pool-study.mjs";
import { weeklyPaperWeek } from "../src/weekly-etf-rotation-paper.mjs";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";
import { allocationPlan, ALLOCATION_STRATEGY_ID } from "../src/weekly-etf-allocation.mjs";

export const WEEKLY_SGOV_RULES = ["CURRENT", "BEAT_SGOV", "SGOV_HOLD", "SGOV_FULL"];
const TICKERS = ["QQQ", "SPY", "SGOV"];
const DAY = 86400000;
const POLICY = {
  defaultStrategyId: ALLOCATION_STRATEGY_ID, maxOpenPositions: 1, maxTradeUsdt: 250,
  disasterStopLossPct: 8, maxRoundTripCostPct: 0.7, executionBufferPct: 0.1, slippagePct: 0.5,
  weeklyEtfAllocation: { allocationPct: 50, cashReservePct: 50, maxSingleLossUsdt: 20 }
};

export function weeklySgovSignal(rows, index, rule) {
  if (!["CURRENT", "BEAT_SGOV"].includes(rule)) throw new Error("Unknown weekly signal rule");
  const signal = studySignal(rows, index, ["QQQ", "SPY"], 20, 14);
  if (rule === "BEAT_SGOV") {
    const candidates = signal.allRiskAssets.filter(asset => asset.momentum > 0 && asset.rsi >= 40
      && asset.momentum > signal.defensiveMomentum)
      .sort((a, b) => b.momentum - a.momentum || a.ticker.localeCompare(b.ticker));
    signal.target = candidates[0]?.ticker || (signal.defensiveMomentum > 0 ? "SGOV" : "CASH");
  }
  return signal;
}

function validateRows(rows) {
  const defensiveStart = rows.findIndex(row => row.prices?.SGOV);
  if (!Array.isArray(rows) || rows.length < 22 || rows.some((row, i) => !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
    || (i && row.date <= rows[i - 1].date) || (i < defensiveStart ? TICKERS.slice(0, 2) : TICKERS).some(ticker =>
      ![row.prices[ticker]?.open, row.prices[ticker]?.close].every(value => Number.isFinite(value) && value > 0)))) {
    throw new Error("Invalid aligned daily history");
  }
  const expected = researchTradingDates(rows[0].date, rows.at(-1).date);
  if (JSON.stringify(expected) !== JSON.stringify(rows.map(row => row.date))) throw new Error("Missing or extra NYSE session");
}

export function runWeeklySgovBacktest({ rows, rule, startDate, endDate = rows.at(-1)?.date,
  initialCapitalUsd = 435.32, roundTripCostPct = 0.8, gasPerSideUsd = 0.05, buyDelaySessions = 0,
  buyDelayByWeek = {} }) {
  validateRows(rows);
  if (!WEEKLY_SGOV_RULES.includes(rule) || !Number.isFinite(initialCapitalUsd) || initialCapitalUsd <= 0
    || !Number.isFinite(roundTripCostPct) || roundTripCostPct < 0 || roundTripCostPct >= 100
    || !Number.isFinite(gasPerSideUsd) || gasPerSideUsd < 0
    || !Number.isInteger(buyDelaySessions) || buyDelaySessions < 0 || buyDelaySessions > 3
    || Object.entries(buyDelayByWeek).some(([week, lag]) => !/^\d{4}-\d{2}-\d{2}$/.test(week)
      || weeklyPaperWeek(week) !== week || !Number.isInteger(lag) || lag < 0 || lag > 3)) throw new Error("Invalid research configuration");
  const selected = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.date >= startDate && row.date <= endDate);
  const defensiveStart = rows.findIndex(row => row.prices.SGOV);
  if (selected.length < 2 || defensiveStart < 0 || selected[0].index <= defensiveStart + 20) throw new Error("Insufficient range or real warmup");
  const rate = roundTripCostPct / 200;
  const benchmark = rule.startsWith("SGOV_");
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
    let budget;
    if (rule === "SGOV_FULL") budget = cash - gasPerSideUsd;
    else {
      const plan = allocationPlan(POLICY, null, { cashUsdt: cash, positionValueUsdt: 0,
        gasUsdt: gasPerSideUsd * 2, nativeGasValueUsdt: 1, checkedAt: `${row.date}T13:30:00Z` });
      if (!plan.allowed) { blocks.push({ date: row.date, reason: plan.reason }); return; }
      budget = Math.min(Number(plan.amountUsdt), cash / 2 - gasPerSideUsd);
    }
    if (!(budget >= 1)) { blocks.push({ date: row.date, reason: "INSUFFICIENT_TICKET" }); return; }
    const price = row.prices[decision.target].open;
    const costUsd = budget * rate + gasPerSideUsd;
    const quantity = (budget - budget * rate) / price;
    cash -= budget + gasPerSideUsd;
    position = { ticker: decision.target, quantity, budgetUsd: budget, entryGasUsd: gasPerSideUsd };
    trades.push({ side: "BUY", ticker: decision.target, date: row.date, signalDate: decision.signalDate,
      decisionDate: decision.date, reason: benchmark ? "BUY_AND_HOLD" : "REBALANCE", price,
      quantity, notionalUsd: budget, costUsd, gasUsd: gasPerSideUsd, cashAfterUsd: cash });
  }
  for (const { row, index } of selected) {
    dayRealized = 0;
    const week = weeklyPaperWeek(row.date);
    if (pendingStop) {
      sell(row, "open", "CLOSE_TRIGGER_NEXT_OPEN_STOP_PROXY", pendingStop.signalDate);
      pendingStop = null; pendingBuy = null; blockedWeek = week;
    }
    const due = benchmark ? !equityCurve.length
      : week !== weeklyPaperWeek(rows[index - 1].date) && week !== blockedWeek;
    if (due) {
      const signal = benchmark ? { target: "SGOV", signalDate: null } : weeklySgovSignal(rows, index, rule);
      const decision = { date: row.date, ...signal };
      decisions.push(decision);
      pendingBuy = null;
      if (decision.target !== (position?.ticker || "CASH")) {
        if (position) sell(row, "open", "REBALANCE", decision.signalDate);
        if (decision.target !== "CASH") pendingBuy = { ...decision, dueIndex: index + (buyDelayByWeek[week] ?? buyDelaySessions) };
      }
    }
    if (pendingBuy && !position && index >= pendingBuy.dueIndex && week !== blockedWeek) {
      if (!benchmark && dayRealized <= -2) {
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
    if (!benchmark && position && (position.quantity * markPrice * (1 - rate) - gasPerSideUsd) / position.budgetUsd - 1 <= -0.08) {
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
      cashDays: equityCurve.filter(r => r.holding === "CASH").length, beforeLiquidation } };
}

// Independent cash/quantity replay: no use of the engine's accounting functions.
export function reconcileWeeklySgov(result, rows) {
  const market = new Map(rows.map(row => [row.date, row]));
  let cash = result.initialCapitalUsd, units = 0, ticker = null;
  for (const day of result.equityCurve) {
    for (const trade of result.trades.filter(trade => trade.date === day.date)) {
      const expected = market.get(day.date).prices[trade.ticker][trade.reason === "TERMINAL_LIQUIDATION" ? "close" : "open"];
      assert.equal(trade.price, expected);
      assert.ok(Math.abs(trade.costUsd - trade.notionalUsd * result.roundTripCostPct / 200 - result.gasPerSideUsd) < 1e-8);
      if (trade.side === "BUY") {
        assert.equal(ticker, null);
        assert.ok(Math.abs(trade.quantity * trade.price - (trade.notionalUsd - trade.costUsd + trade.gasUsd)) < 1e-8);
        cash -= trade.notionalUsd + trade.gasUsd; units = trade.quantity; ticker = trade.ticker;
      } else {
        assert.equal(ticker, trade.ticker); assert.equal(units, trade.quantity);
        cash += units * trade.price - trade.costUsd; units = 0; ticker = null;
      }
      assert.ok(Math.abs(cash - trade.cashAfterUsd) < 1e-8);
    }
    const value = ticker ? units * market.get(day.date).prices[ticker].close : 0;
    assert.ok(Math.abs(cash + value - day.equityUsd) < 1e-8, `Unreconciled equity: ${day.date}`);
    assert.equal(day.holding, ticker || "CASH");
  }
  assert.ok(Math.abs(cash - result.metrics.endingEquityUsd) < 1e-8);
  return true;
}
