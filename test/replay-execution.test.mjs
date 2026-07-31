import assert from "node:assert/strict";
import test from "node:test";
import { executeReplayOrder } from "../src/replay-execution.mjs";

const executedAtMs = Date.parse("2026-07-27T14:00:00.000Z");

test("fills the default candle proxy without accessing an external executor", () => {
  assert.deepEqual(executeReplayOrder({
    model: "CANDLE_PROXY",
    orderId: "buy-1",
    side: "BUY",
    executedAtMs,
    candlePrice: 125,
    notionalUsdt: 50
  }), {
    status: "FILLED",
    reason: "CANDLE_PROXY_FILL",
    evidenceLevel: "CANDLE_PROXY",
    orderId: "buy-1",
    side: "BUY",
    executedAtMs,
    fillPrice: 125,
    fillQuantity: 0.4,
    inputAmount: 50,
    outputAmount: 0.4,
    gasUsdt: 0,
    quoteAgeMs: null,
    quoteDriftPct: null
  });
});

test("fills an amount-specific quote replay and keeps gas separate", () => {
  const result = executeReplayOrder({
    model: "QUOTE_REPLAY",
    orderId: "sell-1",
    side: "SELL",
    executedAtMs,
    quantity: 0.4,
    quote: {
      quotedAt: new Date(executedAtMs - 2_000).toISOString(),
      inputAmount: 0.4,
      outputAmount: 51
    },
    expectedOutputAmount: 50.9,
    maxQuoteAgeMs: 10_000,
    maxQuoteDriftPct: 0.3,
    gasUsdt: 0.04
  });

  assert.equal(result.status, "FILLED");
  assert.equal(result.evidenceLevel, "QUOTE_REPLAY");
  assert.equal(result.fillPrice, 127.5);
  assert.equal(result.outputAmount, 51);
  assert.equal(result.gasUsdt, 0.04);
  assert.equal(result.quoteAgeMs, 2_000);
  assert.ok(result.quoteDriftPct < 0.3);
});

test("quote replay rejects missing, stale, future, and drifted quotes without fallback", () => {
  const common = {
    model: "QUOTE_REPLAY",
    orderId: "buy-1",
    side: "BUY",
    executedAtMs,
    notionalUsdt: 50,
    maxQuoteAgeMs: 10_000,
    maxQuoteDriftPct: 0.3
  };
  assert.equal(executeReplayOrder(common).reason, "MISSING_QUOTE");
  const stale = executeReplayOrder({
    ...common,
    quote: {
      quotedAt: new Date(executedAtMs - 10_001).toISOString(),
      inputAmount: 50,
      outputAmount: 0.4
    }
  });
  assert.equal(stale.reason, "STALE_QUOTE");
  assert.equal(stale.quoteAgeMs, 10_001);
  const future = executeReplayOrder({
    ...common,
    quote: {
      quotedAt: new Date(executedAtMs + 1).toISOString(),
      inputAmount: 50,
      outputAmount: 0.4
    }
  });
  assert.equal(future.reason, "FUTURE_QUOTE");
  assert.equal(future.quoteAgeMs, -1);
  assert.equal(executeReplayOrder({
    ...common,
    quote: {
      quotedAt: new Date(executedAtMs - 1_000).toISOString(),
      inputAmount: 50,
      outputAmount: 0.35
    },
    expectedOutputAmount: 0.4
  }).reason, "QUOTE_DRIFT");
});

test("quote replay rejects a quote for a different order amount", () => {
  const result = executeReplayOrder({
    model: "QUOTE_REPLAY",
    orderId: "buy-1",
    side: "BUY",
    executedAtMs,
    notionalUsdt: 50,
    quote: {
      quotedAt: new Date(executedAtMs - 1_000).toISOString(),
      inputAmount: 40,
      outputAmount: 0.32
    }
  });

  assert.equal(result.status, "REJECTED");
  assert.equal(result.reason, "QUOTE_INPUT_MISMATCH");
});

test("quote replay records a terminal on-chain failure without inventing a fill", () => {
  const result = executeReplayOrder({
    model: "QUOTE_REPLAY",
    orderId: "buy-1",
    side: "BUY",
    executedAtMs,
    notionalUsdt: 50,
    quote: {
      quotedAt: new Date(executedAtMs - 1_000).toISOString(),
      inputAmount: 50,
      outputAmount: 0.4,
      terminalStatus: "FAILED_ONCHAIN"
    },
    gasUsdt: 0.02
  });

  assert.deepEqual({
    status: result.status,
    reason: result.reason,
    evidenceLevel: result.evidenceLevel,
    gasUsdt: result.gasUsdt,
    fillPrice: result.fillPrice
  }, {
    status: "FAILED",
    reason: "FAILED_ONCHAIN",
    evidenceLevel: "QUOTE_REPLAY",
    gasUsdt: 0.02,
    fillPrice: null
  });
});
