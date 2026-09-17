import { nyseSessionPlan } from "./strategy.mjs";
import {
  WEEKLY_ETF_ROTATION_UNIVERSE,
  weeklyEtfDefensiveSignal,
  weeklyPaperWeek
} from "./weekly-etf-rotation-paper.mjs";

const DAY_MS = 86_400_000;

function shiftDate(date, days) {
  const shifted = new Date(`${date}T12:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function isNyseTradingDate(date) {
  const plan = nyseSessionPlan(Date.parse(`${date}T17:00:00.000Z`));
  return plan.calendarSupported && ["regular-day", "early-close"].includes(plan.calendarDayType);
}

function firstNyseTradingDateOfWeek(date) {
  let cursor = weeklyPaperWeek(date);
  while (cursor < date) {
    if (isNyseTradingDate(cursor)) return false;
    cursor = shiftDate(cursor, 1);
  }
  return isNyseTradingDate(date);
}

export function previousNyseTradingDate(date) {
  let cursor = shiftDate(date, -1);
  while (!isNyseTradingDate(cursor)) cursor = shiftDate(cursor, -1);
  return cursor;
}

export function weeklyEtfLiveDecisionWindow(nowMs = Date.now(), liveState = null) {
  const plan = nyseSessionPlan(nowMs);
  const week = weeklyPaperWeek(plan.date);
  const firstTradingDate = firstNyseTradingDateOfWeek(plan.date);
  const cached = liveState?.week === week && liveState?.decision?.target
    ? liveState.decision
    : null;
  return {
    plan,
    week,
    firstTradingDate,
    canCreateDecision: plan.regularOpen && firstTradingDate && !cached,
    decisionUsable: plan.regularOpen && Boolean(cached),
    decision: cached
  };
}

async function fetchYahooAdjustedDaily(ticker, sessionDate, fetchImpl) {
  const period2 = Date.parse(`${sessionDate}T00:00:00.000Z`) + DAY_MS;
  const period1 = period2 - 180 * DAY_MS;
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  url.searchParams.set("period1", String(Math.floor(period1 / 1000)));
  url.searchParams.set("period2", String(Math.floor(period2 / 1000)));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("includePrePost", "false");
  url.searchParams.set("events", "div,splits");
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Yahoo daily HTTP ${response.status}: ${ticker}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo daily data unavailable: ${ticker}`);
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
  return (result.timestamp || []).map((timestamp, index) => ({
    date: new Date(Number(timestamp) * 1000).toISOString().slice(0, 10),
    close: Number(adjusted[index])
  })).filter(({ date, close }) => date < sessionDate && Number.isFinite(close) && close > 0);
}

export async function loadWeeklyEtfDefensiveSignal(sessionDate, { fetchImpl = fetch } = {}) {
  const tickers = [
    ...WEEKLY_ETF_ROTATION_UNIVERSE.riskTickers,
    WEEKLY_ETF_ROTATION_UNIVERSE.defensiveTicker
  ];
  const seriesByTicker = Object.fromEntries(await Promise.all(tickers.map(async (ticker) => [
    ticker,
    await fetchYahooAdjustedDaily(ticker, sessionDate, fetchImpl)
  ])));
  const signal = weeklyEtfDefensiveSignal(seriesByTicker);
  const expectedSignalDate = previousNyseTradingDate(sessionDate);
  if (signal.signalDate !== expectedSignalDate) throw new Error("Stale weekly ETF signal date");
  return { signal, seriesByTicker };
}

export function weeklyEtfLiveExitDecision({
  positionSymbol,
  target = null,
  returnPct,
  disasterStopLossPct
}) {
  if (!positionSymbol || !Number.isFinite(Number(returnPct)) || !(Number(disasterStopLossPct) > 0)) {
    throw new Error("Invalid weekly ETF exit input");
  }
  if (Number(returnPct) <= -Number(disasterStopLossPct)) {
    return { type: "DISASTER_STOP", target };
  }
  if (!target || target === positionSymbol) return { type: null, target };
  return {
    type: target === "CASH" ? "WEEKLY_TO_CASH" : "WEEKLY_REBALANCE",
    target
  };
}
