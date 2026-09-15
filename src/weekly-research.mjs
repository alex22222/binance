import { createHash } from "node:crypto";

export const RESEARCH_AXES = ["macro", "gold", "bonds", "politics", "polymarket", "technical"];
export const REQUIRED_WEEKLY_SOURCES = ["fred-FEDFUNDS", "fred-CPIAUCSL", "fred-UNRATE", "fred-DGS2", "fred-DGS10", "fred-DFII10", "price-GLD", "price-TLT", "gamma-markets", "whitehouse-news"];
export const WEEKLY_POLICY = Object.freeze({
  version: "weekly-research-v1", minBars: 756, minCoverage: 0.98,
  minOosBars: 252, minClosedTrades: 20, minProfitFactor: 1.2,
  maxDrawdownPct: 15, costBpsPerSide: 50, stressCostBpsPerSide: 100,
  minPositiveSlices: 2, maxEvidenceAgeHours: 72
});
export const RESEARCH_RULES = ["daily-momentum-20-60", "daily-close-breakout-55-20"];
export function researchProposalSpec(candidate) {
  return {
    symbol: candidate.symbol, rule: candidate.rule, mode: "PAPER_RESEARCH_ONLY", leverage: 1,
    entry: candidate.rule === "daily-momentum-20-60" ? "前一完整交易日收盘高于60日均线且20日动量为正，次日开盘研究入场。" : "前一完整交易日收盘突破此前55日收盘最高，次日开盘研究入场。",
    exit: candidate.rule === "daily-momentum-20-60" ? "前一完整交易日趋势条件失效，次日开盘研究退出。" : "前一完整交易日收盘跌破此前20日收盘最低，次日开盘研究退出。",
    sizing: "仅独立虚拟资金的单标的全额复利研究，不加仓不加杠杆；不占用实盘资金，不代表符合现有实盘风险预算。"
  };
}
export const hashResearch = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const positive = (value) => Number.isFinite(value) && value > 0;

export function validateDailyHistory(bars, expectedDates) {
  const failures = [];
  if (!Array.isArray(bars) || bars.length < WEEKLY_POLICY.minBars) failures.push("HISTORY_TOO_SHORT");
  const dates = (bars || []).map((bar) => bar.date);
  if (new Set(dates).size !== dates.length || dates.some((date, i) => i && date <= dates[i - 1])) failures.push("UNSORTED_OR_DUPLICATE");
  if ((bars || []).some((bar) => !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) || !positive(bar.open) || !positive(bar.close))) failures.push("INVALID_PRICE");
  const expected = new Set(expectedDates);
  const coverage = expected.size ? new Set(dates.filter((date) => expected.has(date))).size / expected.size : 0;
  if (coverage < WEEKLY_POLICY.minCoverage) failures.push("INCOMPLETE_CALENDAR");
  if (!expectedDates.length || dates.at(-1) !== expectedDates.at(-1)) failures.push("STALE_OR_FUTURE_HISTORY");
  if (dates.some((date) => !expected.has(date))) failures.push("UNEXPECTED_SESSION");
  return { passed: !failures.length, failures, coverage, bars: bars?.length || 0, firstDate: dates[0] || null, lastDate: dates.at(-1) || null };
}

