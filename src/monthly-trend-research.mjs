import { createHash } from "node:crypto";
import { weeklyEtfDefensiveSignal, weeklyPaperWeek } from "./weekly-etf-rotation-paper.mjs";
import { researchTradingDates } from "./weekly-research-calendar.mjs";

export const MONTHLY_RESEARCH_SPEC = Object.freeze({
  version: 1,
  primary: "A1",
  comparator: "A2",
  A1: "VTI completed month-end adjusted close > SMA of 10 completed month ends; otherwise SGOV",
  A2: "VTI 12-month total return > SGOV 12-month total return; otherwise SGOV",
  timing: "Signal at completed month end; hypothetical fill at next observed regular daily open",
  evidenceLevel: "HISTORICAL_PROXY",
  initialCapitalUsd: 50,
  terminalLiquidation: true,
  minDrawdownReductionPct: 20,
  maxAnnualReturnShortfallPp: 3,
  minimumForwardMonthEnds: 12,
  minimumCommonSessions: 504,
  minimumRecentSessions: 200,
  automaticTradingEligible: false
});

export function researchHash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function monthNumber(date) {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function validPrice(price) {
  return Number.isFinite(price) && price > 0;
}

const monthSessionCache = new Map();
function monthSessions(date) {
  const month = date.slice(0, 7);
  if (!monthSessionCache.has(month)) {
    const end = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).toISOString().slice(0, 10);
    monthSessionCache.set(month, researchTradingDates(`${month}-01`, end));
  }
  return monthSessionCache.get(month);
}

export function monthlyTrendDecision(rows, executionIndex, variant = "A1") {
  if (!["A1", "A2"].includes(variant)) throw new Error("Unknown monthly rule");
  const current = rows[executionIndex];
  const previous = rows[executionIndex - 1];
  if (!current || !previous || current.date.slice(0, 7) === previous.date.slice(0, 7)) return null;
  const monthEnds = [];
  for (let index = 0; index < executionIndex; index += 1) {
    if (rows[index].date.slice(0, 7) !== rows[index + 1].date.slice(0, 7)) monthEnds.push(rows[index]);
  }
  // A first month that starts after its first scheduled session is partial.
  if (rows[0].date !== monthSessions(rows[0].date)[0]) monthEnds.shift();
  const requiredMonths = variant === "A1" ? 10 : 13;
  const selected = monthEnds.slice(-requiredMonths);
  const reasons = [];
  if (current.date !== monthSessions(current.date)[0]) reasons.push("EXECUTION_NOT_FIRST_SESSION");
  if (selected.some((row) => row.date !== monthSessions(row.date).at(-1))) reasons.push("MISSING_MONTH_END_SESSION");
  if (selected.length < requiredMonths) reasons.push("INSUFFICIENT_COMPLETE_MONTHS");
  if (selected.some((row, index) => index && monthNumber(row.date) - monthNumber(selected[index - 1].date) !== 1)
    || monthNumber(current.date) - monthNumber(previous.date) !== 1) reasons.push("NON_CONSECUTIVE_MONTHS");
  const inputs = selected.map((row) => ({
    date: row.date,
    VTI: row.prices.VTI?.close ?? null,
    ...(variant === "A2" ? { SGOV: row.prices.SGOV?.close ?? null } : {})
  }));
  if (inputs.some((row) => !validPrice(row.VTI) || (variant === "A2" && !validPrice(row.SGOV)))) {
    reasons.push("MISSING_MONTH_END_PRICE");
  }
  let target = null;
  let indicators = null;
  if (!reasons.length) {
    if (variant === "A1") {
      const sma10 = inputs.reduce((sum, row) => sum + row.VTI, 0) / 10;
      indicators = { close: inputs.at(-1).VTI, sma10 };
      target = inputs.at(-1).VTI > sma10 ? "VTI" : "SGOV";
    } else {
      indicators = {
        vtiReturn12m: inputs.at(-1).VTI / inputs[0].VTI - 1,
        sgovReturn12m: inputs.at(-1).SGOV / inputs[0].SGOV - 1
      };
      target = indicators.vtiReturn12m > indicators.sgovReturn12m ? "VTI" : "SGOV";
    }
  }
  return {
    variant, signalDate: previous.date, executionDate: current.date,
    target, indicators, inputs, inputHash: researchHash(inputs), reasons,
    automaticTradingEligible: false
  };
}

