import { createHash } from "node:crypto";
import { researchTradingDates } from "./weekly-research-calendar.mjs";
import { weeklyEtfDefensiveSignal, weeklyPaperWeek, WEEKLY_ETF_ROTATION_UNIVERSE } from "./weekly-etf-rotation-paper.mjs";

export const FREQUENCY_PAPER_SPEC = Object.freeze({
  schemaVersion: 1, id: "etf-frequency-factorial-v1", initialCapitalUsdt: 50,
  riskTickers: ["QQQ", "SPY"], defensiveTicker: "SGOV", frequencies: ["W", "M"],
  momentumDays: [20, 63, 126, 252], rsiPeriod: 14, rsiThreshold: 40, disasterStopPct: 8,
  // At 50 U these spread/buffer + fixed Gas assumptions approximate 0.35/0.45/1% all-in.
  costs: [{ id: "base", roundTripSpreadPct: 0.27, gasPerSideUsdt: 0.02 },
    { id: "stress", roundTripSpreadPct: 0.37, gasPerSideUsdt: 0.02 },
    { id: "severe", roundTripSpreadPct: 0.92, gasPerSideUsdt: 0.02 }],
  benchmark: "SPY_BUY_HOLD", minimumForwardMonths: 12,
  minimumDrawdownReductionPct: 20, maximumAnnualReturnShortfallPp: 3,
  valuationBasis: "HYPOTHETICAL_EXIT_AFTER_MODEL_COSTS", evidenceLevel: "PAPER_CANDLE_PROXY",
  automaticTradingEligible: false
});
export const frequencyHash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export const FREQUENCY_PAPER_HASH = frequencyHash(FREQUENCY_PAPER_SPEC);
const period = (date, frequency) => frequency === "M" ? date.slice(0, 7) : weeklyPaperWeek(date);
const shift = (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);

function firstPeriodDate(date, frequency) {
  return researchTradingDates(frequency === "M" ? date.slice(0, 7) + "-01" : weeklyPaperWeek(date), date)[0];
}

function nextPeriodDate(date, frequency) {
  const next = frequency === "M" ? new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 1)).toISOString().slice(0, 10)
    : shift(weeklyPaperWeek(date), 7);
  return researchTradingDates(next, shift(next, 10))[0];
}

export function initialFrequencyPaper(startedAt = new Date().toISOString()) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(startedAt));
  const definitions = FREQUENCY_PAPER_SPEC.frequencies.flatMap(frequency => FREQUENCY_PAPER_SPEC.momentumDays.map(momentumDays => ({ frequency, momentumDays, ruleId: `${frequency}-${momentumDays}` })));
  definitions.push({ frequency: "H", momentumDays: null, ruleId: "SPY_BUY_HOLD" });
  return { schemaVersion: 1, mode: "paper", evidenceLevel: "PAPER_CANDLE_PROXY", specificationHash: FREQUENCY_PAPER_HASH,
    specification: FREQUENCY_PAPER_SPEC, startedAt, updatedAt: startedAt, collectionStatus: "WAITING", automaticTradingEligible: false,
    experiments: definitions.flatMap(definition => FREQUENCY_PAPER_SPEC.costs.map(cost => ({ ...definition, cost,
      id: `${definition.ruleId}-${cost.id}`, eligibleFrom: nextPeriodDate(date, definition.frequency === "M" ? "M" : "W"),
      cashUsdt: 50, equityUsdt: 50, liquidationEquityUsdt: 50, liquidationReturnPct: 0,
      peakEquityUsdt: 50, maxDrawdownPct: 0, realizedPnlUsdt: 0, totalCostUsdt: 0,
      lastDecisionPeriod: null, blockedPeriod: null, lastDecision: null, position: null, closedTrades: 0, trades: [], observations: 0
    }))) };
}

