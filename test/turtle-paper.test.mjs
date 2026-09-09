import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceTurtlePaper,
  initialTurtlePaperState,
  turtleDailyFeature
} from "../src/turtle-paper.mjs";

function daily(index, values = {}) {
  return {
    openTime: Date.parse("2026-01-01T14:30:00Z") + index * 86_400_000,
    high: values.high ?? 100 + index,
    low: values.low ?? 99 + index,
    close: values.close ?? 99.5 + index
  };
}

test("detects a completed 55-day breakout and calculates the 2N risk", () => {
  const candles = Array.from({ length: 56 }, (_, index) => daily(index));
  const feature = turtleDailyFeature(candles);
  assert.equal(feature.entryBreakout, true);
  assert.equal(feature.entryHigh, 154);
  assert.ok(feature.initialRiskPct > 0);
  assert.equal(feature.initialRiskPct, feature.dailyAtrPct * 2);
});

test("does not call an equal high or equal low a Turtle breakout", () => {
  const candles = Array.from({ length: 56 }, (_, index) => daily(index));
  candles.at(-1).high = Math.max(...candles.slice(0, -1).map(({ high }) => high));
  candles.at(-1).low = Math.min(...candles.slice(-21, -1).map(({ low }) => low));
  const feature = turtleDailyFeature(candles);
  assert.equal(feature.entryBreakout, false);
  assert.equal(feature.exitBreakout, false);
});

test("opens one strongest Paper position with no wallet execution path", () => {
  const state = initialTurtlePaperState("2026-09-09T13:20:00.000Z");
  const result = advanceTurtlePaper(state, {
    at: "2026-09-09T13:35:00.000Z",
    sessionDate: "2026-09-09",
    regularOpen: true,
    candidates: [
      { symbol: "AAPL", price: 100, breakoutStrengthPct: 1, initialRiskPct: 4 },
      { symbol: "MSFT", price: 200, breakoutStrengthPct: 2, initialRiskPct: 3 }
    ],
    positionObservation: null
  }, { notionalUsdt: 50, roundTripCostPct: 1 });
  assert.equal(result.state.position.symbol, "MSFT");
  assert.equal(result.state.position.quantity, 0.25);
  assert.equal(result.state.realizedPnlUsdt, 0);
  assert.equal(result.events.at(-1).type, "PAPER_BUY_FILLED");
  assert.equal(result.events.at(-1).evidenceLevel, "PAPER_CANDLE_PROXY");
  assert.equal(JSON.stringify(result).includes("wallet"), false);
});

test("marks then closes a Paper position at the 2N stop and reconciles costs", () => {
  const opened = advanceTurtlePaper(initialTurtlePaperState("2026-09-09T13:20:00.000Z"), {
    at: "2026-09-09T13:35:00.000Z", sessionDate: "2026-09-09", regularOpen: true,
    candidates: [{ symbol: "AAPL", price: 100, breakoutStrengthPct: 1, initialRiskPct: 4 }],
    positionObservation: null
  }, { notionalUsdt: 50, roundTripCostPct: 1 }).state;
  const result = advanceTurtlePaper(opened, {
    at: "2026-09-09T14:00:00.000Z", sessionDate: "2026-09-09", regularOpen: true,
    candidates: [], positionObservation: { symbol: "AAPL", price: 95, exitBreakout: false }
  }, { notionalUsdt: 50, roundTripCostPct: 1 });
  assert.equal(result.state.position, null);
  assert.equal(result.state.trades.length, 1);
  assert.equal(result.state.trades[0].reason, "TURTLE_2N_STOP");
  assert.equal(result.state.trades[0].grossPnlUsdt, -2.5);
  assert.equal(result.state.trades[0].costUsdt, 0.5);
  assert.equal(result.state.trades[0].pnlUsdt, -3);
  assert.equal(result.state.realizedPnlUsdt, -3);
});

test("uses a completed 20-day low exit and never opens outside regular hours", () => {
  const state = initialTurtlePaperState("2026-09-09T13:20:00.000Z");
  const skipped = advanceTurtlePaper(state, {
    at: "2026-09-09T13:25:00.000Z", sessionDate: "2026-09-09", regularOpen: false,
    candidates: [{ symbol: "AAPL", price: 100, breakoutStrengthPct: 1, initialRiskPct: 4 }],
    positionObservation: null
  });
  assert.equal(skipped.state.position, null);
  assert.equal(skipped.events.at(-1).type, "PAPER_MARKET_CLOSED");
});

test("does not re-evaluate entries twice in one session", () => {
  const state = { ...initialTurtlePaperState("2026-09-09T13:20:00.000Z"), lastEntryEvaluationDate: "2026-09-09" };
  const result = advanceTurtlePaper(state, {
    at: "2026-09-09T15:00:00.000Z", sessionDate: "2026-09-09", regularOpen: true,
    candidates: [{ symbol: "AAPL", price: 100, breakoutStrengthPct: 1, initialRiskPct: 4 }],
    positionObservation: null
  });
  assert.equal(result.state.position, null);
  assert.equal(result.events.at(-1).type, "PAPER_ENTRY_ALREADY_EVALUATED");
});