function dailyPrice(row, ticker, field) {
  const value = row.prices[ticker]?.[field];
  if (!validPrice(value)) throw new Error(`Missing daily price: ${row.date} ${ticker} ${field}`);
  return value;
}

function summarize(curve, capital, trades, closedReturns) {
  const years = (Date.parse(curve.at(-1).date) - Date.parse(curve[0].date)) / (365.2425 * 86_400_000);
  let peak = capital;
  let maximumDrawdown = 0;
  let previous = capital;
  const dailyReturns = curve.map(({ equityUsd }) => {
    peak = Math.max(peak, equityUsd);
    maximumDrawdown = Math.max(maximumDrawdown, 1 - equityUsd / peak);
    const value = equityUsd / previous - 1;
    previous = equityUsd;
    return value;
  });
  const gains = closedReturns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = -closedReturns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  return {
    startDate: curve[0].date, endDate: curve.at(-1).date, tradingDays: curve.length,
    endingEquityUsd: previous,
    totalReturnPct: (previous / capital - 1) * 100,
    cagrPct: years > 0 ? ((previous / capital) ** (1 / years) - 1) * 100 : null,
    maxDrawdownPct: maximumDrawdown * 100,
    worstDayPct: Math.min(...dailyReturns) * 100,
    totalCostUsd: trades.reduce((sum, trade) => sum + trade.costUsd, 0),
    orders: trades.length,
    switches: trades.filter(({ side, reason }) => side === "SELL" && reason === "REBALANCE").length,
    closedTrades: closedReturns.length,
    terminalLiquidations: trades.filter(({ reason }) => reason === "TERMINAL_LIQUIDATION").length,
    profitFactor: losses > 0 ? gains / losses : null,
    profitFactorNote: losses > 0 ? null : "NO_LOSING_CLOSED_TRADES",
    annualizedTradedNotional: years > 0 ? trades.reduce((sum, trade) => sum + trade.notionalUsd, 0) / capital / years : null
  };
}

