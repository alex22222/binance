// Offline research only. Never imported by the Live Bot or a Paper runner.
// Fixed SPY/SGOV mix, fully invested, with optional monthly drift checks; see
// docs/2026-10-26-fixed-mix-spy-sgov.md. Cost model matches the SGOV studies:
// proportional round-trip cost split per side plus fixed Gas per order.
import assert from "node:assert/strict";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";

const ASSETS = ["SPY", "SGOV"];
const DAY = 86400000;

// Frozen 2026-10-26 grid: SPY weight in percent and drift band in percentage points (null = never rebalance).
export const FIXED_MIX_RULES = Object.freeze(Object.fromEntries([
  ["MIX0", { spyPct: 0, bandPct: null }], ["MIX100", { spyPct: 100, bandPct: null }],
  ...[20, 40, 60, 80].flatMap(spyPct => [[`MIX${spyPct}_HOLD`, { spyPct, bandPct: null }],
    [`MIX${spyPct}_B5`, { spyPct, bandPct: 5 }], [`MIX${spyPct}_B10`, { spyPct, bandPct: 10 }]])
]));

export function runFixedMixBacktest({ rows, rule, startDate, endDate = rows.at(-1)?.date,
  initialCapitalUsd = 435.32, roundTripCostPct = 0.8, gasPerSideUsd = 0.05 }) {
  const config = FIXED_MIX_RULES[rule];
  if (!config) throw new Error("Unknown fixed-mix rule");
  if (!Number.isFinite(initialCapitalUsd) || initialCapitalUsd <= 0 || !Number.isFinite(roundTripCostPct)
    || roundTripCostPct < 0 || roundTripCostPct >= 100 || !Number.isFinite(gasPerSideUsd) || gasPerSideUsd < 0) throw new Error("Invalid research configuration");
  const selected = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.date >= startDate && row.date <= endDate);
  if (selected.length < 2 || selected[0].index < 1) throw new Error("Insufficient range");
  if (selected.some(({ row }) => ASSETS.some(t => ![row.prices[t]?.open, row.prices[t]?.close].every(v => Number.isFinite(v) && v > 0)))) throw new Error("Missing SPY or SGOV prices");
  const dates = selected.map(({ row }) => row.date);
  if (JSON.stringify(researchTradingDates(dates[0], dates.at(-1))) !== JSON.stringify(dates)) throw new Error("Missing or extra NYSE session");
  const rate = roundTripCostPct / 200;
  const target = { SPY: config.spyPct / 100, SGOV: 1 - config.spyPct / 100 };
  const trades = [], checks = [], equityCurve = [];
  const units = { SPY: 0, SGOV: 0 };
  let cash = initialCapitalUsd;
  const buy = (row, ticker, budget, reason) => {
    const price = row.prices[ticker].open;
    const quantity = (budget - budget * rate) / price;
    cash -= budget + gasPerSideUsd; units[ticker] += quantity;
    trades.push({ side: "BUY", ticker, date: row.date, reason, price, quantity, notionalUsd: budget,
      costUsd: budget * rate + gasPerSideUsd, gasUsd: gasPerSideUsd, cashAfterUsd: cash });
  };
  const sell = (row, ticker, quantity, field, reason) => {
    const price = row.prices[ticker][field], notionalUsd = quantity * price;
    const costUsd = notionalUsd * rate + gasPerSideUsd;
    cash += notionalUsd - costUsd; units[ticker] -= quantity;
    if (Math.abs(units[ticker]) < 1e-12) units[ticker] = 0;
    trades.push({ side: "SELL", ticker, date: row.date, reason, price, quantity, notionalUsd, costUsd, gasUsd: gasPerSideUsd, cashAfterUsd: cash });
  };
  selected.forEach(({ row, index }, position) => {
    if (position === 0) {
      const held = ASSETS.filter(t => target[t] > 0);
      const investable = initialCapitalUsd - held.length * gasPerSideUsd;
      for (const ticker of held) buy(row, ticker, target[ticker] * investable, "INITIAL");
    } else if (config.bandPct !== null && row.date.slice(0, 7) !== rows[index - 1].date.slice(0, 7)) {
      // Drift is measured on the prior completed close, like every signal in these studies.
      const prior = rows[index - 1].prices;
      const values = Object.fromEntries(ASSETS.map(t => [t, units[t] * prior[t].close]));
      const spyWeight = values.SPY / (values.SPY + values.SGOV + cash);
      const drift = (spyWeight - target.SPY) * 100;
      checks.push({ date: row.date, signalDate: rows[index - 1].date, spyWeightPct: spyWeight * 100, driftPct: drift });
      if (Math.abs(drift) > config.bandPct) {
        const over = drift > 0 ? "SPY" : "SGOV", under = drift > 0 ? "SGOV" : "SPY";
        const equity = cash + ASSETS.reduce((sum, t) => sum + units[t] * row.prices[t].open, 0);
        const excessUsd = units[over] * row.prices[over].open - target[over] * equity;
        // The close-based drift can reverse by the open; never trade a sub-dollar or negative excess.
        if (excessUsd > 1) {
          sell(row, over, Math.min(units[over], excessUsd / row.prices[over].open), "open", "REBALANCE");
          if (cash - gasPerSideUsd > 1) buy(row, under, cash - gasPerSideUsd, "REBALANCE");
        }
      }
    }
    equityCurve.push({ date: row.date, equityUsd: cash + ASSETS.reduce((sum, t) => sum + units[t] * row.prices[t].close, 0),
      cashUsd: cash, units: { ...units } });
  });
  const last = selected.at(-1).row;
  const endingSpyWeightPct = (units.SPY * last.prices.SPY.close) / equityCurve.at(-1).equityUsd * 100;
  for (const ticker of ASSETS) if (units[ticker] > 0) sell(last, ticker, units[ticker], "close", "TERMINAL_LIQUIDATION");
  Object.assign(equityCurve.at(-1), { equityUsd: cash, cashUsd: cash, units: { SPY: 0, SGOV: 0 } });
  let previous = initialCapitalUsd, peak = initialCapitalUsd, maxDrawdownPct = 0;
  const returns = equityCurve.map(({ equityUsd }) => {
    peak = Math.max(peak, equityUsd); maxDrawdownPct = Math.max(maxDrawdownPct, (1 - equityUsd / peak) * 100);
    const value = equityUsd / previous - 1; previous = equityUsd; return value;
  });
  const years = (Date.parse(equityCurve.at(-1).date) - Date.parse(equityCurve[0].date) + DAY) / (365.2425 * DAY);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const vol = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1));
  return { evidenceLevel: "HISTORICAL_ADJUSTED_OHLC_PROXY", automaticTradingEligible: false,
    rule, ...config, initialCapitalUsd, roundTripCostPct, gasPerSideUsd, trades, checks, equityCurve,
    metrics: { startDate: equityCurve[0].date, endDate: equityCurve.at(-1).date, tradingDays: equityCurve.length,
      endingEquityUsd: cash, netPnlUsd: cash - initialCapitalUsd, totalReturnPct: (cash / initialCapitalUsd - 1) * 100,
      cagrPct: ((cash / initialCapitalUsd) ** (1 / years) - 1) * 100, maxDrawdownPct,
      worstDayPct: Math.min(...returns) * 100, annualVolatilityPct: vol * Math.sqrt(252) * 100,
      sharpeZeroRf: vol ? mean / vol * Math.sqrt(252) : null,
      totalCostUsd: trades.reduce((sum, t) => sum + t.costUsd, 0), orders: trades.length,
      rebalances: new Set(trades.filter(t => t.reason === "REBALANCE").map(t => t.date)).size, endingSpyWeightPct } };
}

