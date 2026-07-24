import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCandles,
  auditDecision,
  dailyLossReached,
  exitReason,
  pendingOrderAction,
  rankCandidates,
  roundTripCostPct,
  uniqueSymbols,
  validateConfig
} from "../src/strategy.mjs";

const config = {
  mode: "shadow",
  symbols: ["NVDA"],
  maxTradeUsdt: 50,
  dailyLossLimitUsdt: 10,
  maxOpenPositions: 1,
  stopLossPct: 8,
  takeProfitPct: 10,
  minTrend15mPct: 0.8,
  minDirectionalMinutes: 10,
  maxRoundTripCostPct: 0.7,
  allowUnsupportedAuditForOfficialRwa: true,
  traceFile: "state/action-trace.jsonl"
};

test("deduplicates the configured universe", () => {
  assert.deepEqual(uniqueSymbols(["nvda", " NVDA ", "aapl"]), ["NVDA", "AAPL"]);
});

test("rejects limits above the user-approved risk envelope", () => {
  assert.throws(() => validateConfig({ ...config, maxTradeUsdt: 51 }), /maxTradeUsdt/);
  assert.throws(() => validateConfig({ ...config, dailyLossLimitUsdt: 11 }), /dailyLossLimitUsdt/);
});

test("blocks new entries at the daily loss limit", () => {
  assert.equal(dailyLossReached(-9.99, 10), false);
  assert.equal(dailyLossReached(-10, 10), true);
});

test("uses executable proceeds for stop loss and take profit", () => {
  assert.equal(exitReason({ proceedsUsdt: 46.01, costBasisUsdt: 50, stopLossPct: 8, takeProfitPct: 10 }), null);
  assert.equal(exitReason({ proceedsUsdt: 46, costBasisUsdt: 50, stopLossPct: 8, takeProfitPct: 10 }).type, "STOP_LOSS");
  assert.equal(exitReason({ proceedsUsdt: 55, costBasisUsdt: 50, stopLossPct: 8, takeProfitPct: 10 }).type, "TAKE_PROFIT");
});

test("does not add a time-based exit", () => {
  const result = exitReason({ proceedsUsdt: 50, costBasisUsdt: 50, stopLossPct: 8, takeProfitPct: 10 });
  assert.equal(result, null);
});

test("calculates a 15-minute signal from closed one-minute candles", () => {
  const now = 2_000_000;
  const candles = Array.from({ length: 16 }, (_, index) => {
    const openTime = index * 60_000;
    const close = 100 + index * 0.1;
    return [openTime, String(close), String(close), String(close), String(close), "0", openTime + 59_999];
  });
  const result = analyzeCandles(candles, now);
  assert.ok(result.trend15mPct > 1.4);
  assert.equal(result.upMinutes, 15);
});

test("ranks only candidates that clear trend, consistency, status and cost gates", () => {
  const ranked = rankCandidates([
    { symbol: "A", openState: true, reasonCode: "TRADING", trend15mPct: 1.2, upMinutes: 12, roundTripCostPct: 0.6 },
    { symbol: "B", openState: true, reasonCode: "TRADING", trend15mPct: 1.4, upMinutes: 11, roundTripCostPct: 0.5 },
    { symbol: "C", openState: true, reasonCode: "TRADING", trend15mPct: 0.5, upMinutes: 14, roundTripCostPct: 0.2 }
  ], config);
  assert.deepEqual(ranked.map((candidate) => candidate.symbol), ["B", "A"]);
});

test("calculates quote-based round-trip cost", () => {
  assert.ok(Math.abs(roundTripCostPct(20, 19.88) - 0.6) < 1e-9);
});

test("keeps pending orders unresolved until the CLI reports a terminal status", () => {
  assert.equal(pendingOrderAction(null), "WAIT");
  assert.equal(pendingOrderAction("PENDING"), "WAIT");
  assert.equal(pendingOrderAction("UNKNOWN"), "WAIT");
});

test("distinguishes finished and failed orders", () => {
  assert.equal(pendingOrderAction("FINISHED"), "FINISH");
  assert.equal(pendingOrderAction("FAILED"), "FAIL");
});

test("allows an unavailable audit only for an acknowledged official RWA contract", () => {
  const result = auditDecision({
    hasResult: false,
    isSupported: false,
    isOfficialRwa: true,
    allowUnsupportedOfficialRwa: true
  });
  assert.deepEqual(result, {
    allowed: true,
    status: "OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED"
  });
});

test("fails closed when an unavailable audit is not covered by the narrow RWA exception", () => {
  assert.throws(() => auditDecision({
    hasResult: false,
    isSupported: false,
    isOfficialRwa: false,
    allowUnsupportedOfficialRwa: true
  }), /unavailable/);
  assert.throws(() => auditDecision({
    hasResult: false,
    isSupported: false,
    isOfficialRwa: true,
    allowUnsupportedOfficialRwa: false
  }), /unavailable/);
});

test("enforces risk hits and taxes when Binance supports the token audit", () => {
  assert.deepEqual(auditDecision({
    hasResult: true,
    isSupported: true,
    riskLevel: 1,
    riskLevelEnum: "LOW",
    hits: [],
    buyTax: 0,
    sellTax: 0,
    isOfficialRwa: true,
    allowUnsupportedOfficialRwa: true
  }), {
    allowed: true,
    status: "SUPPORTED_LOW_RISK",
    riskLevel: "LOW",
    buyTax: 0,
    sellTax: 0
  });
  assert.throws(() => auditDecision({
    hasResult: true,
    isSupported: true,
    riskLevel: 2,
    riskLevelEnum: "HIGH",
    hits: [],
    buyTax: 0,
    sellTax: 0
  }), /blocked trade/);
  assert.throws(() => auditDecision({
    hasResult: true,
    isSupported: true,
    riskLevel: 1,
    riskLevelEnum: "LOW",
    hits: [{}],
    buyTax: 0,
    sellTax: 0
  }), /blocked trade/);
  assert.throws(() => auditDecision({
    hasResult: true,
    isSupported: true,
    riskLevel: 1,
    riskLevelEnum: "LOW",
    hits: [],
    buyTax: 6,
    sellTax: 0
  }), /blocked trade/);
});