export function backtestResearchStrategy({
  rows, strategy, startDate, endDate = rows.at(-1)?.date,
  roundTripCostPct = 0.45, initialCapitalUsd = 50
}) {
  if (!Number.isFinite(roundTripCostPct) || roundTripCostPct < 0 || roundTripCostPct >= 100) throw new Error("Invalid research cost");
  if (!(Number.isFinite(initialCapitalUsd) && initialCapitalUsd > 0)) throw new Error("Invalid research capital");
  if (!["A1", "A2", "VTI_BUY_HOLD", "SGOV_BUY_HOLD", "WEEKLY_DEFENSE_PROXY"].includes(strategy)) {
    throw new Error("Unknown research strategy");
  }
  if (!rows.length || rows.some((row, index) => !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
    || (index && row.date <= rows[index - 1].date))) throw new Error("Daily rows must be unique and ordered");
  const rate = roundTripCostPct / 200;
  let cash = initialCapitalUsd;
  let holding = null;
  let units = 0;
  let entryCapital = 0;
  let entryPrice = 0;
  const trades = [];
  const decisions = [];
  const equityCurve = [];
  const closedReturns = [];
  const rejections = [];
  const sell = (row, price, reason) => {
    const gross = units * price;
    const costUsd = gross * rate;
    cash = gross - costUsd;
    trades.push({ side: "SELL", ticker: holding, date: row.date, price, quantity: units, costUsd, notionalUsd: gross, reason });
    if (reason !== "TERMINAL_LIQUIDATION") closedReturns.push(cash - entryCapital);
    holding = null;
    units = 0;
  };
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if ((startDate && row.date < startDate) || row.date > endDate) continue;
    let decision = null;
    if (strategy.endsWith("BUY_HOLD") && !equityCurve.length) {
      decision = { target: strategy.split("_")[0], executionDate: row.date, signalDate: null };
    } else if (["A1", "A2"].includes(strategy)) {
      decision = monthlyTrendDecision(rows, index, strategy);
    } else if (strategy === "WEEKLY_DEFENSE_PROXY"
      && (weeklyPaperWeek(row.date) !== weeklyPaperWeek(rows[index - 1].date) || !equityCurve.length)) {
      const series = Object.fromEntries(["QQQ", "VTI", "VTV", "SPY", "SGOV"].map((ticker) => [
        ticker, rows.slice(0, index).filter(({ prices }) => prices[ticker]).map((item) => ({ date: item.date, close: item.prices[ticker].close }))
      ]));
      decision = { ...weeklyEtfDefensiveSignal(series), executionDate: row.date };
    }
    if (decision) {
      decisions.push(decision);
      if (!decision.target) rejections.push(decision);
      else if (decision.target !== (holding || "CASH")) {
        if (holding) sell(row, dailyPrice(row, holding, "open"), "REBALANCE");
        if (decision.target !== "CASH") {
          entryCapital = cash;
          const costUsd = cash * rate;
          entryPrice = dailyPrice(row, decision.target, "open");
          units = (cash - costUsd) / entryPrice;
          holding = decision.target;
          trades.push({ side: "BUY", ticker: holding, date: row.date, signalDate: decision.signalDate,
            price: entryPrice, quantity: units, costUsd, notionalUsd: cash, reason: "REBALANCE" });
          cash = 0;
        }
      }
    }
    // Daily-open-only proxy: deliberately does not pretend to reproduce intraday Live stops.
    if (strategy === "WEEKLY_DEFENSE_PROXY" && holding && dailyPrice(row, holding, "open") <= entryPrice * 0.92) {
      sell(row, dailyPrice(row, holding, "open"), "DAILY_OPEN_DISASTER_PROXY");
    }
    equityCurve.push({ date: row.date, equityUsd: holding ? units * dailyPrice(row, holding, "close") : cash, holding: holding || "CASH" });
  }
  if (equityCurve.length < 2) throw new Error("Insufficient evaluation rows");
  if (holding) {
    const row = rows.find(({ date }) => date === equityCurve.at(-1).date);
    sell(row, dailyPrice(row, holding, "close"), "TERMINAL_LIQUIDATION");
    equityCurve.at(-1).equityUsd = cash;
  }
  return {
    strategy, evidenceLevel: "HISTORICAL_PROXY", automaticTradingEligible: false,
    roundTripCostPct, initialCapitalUsd,
    costModel: "All-in percentage proxy, half per side; no measured token quote or fill",
    metrics: summarize(equityCurve, initialCapitalUsd, trades, closedReturns),
    decisions, rejections, trades, equityCurve,
    limitations: strategy === "WEEKLY_DEFENSE_PROXY" ? [
      "Weekly selection reused; 8% disaster exit checked only at daily open, not intraday",
      "No RFQ failure, quote gate, approval delay, intraday execution or complete Live replication",
      "Wilder RSI uses downloaded history; Live uses a rolling approximately 180-calendar-day window"
    ] : ["Adjusted ETF historical proxy, not token execution or independent forward evidence"]
  };
}

function evaluateGate(candidate, benchmark) {
  const drawdownReductionPct = benchmark.maxDrawdownPct > 0
    ? (1 - candidate.maxDrawdownPct / benchmark.maxDrawdownPct) * 100 : null;
  const annualReturnShortfallPp = benchmark.cagrPct - candidate.cagrPct;
  return {
    drawdownReductionPct, annualReturnShortfallPp,
    passed: drawdownReductionPct != null && drawdownReductionPct >= MONTHLY_RESEARCH_SPEC.minDrawdownReductionPct
      && annualReturnShortfallPp <= MONTHLY_RESEARCH_SPEC.maxAnnualReturnShortfallPp
  };
}

