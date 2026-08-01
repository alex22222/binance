import assert from "node:assert/strict";
import test from "node:test";

import { buildExecutableBasisObservation } from "../src/executable-basis.mjs";

const theoreticalPrice = {
  instrument: {
    instrumentId: "binance-web3-rwa:bsc:0xa9ee",
    underlyingSymbol: "NVDA",
    contractAddress: "0xa9ee"
  },
  theoreticalTokenPrice: 100,
  vetoReasons: [],
  observedAt: "2026-08-01T01:00:00.000Z"
};

function observation(overrides = {}) {
  return buildExecutableBasisObservation({
    theoreticalPrice,
    tradeUsdt: 50,
    buyQuote: {
      requestedInputUsdt: 50,
      outputToken: 0.5050505050505051,
      quotedAt: "2026-08-01T01:00:01.000Z"
    },
    sellQuote: {
      requestedInputToken: 0.5050505050505051,
      outputUsdt: 49.5,
      quotedAt: "2026-08-01T01:00:02.000Z"
    },
    estimatedRoundTripGasUsdt: 0.1,
    executionBufferPct: 0.1,
    observedAt: "2026-08-01T01:00:03.000Z",
    ...overrides
  });
}

test("calculates signed executable buy and sell basis from amount-specific quotes", () => {
  const result = observation();

  assert.equal(result.execution.buy.unitPriceUsdt, 99);
  assert.equal(result.execution.sell.unitPriceUsdt, 98.01);
  assert.equal(result.buyBasisPct, -1);
  assert.equal(result.sellBasisPct, -1.99);
  assert.equal(result.grossDiscountPct, 1);
  assert.equal(result.roundTripCostPct, 1);
  assert.equal(result.gasCostPct, 0.2);
  assert.equal(result.allInCostPct, 1.3);
  assert.equal(result.netEntryEdgePct, -0.3);
  assert.deepEqual(result.vetoReasons, ["NET_EXECUTABLE_EDGE_NOT_POSITIVE"]);
});

test("changes the executable basis when the same symbol is quoted at a different amount", () => {
  const small = observation();
  const large = observation({
    tradeUsdt: 500,
    buyQuote: {
      requestedInputUsdt: 500,
      outputToken: 4.901960784313726,
      quotedAt: "2026-08-01T01:00:01.000Z"
    },
    sellQuote: {
      requestedInputToken: 4.901960784313726,
      outputUsdt: 480,
      quotedAt: "2026-08-01T01:00:02.000Z"
    },
    estimatedRoundTripGasUsdt: 0.1
  });

  assert.equal(small.execution.buy.unitPriceUsdt, 99);
  assert.equal(large.execution.buy.unitPriceUsdt, 102);
  assert.equal(large.buyBasisPct, 2);
  assert.equal(large.roundTripCostPct, 4);
});

test("fails closed for stale quotes, mismatched amounts, missing depth, or invalid theory", () => {
  const result = observation({
    theoreticalPrice: {
      ...theoreticalPrice,
      theoreticalTokenPrice: null,
      vetoReasons: ["REFERENCE_PRICE_CONFLICT"]
    },
    buyQuote: {
      requestedInputUsdt: 40,
      outputToken: 0,
      quotedAt: "2026-08-01T00:59:40.000Z"
    },
    sellQuote: {
      requestedInputToken: 1,
      outputUsdt: 0,
      quotedAt: "2026-08-01T00:59:40.000Z"
    }
  });

  assert.equal(result.buyBasisPct, null);
  assert.deepEqual(result.vetoReasons, [
    "REFERENCE_PRICE_CONFLICT",
    "INVALID_THEORETICAL_PRICE",
    "BUY_QUOTE_AMOUNT_MISMATCH",
    "INVALID_BUY_QUOTE_DEPTH",
    "SELL_QUOTE_AMOUNT_MISMATCH",
    "INVALID_SELL_QUOTE_DEPTH",
    "BUY_QUOTE_STALE",
    "SELL_QUOTE_STALE"
  ]);
  assert.equal(result.eligibleForShadowSignal, false);
});