export function frequencyPaperDecisions(series, sessionDate) {
  const prior = researchTradingDates(shift(sessionDate, -10), shift(sessionDate, -1)).at(-1);
  for (const ticker of ["QQQ", "SPY", "SGOV"]) {
    const rows = series[ticker];
    if (!Array.isArray(rows) || rows.length < 253) throw new Error(`Insufficient coverage: ${ticker}`);
    if (rows.some(row => row.date >= sessionDate)) throw new Error(`Only completed daily bars allowed: ${ticker}`);
    const expected = researchTradingDates(rows[0].date, prior);
    if (expected.length !== rows.length || rows.some((row, i) => row.date !== expected[i] || !Number.isFinite(row.close) || row.close <= 0)) {
      throw new Error(`Daily coverage mismatch: ${ticker}`);
    }
  }
  return Object.fromEntries(FREQUENCY_PAPER_SPEC.momentumDays.flatMap(momentumDays => {
    // RSI uses the same trailing 179 calendar-day window as the frozen historical engine.
    const momentum = weeklyEtfDefensiveSignal(series, { momentumDays }, WEEKLY_ETF_ROTATION_UNIVERSE);
    const rsiSeries = Object.fromEntries(Object.entries(series).map(([ticker, rows]) => [ticker, rows.filter(row => row.date >= shift(sessionDate, -179))]));
    const short = weeklyEtfDefensiveSignal(rsiSeries, { momentumDays: 20 }, WEEKLY_ETF_ROTATION_UNIVERSE);
    const allRiskAssets = momentum.allRiskAssets.map(asset => {
      const rsi = short.allRiskAssets.find(item => item.ticker === asset.ticker).rsi;
      return { ...asset, rsi, eligible: asset.momentumPct > 0 && rsi >= 40 };
    });
    const candidates = allRiskAssets.filter(asset => asset.momentumPct > 0 && asset.rsi >= 40)
      .sort((a, b) => b.momentumPct - a.momentumPct || a.ticker.localeCompare(b.ticker));
    const decision = { ...momentum, allRiskAssets, candidates,
      target: candidates[0]?.ticker || (momentum.defensiveAsset.eligible ? "SGOV" : "CASH") };
    return ["W", "M"].map(frequency => [`${frequency}-${momentumDays}`, decision]);
  }));
}

export function frequencyDecisionDue(ledger, sessionDate) {
  if (sessionDate < ledger.eligibleFrom) return false;
  if (ledger.frequency === "H") return firstPeriodDate(sessionDate, "W") === sessionDate && !ledger.trades.length;
  const current = period(sessionDate, ledger.frequency);
  return firstPeriodDate(sessionDate, ledger.frequency) === sessionDate && current !== ledger.lastDecisionPeriod && current !== ledger.blockedPeriod;
}

