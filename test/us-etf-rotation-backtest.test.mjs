import assert from "node:assert/strict";
import test from "node:test";
import {
  alignDailySeries,
  backtestEtfRotation,
  parseYahooAdjustedDailyChart
} from "../src/us-etf-rotation-backtest.mjs";

const riskTickers = ["A", "B"];
const defensiveTicker = "D";

function weekdayRows(startDate, days, priceAt) {
  const rows = [];
  let timestamp = Date.parse(`${startDate}T00:00:00Z`);
  while (rows.length < days) {
    const day = new Date(timestamp).getUTCDay();
    if (day !== 0 && day !== 6) {
      const index = rows.length;
      rows.push({
        date: new Date(timestamp).toISOString().slice(0, 10),
        prices: Object.fromEntries([...riskTickers, defensiveTicker].map((ticker) => {
          const price = priceAt(ticker, index);
          return [ticker, typeof price === "number" ? { open: price, close: price } : price];
        }))
      });
    }
    timestamp += 86_400_000;
  }
  return rows;
}

test("Yahoo parser adjusts the open consistently with adjusted close", () => {
  const parsed = parseYahooAdjustedDailyChart({
    timestamp: [1_700_000_000],
    indicators: {
      quote: [{ open: [100], close: [110] }],
      adjclose: [{ adjclose: [55] }]
    }
  });
  assert.equal(parsed[0].open, 50);
  assert.equal(parsed[0].close, 55);
});

test("daily alignment keeps only dates available for every ticker", () => {
  const aligned = alignDailySeries({
    A: [{ date: "2026-01-02", open: 1, close: 1 }, { date: "2026-01-05", open: 2, close: 2 }],
    B: [{ date: "2026-01-05", open: 3, close: 3 }]
  }, ["A", "B"]);
  assert.deepEqual(aligned.map(({ date }) => date), ["2026-01-05"]);
});

test("Monday selection uses only the prior trading day signal", () => {
  const rows = weekdayRows("2026-01-05", 18, (ticker, index) => {
    if (ticker === "D") return 100;
    const fridayGap = index === 15 ? (ticker === "A" ? 200 : 50) : null;
    if (fridayGap) return { open: fridayGap, close: fridayGap };
    return ticker === "A" ? 100 + index : 100 + index * 2;
  });
  const result = backtestEtfRotation({
    rows,
    riskTickers,
    defensiveTicker,
    momentumDays: 2,
    rsiPeriod: 2,
    rsiThreshold: 0,
    costBpsPerSide: 0
  });
  const monday = result.decisions.find(({ executionDate }) => executionDate === "2026-01-26");
  assert.equal(monday.signalDate, "2026-01-23");
  assert.equal(monday.target, "B");
});

test("weekly decisions do not charge costs unless the holding changes", () => {
  const rows = weekdayRows("2026-01-05", 40, (ticker, index) => (
    ticker === "A" ? 100 + index * 2 : ticker === "B" ? 100 + index : 100
  ));
  const result = backtestEtfRotation({
    rows,
    riskTickers,
    defensiveTicker,
    momentumDays: 2,
    rsiPeriod: 2,
    rsiThreshold: 0,
    costBpsPerSide: 5
  });
  assert.ok(result.metrics.weeklyDecisions > 2);
  assert.equal(result.metrics.actualSwitches, 0);
  assert.equal(result.trades.length, 1);
  assert.equal(result.metrics.totalCostUsd, 50);
});

test("all risk assets below the RSI threshold select Treasuries", () => {
  const rows = weekdayRows("2026-01-05", 20, (ticker, index) => (
    ticker === "D" ? 100 : 200 - index * (ticker === "A" ? 2 : 1)
  ));
  const result = backtestEtfRotation({
    rows,
    riskTickers,
    defensiveTicker,
    momentumDays: 2,
    rsiPeriod: 2,
    rsiThreshold: 40,
    costBpsPerSide: 0
  });
  assert.ok(result.decisions.length > 0);
  assert.ok(result.decisions.every(({ target }) => target === "D"));
});