export function buildMonthlyResearchReport({ rows, roundTripCosts = [0.35, 0.45, 1], generatedAt = new Date().toISOString() }) {
  if (!Array.isArray(roundTripCosts) || !roundTripCosts.length || roundTripCosts.some((value) => !Number.isFinite(value) || value < 0 || value >= 100)) {
    throw new Error("Invalid research cost scenarios");
  }
  const firstIndex = rows.findIndex((row, index) => {
    if (!index || !["VTI", "SGOV", "QQQ", "SPY", "VTV"].every((ticker) => row.prices[ticker])) return false;
    return monthlyTrendDecision(rows, index, "A2")?.target != null;
  });
  if (firstIndex < 0) throw new Error("Insufficient common ETF history for A2; do not synthesize SGOV");
  const firstDate = rows[firstIndex].date;
  const lastDate = rows.at(-1).date;
  for (const row of rows.slice(firstIndex)) {
    for (const ticker of ["VTI", "SGOV", "QQQ", "SPY", "VTV"]) {
      dailyPrice(row, ticker, "open");
      dailyPrice(row, ticker, "close");
    }
  }
  const ranges = { common: { startDate: firstDate, endDate: lastDate } };
  // Fixed calendar regimes, not optimized splits or a claim of untouched out-of-sample data.
  for (const [label, start, end] of [["year2022", "2022-01-01", "2022-12-31"], ["since2023", "2023-01-01", lastDate]]) {
    if (start <= end && firstDate <= start && lastDate >= researchTradingDates(start, end).at(-1)) {
      const first = rows.find(({ date }) => date >= start);
      const final = rows.filter(({ date }) => date <= end).at(-1);
      if (first && final && first.date < final.date) ranges[label] = { startDate: first.date, endDate: final.date };
    }
  }
  const strategies = ["A1", "A2", "VTI_BUY_HOLD", "SGOV_BUY_HOLD", "WEEKLY_DEFENSE_PROXY"];
  const periods = Object.fromEntries(Object.entries(ranges).map(([name, range]) => [name, {
    ...range,
    scenarios: roundTripCosts.map((roundTripCostPct) => {
      const results = Object.fromEntries(strategies.map((strategy) => [strategy,
        backtestResearchStrategy({ rows, strategy, ...range, roundTripCostPct })
      ]));
      const gates = Object.fromEntries(["A1", "A2"].map((variant) => {
        const gate = evaluateGate(results[variant].metrics, results.VTI_BUY_HOLD.metrics);
        return [variant, { ...gate, rejectedDecisions: results[variant].rejections.length,
          passed: gate.passed && results[variant].rejections.length === 0 }];
      }));
      return { roundTripCostPct, results, gates };
    })
  }]));
  const specification = { ...MONTHLY_RESEARCH_SPEC, roundTripCostsPct: [...roundTripCosts],
    evaluationRanges: ranges, requiredPeriods: ["common", "year2022", "since2023"],
    gateCombination: "ALL_COST_SCENARIOS_AND_FIXED_REGIMES" };
  const coverageBlockers = specification.requiredPeriods.filter((name) => !periods[name]).map((name) => `MISSING_REQUIRED_PERIOD:${name}`);
  if (periods.common.scenarios[0].results.A1.metrics.tradingDays < specification.minimumCommonSessions) coverageBlockers.push("COMMON_PERIOD_TOO_SHORT");
  if (periods.since2023 && periods.since2023.scenarios[0].results.A1.metrics.tradingDays < specification.minimumRecentSessions) coverageBlockers.push("RECENT_PERIOD_TOO_SHORT");
  return {
    schemaVersion: 1, generatedAt, specification,
    specificationHash: researchHash(specification), inputHash: researchHash(rows),
    evidenceLevel: "HISTORICAL_PROXY", automaticTradingEligible: false,
    coverageBlockers,
    verdicts: Object.fromEntries(["A1", "A2"].map((variant) => [variant, coverageBlockers.length
      ? "INSUFFICIENT_HISTORICAL_COVERAGE"
      : Object.values(periods).every((period) => period.scenarios.every(({ gates }) => gates[variant].passed))
        ? "HISTORICAL_GATE_PASSED_FORWARD_REQUIRED" : "HISTORICAL_GATE_FAILED"
    ])),
    forwardEvidence: { monthEndDecisions: 0, tokenQuotes: 0, liveFills: 0, minimumMonthEnds: 12 },
    limitations: [
      "2010-era short-bill proxy not supplied; no fabricated pre-inception SGOV",
      "Common A1/A2 comparison starts only after 13 real SGOV month ends; 2020 crash is not tested",
      "Data loader validates every expected session against the existing 2020-2028 NYSE research calendar",
      "Historical revised adjusted prices are not point-in-time vintages",
      "Weekly comparator is a daily proxy, not the complete Live risk and execution system",
      "Historical gate results cannot authorize forward Paper or Live promotion"
    ],
    periods
  };
}
