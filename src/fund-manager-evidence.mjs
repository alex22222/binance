import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function beijingDate(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

function number(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

export function paperSummary(state, tradingDate, newYorkDate) {
  if (!state) return { status: "MISSING", daily: null, position: null };
  const trades = state.trades || [];
  const daily = trades.filter(({ closedAt }) => closedAt && newYorkDate(Date.parse(closedAt)) === tradingDate);
  const pnl = daily.map(({ pnlUsdt }) => number(pnlUsdt));
  const known = pnl.every((value) => value != null);
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  const gain = wins.reduce((sum, value) => sum + value, 0);
  const loss = -losses.reduce((sum, value) => sum + value, 0);
  const coversDay = state.lastObservation?.sessionDate >= tradingDate && state.startedAt
    && newYorkDate(Date.parse(state.startedAt)) <= tradingDate;
  const position = state.position;
  return {
    status: coversDay ? "AVAILABLE" : "STALE_OR_PARTIAL",
    mode: state.mode,
    evidenceLevel: state.evidenceLevel || "UNLABELED",
    strategyId: state.strategyId,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    lastObservation: state.lastObservation,
    daily: {
      observedClosedTrades: daily.length,
      realizedPnlUsdt: coversDay && known ? pnl.reduce((sum, value) => sum + value, 0) : null,
      winRatePct: coversDay && known && pnl.length ? wins.length / pnl.length * 100 : null,
      profitFactor: coversDay && known && loss > 0 ? gain / loss : null,
      trades: daily
    },
    cumulative: {
      closedTrades: trades.length,
      realizedPnlUsdt: number(state.realizedPnlUsdt),
      totalCostUsdt: number(state.totalCostUsdt),
      equityUsdt: number(state.equityUsdt),
      totalReturnPct: number(state.totalReturnPct)
    },
    position: position ? {
      symbol: position.symbol, openedAt: position.openedAt,
      notionalUsdt: number(position.notionalUsdt ?? position.entryCapitalUsdt),
      unrealizedPnlUsdt: number(position.unrealizedPnlUsdt),
      markedAt: position.markedAt,
      markTradingDate: position.markedAt ? newYorkDate(Date.parse(position.markedAt)) : null,
      markPrice: number(position.markPrice),
      initialRiskPct: number(position.initialRiskPct)
    } : null,
    limitations: [
      "Paper fills and marks are candle proxies, not executable or actual fills.",
      "Unrealized PnL is a snapshot since entry, not the daily change; no portfolio NAV drawdown is inferred.",
      "AVAILABLE describes snapshot date coverage, not continuous successful collection."
    ]
  };
}

export async function collectFundManagerEvidence(root, now = Date.now()) {
  const { buildTradingReview, readTradingReviewRecords } = await import(pathToFileURL(resolve(root, "src/trade-review.mjs")));
  const { latestCompletedTradingDate, newYorkSessionBounds, newYorkDate, tradingDates } = await import(pathToFileURL(resolve(root, "src/strategy-data.mjs")));
  const errors = [];
  async function optionalJson(path) {
    try { return JSON.parse(await readFile(resolve(root, path), "utf8")); }
    catch (error) { errors.push({ path, error: error.code || "INVALID_JSON" }); return null; }
  }
  const config = JSON.parse(await readFile(resolve(root, "config.json"), "utf8"));
  const tradingDate = latestCompletedTradingDate(now);
  const bounds = newYorkSessionBounds(tradingDate);
  const startMs = bounds.openMs - 9.5 * 60 * 60_000;
  const endMs = Math.min(startMs + 86_400_000, now);
  const [state, control, archive, turtle, weekly, shadow] = await Promise.all([
    optionalJson(config.stateFile), optionalJson("state/strategy-control.json"),
    optionalJson("state/trade-reviews/latest.json"), optionalJson("state/turtle-paper/latest.json"),
    optionalJson("state/weekly-etf-rotation-paper/latest.json"), optionalJson("state/shadow-outcomes/latest.json")
  ]);
  let trace = null;
  try { trace = await readTradingReviewRecords(resolve(root, config.traceFile), { startMs, endMs }); }
  catch (error) { errors.push({ path: config.traceFile, error: error.code || "TRACE_READ_FAILED" }); }
  const review = trace && state ? buildTradingReview({
    records: trace.records, state, tradingDate, generatedAt: new Date(now).toISOString(),
    reviewPhase: newYorkDate(now) === tradingDate ? "PRELIMINARY" : "FINAL",
    sessionDates: tradingDates(new Date(startMs - 60 * 86_400_000).toISOString().slice(0, 10), tradingDate),
    externalMarket: archive?.tradingDate === tradingDate ? archive.externalMarket : null,
    premarketBrief: archive?.tradingDate === tradingDate ? archive.premarketBrief : null
  }) : null;
  const { records, ...coverage } = trace || {};
  const hasCoverage = trace && trace.windowRecords > 0 && trace.malformedLines === 0 && trace.maxGapMs <= 15 * 60_000;
  return {
    schemaVersion: 1,
    reportDate: beijingDate(now),
    collectedAt: new Date(now).toISOString(),
    source: "PRODUCTION_VPS_READ_ONLY",
    tradingDate,
    window: { timeZone: "America/New_York", startUtc: new Date(startMs).toISOString(), endUtc: new Date(endMs).toISOString(), completedCalendarDay: endMs === startMs + 86_400_000 },
    archive: { tradingDate: archive?.tradingDate || null, generatedAt: archive?.generatedAt || null, stale: archive?.tradingDate !== tradingDate },
    live: {
      status: !review ? "MISSING" : hasCoverage ? "OBSERVED" : "INCOMPLETE_TRACE",
      coverage,
      mode: config.mode,
      stateUpdatedAt: state?.updatedAt || null,
      entriesPaused: control?.entriesPaused ?? null,
      positionsKnown: Boolean(state && (Array.isArray(state.positions) || Object.hasOwn(state, "position"))),
      hasPendingOrder: state ? Boolean(state.pendingOrder) : null,
      hasApprovalRequest: state ? Boolean(state.approvalRequest) : null,
      emergencyStop: state ? Boolean(state.emergencyStop?.active) : null,
      lastError: state?.lastError ? "PRESENT_REQUIRES_INSPECTION" : null,
      daily: review ? { ...review.daily, realizedPnlUsdt: hasCoverage ? review.daily.realizedPnlUsdt : null } : null,
      observedFillPnlUsdt: review?.daily.realizedPnlUsdt ?? null,
      review,
      limitations: ["Coverage is based on retained trace events and maximum gaps; OBSERVED is not an exchange reconciliation.", "The review covers the New York calendar day so far; current positions may have a later snapshot timestamp."]
    },
    paper: [paperSummary(turtle, tradingDate, newYorkDate), paperSummary(weekly, tradingDate, newYorkDate)],
    shadow: shadow ? {
      generatedAt: shadow.generatedAt, method: shadow.method,
      candidates: shadow.candidates, horizons: shadow.horizons,
      limitations: ["Historical aggregate; not daily portfolio PnL. COUNTERFACTUAL_NON_EXECUTING is never added to Live or Paper."]
    } : null,
    errors
  };
}

if (process.env.FUND_MANAGER_COLLECT === "1") {
  console.log(JSON.stringify(await collectFundManagerEvidence(process.cwd())));
}