export function advanceFrequencyPaper(input, snapshot) {
  if (input.specificationHash !== FREQUENCY_PAPER_HASH || frequencyHash(input.specification) !== FREQUENCY_PAPER_HASH) throw new Error("Paper specification mismatch");
  const definitions = initialFrequencyPaper(input.startedAt).experiments;
  const identity = ledgers => ledgers.map(({ id, ruleId, frequency, momentumDays, cost, eligibleFrom }) => ({ id, ruleId, frequency, momentumDays, cost, eligibleFrom }));
  if (frequencyHash(identity(input.experiments)) !== frequencyHash(identity(definitions))) throw new Error("Paper ledger specification mismatch");
  const state = structuredClone(input);
  state.updatedAt = snapshot.at;
  if (!snapshot.regularOpen) { state.collectionStatus = "MARKET_CLOSED"; return state; }
  const age = Date.parse(snapshot.at) - Date.parse(snapshot.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 5 * 60000) throw new Error("Stale Paper proxy mark");
  state.collectionStatus = "AVAILABLE";
  state.sourceHash = snapshot.sourceHash;
  for (const ledger of state.experiments) {
    const { cost } = ledger, rate = cost.roundTripSpreadPct / 200;
    const mark = () => {
      const p = ledger.position;
      const price = p ? snapshot.prices[p.symbol] : 0;
      if (p && !(Number.isFinite(price) && price > 0)) throw new Error("Missing Paper proxy mark");
      const value = p ? p.quantity * price : 0;
      const exitCost = p ? value * rate + cost.gasPerSideUsdt : 0;
      ledger.equityUsdt = ledger.cashUsdt + value;
      ledger.liquidationEquityUsdt = ledger.equityUsdt - exitCost;
      ledger.liquidationReturnPct = (ledger.liquidationEquityUsdt / 50 - 1) * 100;
      if (p) Object.assign(p, { markPrice: price, markedAt: snapshot.observedAt, estimatedExitCostUsdt: exitCost,
        hypotheticalExitNetPnlUsdt: value - exitCost - p.entryCapitalUsdt, valuationBasis: FREQUENCY_PAPER_SPEC.valuationBasis });
    };
    const sell = reason => {
      const p = ledger.position, value = p.quantity * snapshot.prices[p.symbol];
      const fee = value * rate + cost.gasPerSideUsdt;
      if (value <= fee) throw new Error("Insufficient Paper exit proceeds");
      const pnlUsdt = value - fee - p.entryCapitalUsdt;
      ledger.cashUsdt += value - fee; ledger.totalCostUsdt += fee; ledger.realizedPnlUsdt += pnlUsdt; ledger.closedTrades++;
      ledger.trades.push({ side: "SELL", symbol: p.symbol, at: snapshot.at, price: snapshot.prices[p.symbol], quantity: p.quantity,
        costUsdt: fee, pnlUsdt, reason, sourceHash: snapshot.sourceHash });
      ledger.position = null;
    };
    mark();
    const current = ledger.frequency === "H" ? null : period(snapshot.sessionDate, ledger.frequency);
    if (ledger.position && ledger.frequency !== "H" && ledger.position.hypotheticalExitNetPnlUsdt / ledger.position.entryCapitalUsdt * 100 <= -8) {
      sell("DISASTER_STOP_PROXY"); ledger.blockedPeriod = current;
    }
    if (frequencyDecisionDue(ledger, snapshot.sessionDate)) {
      const decision = ledger.frequency === "H" ? { target: "SPY", signalDate: null } : snapshot.targets[ledger.ruleId];
      if (decision) {
        const target = typeof decision === "string" ? decision : decision.target;
        if (!["QQQ", "SPY", "SGOV", "CASH"].includes(target)) throw new Error("Invalid Paper target");
        ledger.lastDecisionPeriod = current; ledger.lastDecision = decision;
        if ((ledger.position?.symbol || "CASH") !== target) {
          if (ledger.position) sell("PERIOD_REBALANCE");
          if (target !== "CASH") {
            const price = snapshot.prices[target], budget = ledger.cashUsdt, fee = budget * rate + cost.gasPerSideUsdt;
            if (!Number.isFinite(price) || !(price > 0) || budget <= fee) throw new Error("Invalid Paper entry capital or price");
            ledger.position = { symbol: target, openedAt: snapshot.at, entryPrice: price, entryCapitalUsdt: budget, entryCostUsdt: fee, quantity: (budget - fee) / price };
            ledger.cashUsdt = 0; ledger.totalCostUsdt += fee;
            ledger.trades.push({ side: "BUY", symbol: target, at: snapshot.at, price, quantity: ledger.position.quantity, costUsdt: fee,
              signalDate: decision.signalDate || null, sourceHash: snapshot.sourceHash });
          }
        }
      }
    }
    mark();
    ledger.peakEquityUsdt = Math.max(ledger.peakEquityUsdt, ledger.liquidationEquityUsdt);
    ledger.maxDrawdownPct = Math.max(ledger.maxDrawdownPct, (1 - ledger.liquidationEquityUsdt / ledger.peakEquityUsdt) * 100);
    ledger.observations++;
  }
  state.lastObservation = { at: snapshot.at, observedAt: snapshot.observedAt, sessionDate: snapshot.sessionDate };
  return state;
}