// Fixed research-only rules: prior completed close -> next session open. No parameter search.
export function backtestResearchRule(bars, { rule, startIndex = 60, endIndex = bars.length - 1, costBpsPerSide = 50 } = {}) {
  if (!RESEARCH_RULES.includes(rule) || !Number.isInteger(startIndex) || startIndex < 60 || endIndex < startIndex || endIndex >= bars.length
    || !Number.isFinite(costBpsPerSide) || costBpsPerSide < 0 || costBpsPerSide >= 10000
    || bars.some((bar, i) => !positive(bar.open) || !positive(bar.close) || (i && bar.date <= bars[i - 1].date))) throw new Error("Invalid research backtest input");
  const cost = costBpsPerSide / 10000;
  let cash = 1, units = 0, entryCapital = 0, entryDate = null, peak = 1, drawdown = 0, totalCosts = 0;
  const trades = [], equity = [];
  for (let i = startIndex; i <= endIndex; i += 1) {
    const prior = bars[i - 1];
    const previousCloses = bars.slice(i - 60, i).map((bar) => bar.close);
    const trend = prior.close > previousCloses.reduce((sum, value) => sum + value, 0) / 60 && prior.close > bars[i - 21].close;
    const entry = rule === "daily-momentum-20-60" ? trend : prior.close > Math.max(...bars.slice(i - 56, i - 1).map((bar) => bar.close));
    const exit = rule === "daily-momentum-20-60" ? !trend : prior.close < Math.min(...bars.slice(i - 21, i - 1).map((bar) => bar.close));
    if (units && exit) {
      const gross = units * bars[i].open;
      totalCosts += gross * cost;
      cash = gross * (1 - cost);
      trades.push({ entryDate, exitDate: bars[i].date, pnlInitial: cash - entryCapital, returnPct: (cash / entryCapital - 1) * 100, reason: "RULE_EXIT" });
      units = 0;
    } else if (!units && entry) {
      entryCapital = cash; entryDate = bars[i].date;
      totalCosts += cash * cost;
      units = cash * (1 - cost) / bars[i].open; cash = 0;
    }
    if (i === endIndex && units) {
      const gross = units * bars[i].close;
      totalCosts += gross * cost;
      cash = gross * (1 - cost);
      trades.push({ entryDate, exitDate: bars[i].date, pnlInitial: cash - entryCapital, returnPct: (cash / entryCapital - 1) * 100, reason: "TERMINAL_LIQUIDATION" });
      units = 0;
    }
    const nav = cash + units * bars[i].close;
    peak = Math.max(peak, nav); drawdown = Math.max(drawdown, 1 - nav / peak);
    equity.push({ date: bars[i].date, nav });
  }
  const gain = trades.reduce((sum, trade) => sum + Math.max(trade.pnlInitial, 0), 0);
  const loss = -trades.reduce((sum, trade) => sum + Math.min(trade.pnlInitial, 0), 0);
  return { startDate: bars[startIndex].date, endDate: bars[endIndex].date, observations: equity.length,
    returnPct: (cash - 1) * 100, benchmarkReturnPct: ((1 - cost) ** 2 * bars[endIndex].close / bars[startIndex].open - 1) * 100,
    maxDrawdownPct: drawdown * 100, closedTrades: trades.filter((trade) => trade.reason === "RULE_EXIT").length,
    profitFactor: loss > 0 ? gain / loss : null, totalCostPctInitial: totalCosts * 100, trades, equity };
}

export function evaluateCandidate(history, rule, quality) {
  if (!quality.passed) return { rule, passed: false, failures: quality.failures, quality };
  const split = Math.floor(history.length * 0.65);
  const options = { rule, costBpsPerSide: WEEKLY_POLICY.costBpsPerSide };
  const training = backtestResearchRule(history, { ...options, endIndex: split - 1 });
  const oos = backtestResearchRule(history, { ...options, startIndex: split });
  const stress = backtestResearchRule(history, { ...options, startIndex: split, costBpsPerSide: WEEKLY_POLICY.stressCostBpsPerSide });
  const slices = Array.from({ length: 3 }, (_, index) => backtestResearchRule(history, { ...options,
    startIndex: split + Math.floor((history.length - split) * index / 3),
    endIndex: split + Math.floor((history.length - split) * (index + 1) / 3) - 1 }));
  const failures = [];
  if (oos.observations < WEEKLY_POLICY.minOosBars) failures.push("OOS_TOO_SHORT");
  if (oos.closedTrades < WEEKLY_POLICY.minClosedTrades) failures.push("INSUFFICIENT_CLOSED_TRADES");
  if (!(oos.profitFactor >= WEEKLY_POLICY.minProfitFactor)) failures.push("PF_BELOW_GATE_OR_UNDEFINED");
  if (!(oos.returnPct > 0 && oos.returnPct > oos.benchmarkReturnPct)) failures.push("NO_POSITIVE_EXCESS_RETURN");
  if (oos.maxDrawdownPct > WEEKLY_POLICY.maxDrawdownPct) failures.push("DRAWDOWN_EXCEEDED");
  if (!(stress.returnPct > 0)) failures.push("COST_STRESS_FAILED");
  if (slices.filter((slice) => slice.returnPct > 0).length < WEEKLY_POLICY.minPositiveSlices) failures.push("UNSTABLE_SUBPERIODS");
  return { rule, quality, passed: !failures.length, failures, training, oos, stress, slices,
    evidenceLevel: "HISTORICAL_ADJUSTED_DAILY_PROXY", validationType: "RETROSPECTIVE_TIME_SPLIT_NOT_PUBLISH_FORWARD" };
}

