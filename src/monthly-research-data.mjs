import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseYahooAdjustedDailyChart } from "./us-etf-rotation-backtest.mjs";
import { researchTradingDates } from "./weekly-research-calendar.mjs";
import { publicResearchFetch } from "./weekly-research-data.mjs";
import { newYorkDate, latestCompletedTradingDate } from "./strategy-data.mjs";
import { researchHash } from "./monthly-trend-research.mjs";

export const MONTHLY_RESEARCH_TICKERS = Object.freeze(["VTI", "SGOV", "QQQ", "SPY", "VTV"]);
// Freeze the study boundary, not a mutable response's choice of available history.
// SGOV provider first-trade date was verified in the frozen Sep 28 Yahoo payload;
// it is distinct from the fund's May 26 inception date.
export const MONTHLY_HISTORY_STARTS = Object.freeze({ VTI: "2020-01-01", SGOV: "2020-06-01",
  QQQ: "2020-01-01", SPY: "2020-01-01", VTV: "2020-01-01" });

export function parseMonthlyResearchHistory(text, ticker, cutoff) {
  const payload = JSON.parse(text);
  const chart = payload.chart?.result?.[0];
  if (!chart || chart.meta?.symbol !== ticker || chart.meta?.currency !== "USD"
    || chart.meta?.exchangeTimezoneName !== "America/New_York" || chart.meta?.instrumentType !== "ETF") {
    throw new Error(`Historical instrument identity mismatch: ${ticker}`);
  }
  const timestamps = chart.timestamp;
  if (!Array.isArray(timestamps) || !timestamps.length || timestamps.some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid historical timestamps: ${ticker}`);
  }
  const firstTrade = Number(chart.meta.firstTradeDate);
  if (!Number.isFinite(firstTrade) || firstTrade <= 0) throw new Error(`Missing provider first-trade date: ${ticker}`);
  const firstTradeDate = newYorkDate(firstTrade * 1000);
  const startDate = MONTHLY_HISTORY_STARTS[ticker];
  if (!startDate) throw new Error(`Unsupported research ticker: ${ticker}`);
  const expected = researchTradingDates(startDate, cutoff);
  const metadataMatchesResearchStart = ticker === "SGOV" ? firstTradeDate === startDate : firstTradeDate <= expected[0];
  // Preserve raw payload in the bundle. Exclude incomplete/future bars explicitly, not by silent alignment.
  const rawDates = timestamps.map((timestamp) => newYorkDate(timestamp * 1000));
  const parsed = parseYahooAdjustedDailyChart(chart).filter(({ date }) => date >= startDate && date <= cutoff);
  const dates = parsed.map(({ date }) => date);
  const actual = new Set(dates);
  const expectedSet = new Set(expected);
  const missingDates = expected.filter((date) => !actual.has(date));
  const unexpectedDates = dates.filter((date) => !expectedSet.has(date));
  const duplicateDates = dates.filter((date, index) => dates.indexOf(date) !== index);
  const invalidRowCount = rawDates.filter((date) => date >= startDate && date <= cutoff).length - parsed.length;
  const ordered = dates.every((date, index) => !index || date > dates[index - 1]);
  return {
    bars: parsed,
    quality: {
      passed: metadataMatchesResearchStart && parsed.length > 0 && !missingDates.length && !unexpectedDates.length && !duplicateDates.length && !invalidRowCount && ordered,
      metadataMatchesResearchStart,
      firstTradeDate, expectedStart: startDate, expectedEnd: cutoff, rows: parsed.length,
      firstDate: dates[0] || null, lastDate: dates.at(-1) || null,
      missingDates, unexpectedDates, duplicateDates, invalidRowCount, ordered,
      excludedAfterCutoff: rawDates.filter((date) => date > cutoff).length,
      evidenceLevel: "UNDERLYING_ADJUSTED_DAILY_PROXY",
      providerCalendarSource: "researchTradingDates:2020-2028"
    }
  };
}

export async function collectMonthlyResearchData({ nowMs = Date.now(), cutoff, inputDirectory = null, fetchText = publicResearchFetch } = {}) {
  const completed = latestCompletedTradingDate(nowMs);
  const selectedCutoff = cutoff || completed;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedCutoff) || selectedCutoff > completed || selectedCutoff < "2020-01-01"
    || !researchTradingDates(selectedCutoff, selectedCutoff).length) throw new Error("Cutoff must be a completed research trading date");
  const sources = [];
  const raw = {};
  const history = {};
  const collectedAt = new Date(nowMs).toISOString();
  // Bounded sequential downloads keep provider load and memory modest.
  for (const ticker of MONTHLY_RESEARCH_TICKERS) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=1577836800&period2=${(Date.parse(selectedCutoff) + 86_400_000) / 1000}&interval=1d&includePrePost=false&events=div%2Csplits`;
    const source = { ticker, url, retrievedAt: collectedAt, inputKind: inputDirectory ? "ARCHIVED_PAYLOAD" : "PUBLIC_DOWNLOAD" };
    try {
      const text = inputDirectory ? await readFile(resolve(inputDirectory, `${ticker}.json`), "utf8") : await fetchText(url);
      raw[ticker] = text;
      const parsed = parseMonthlyResearchHistory(text, ticker, selectedCutoff);
      history[ticker] = parsed.bars;
      sources.push({ ...source, sha256: researchHash(text), quality: parsed.quality,
        status: parsed.quality.passed ? "AVAILABLE" : "INVALID_HISTORY" });
    } catch (error) {
      sources.push({ ...source, sha256: raw[ticker] ? researchHash(raw[ticker]) : null,
        status: "FETCH_OR_PARSE_FAILED", failureCode: error.code || error.name,
        failureReason: raw[ticker] ? error.message : "Source unavailable; raw data not obtained" });
    }
  }
  const passed = sources.every(({ status }) => status === "AVAILABLE");
  const maps = Object.fromEntries(MONTHLY_RESEARCH_TICKERS.map((ticker) => [ticker,
    new Map((history[ticker] || []).map((bar) => [bar.date, bar]))
  ]));
  const rows = passed ? researchTradingDates("2020-01-01", selectedCutoff).map((date) => ({
    date, prices: Object.fromEntries(MONTHLY_RESEARCH_TICKERS.flatMap((ticker) => maps[ticker].has(date) ? [[ticker, maps[ticker].get(date)]] : []))
  })) : [];
  return {
    schemaVersion: 1, collectedAt, cutoff: selectedCutoff,
    status: passed ? "AVAILABLE" : "DATA_QUALITY_BLOCKED", sources, raw, rows,
    inputHash: researchHash(rows), liveAuthorized: false,
    calendar: "Existing research NYSE daily calendar 2020-2028; Live calendar untouched",
    limitations: ["Adjusted current-vintage prices; not point-in-time dividend adjustment vintages",
      "No SGOV history fabricated before provider first-trade date", "Archived inputs retain raw hashes; retrievedAt is import time, not original retrieval time"]
  };
}