// Independent replay: recomputes cash, units and daily equity without the engine's helpers.
export function reconcileFixedMix(result, rows) {
  const market = new Map(rows.map(row => [row.date, row]));
  const rate = result.roundTripCostPct / 200;
  let cash = result.initialCapitalUsd;
  const units = { SPY: 0, SGOV: 0 };
  for (const day of result.equityCurve) {
    for (const trade of result.trades.filter(t => t.date === day.date)) {
      assert.equal(trade.price, market.get(day.date).prices[trade.ticker][trade.reason === "TERMINAL_LIQUIDATION" ? "close" : "open"]);
      assert.ok(Math.abs(trade.costUsd - (trade.notionalUsd * rate + result.gasPerSideUsd)) < 1e-9);
      if (trade.side === "BUY") {
        assert.ok(Math.abs(trade.quantity * trade.price - trade.notionalUsd * (1 - rate)) < 1e-9);
        cash -= trade.notionalUsd + result.gasPerSideUsd; units[trade.ticker] += trade.quantity;
      } else {
        assert.ok(trade.quantity <= units[trade.ticker] + 1e-12);
        cash += trade.quantity * trade.price * (1 - rate) - result.gasPerSideUsd; units[trade.ticker] -= trade.quantity;
      }
      assert.ok(Math.abs(cash - trade.cashAfterUsd) < 1e-8, `Unreconciled cash: ${day.date}`);
      assert.ok(cash > -1e-8, `Negative cash: ${day.date}`);
    }
    const value = ASSETS.reduce((sum, t) => sum + units[t] * market.get(day.date).prices[t].close, 0);
    assert.ok(Math.abs(cash + value - day.equityUsd) < 1e-8, `Unreconciled equity: ${day.date}`);
  }
  assert.ok(Math.abs(cash - result.metrics.endingEquityUsd) < 1e-8);
  assert.ok(ASSETS.every(t => Math.abs(units[t]) < 1e-9));
  return true;
}