export function evidenceGates(bundle, nowMs = Date.now()) {
  const reasons = [];
  if (bundle.universeSource !== "PRODUCTION_CONFIG_READ_ONLY") reasons.push("UNIVERSE_NOT_PRODUCTION_VERIFIED");
  if (nowMs < Date.parse(bundle.collectedAt) || nowMs - Date.parse(bundle.collectedAt) > WEEKLY_POLICY.maxEvidenceAgeHours * 3600000 || !Number.isFinite(Date.parse(bundle.collectedAt))) reasons.push("BUNDLE_STALE_OR_INVALID");
  for (const axis of RESEARCH_AXES) {
    if (!bundle.sources.some((source) => source.axis === axis && source.status === "AVAILABLE"
      && source.contentHash && Date.parse(source.retrievedAt) <= nowMs
      && nowMs - Date.parse(source.retrievedAt) <= WEEKLY_POLICY.maxEvidenceAgeHours * 3600000)) reasons.push(`MISSING_AXIS:${axis}`);
  }
  // A news feed is not a substitute for missing inflation, employment or yield data.
  for (const id of REQUIRED_WEEKLY_SOURCES) if (!bundle.sources.some((source) => source.id === id && source.status === "AVAILABLE")) reasons.push(`MISSING_REQUIRED_SOURCE:${id}`);
  // A short-history IPO is excluded individually; it must not invalidate an unrelated qualified candidate.
  for (const symbol of bundle.universe) if (!bundle.quality[symbol]) reasons.push(`UNASSESSED_HISTORY:${symbol}`);
  return reasons;
}

export function validateWeeklyAnalysis(bundle, analysis, nowMs = Date.now()) {
  const failures = evidenceGates(bundle, nowMs);
  const errors = [];
  const checkText = (text) => typeof text === "string" && text.trim().length >= 12;
  if (analysis.bundleHash !== hashResearch(bundle)) errors.push("Evidence bundle hash mismatch");
  if (!checkText(analysis.summary) || !checkText(analysis.counterargument) || !checkText(analysis.invalidation)) errors.push("Missing conclusion, counterargument or invalidation");
  if (!["WITHHOLD", "PAPER_RESEARCH_PROPOSAL"].includes(analysis.decision)) errors.push("Only research decisions are allowed");
  for (const axis of RESEARCH_AXES) {
    const claim = analysis.claims?.find((item) => item.axis === axis);
    if (!claim || !checkText(claim.statement) || !checkText(claim.transmission) || !Array.isArray(claim.evidenceIds)) { errors.push(`Missing structured claim:${axis}`); continue; }
    const sources = claim.evidenceIds.map((id) => bundle.sources.find((source) => source.id === id));
    if (sources.some((source) => !source || source.axis !== axis)) errors.push(`Invalid evidence reference:${axis}`);
    if (!claim.evidenceIds.length && !checkText(claim.gap)) errors.push(`Unexplained evidence gap:${axis}`);
    if (!sources.length || sources.some((source) => source?.status !== "AVAILABLE")) failures.push(`UNSUPPORTED_CLAIM:${axis}`);
  }
  const candidate = bundle.candidates.find((item) => item.id === analysis.candidateId);
  if (analysis.decision === "PAPER_RESEARCH_PROPOSAL") {
    if (!candidate?.passed || !bundle.universe.includes(candidate?.symbol)) errors.push("Candidate has not passed deterministic gates");
    if (failures.length) errors.push("Evidence gates forbid a proposal");
    if (!checkText(analysis.entry) || !checkText(analysis.exit) || !checkText(analysis.sizing)) errors.push("Missing entry, exit or risk envelope");
    if (candidate && ["entry", "exit", "sizing"].some((key) => analysis[key] !== researchProposalSpec(candidate)[key])) errors.push("Proposal rules must exactly match the backtested artifact");
    if (analysis.independentReview?.verdict !== "PASS" || !checkText(analysis.independentReview?.limitations)
      || !analysis.independentReview?.reviewer || analysis.independentReview.reviewer === analysis.author) errors.push("Independent checker review required");
  }
  if (errors.length) throw new Error(errors.join("; "));
  return { status: analysis.decision, blockers: [...new Set(failures)], liveAuthorized: false, candidateId: candidate?.id || null };
}
