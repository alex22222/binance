import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTheoreticalPriceObservation,
  fetchNasdaqStockQuote,
  parseNasdaqStockQuote
} from "../src/theoretical-price.mjs";

const nasdaqPayload = {
  data: {
    symbol: "NVDA",
    companyName: "NVIDIA Corporation Common Stock",
    marketStatus: "Open",
    assetClass: "STOCKS",
    primaryData: {
      lastSalePrice: "$196.56",
      bidPrice: "$196.55",
      askPrice: "$196.57",
      bidSize: "54",
      askSize: "40",
      lastTradeTimestamp: "Jul 31, 2026 12:14 PM ET",
      isRealTime: true
    }
  }
};

const instrument = {
  instrumentId: "binance-web3-rwa:bsc:0xa9ee",
  underlyingSymbol: "NVDA",
  chainId: "56",
  contractAddress: "0xa9ee"
};

test("parses a real-time official Nasdaq stock quote with an absolute provider timestamp", () => {
  assert.deepEqual(
    parseNasdaqStockQuote(nasdaqPayload, "2026-07-31T16:14:20.000Z"),
    {
      symbol: "NVDA",
      companyName: "NVIDIA Corporation Common Stock",
      assetClass: "STOCKS",
      price: 196.56,
      bidPrice: 196.55,
      askPrice: 196.57,
      bidSize: 54,
      askSize: 40,
      currency: "USD",
      marketStatus: "OPEN",
      effectiveAt: "2026-07-31T16:14:00.000Z",
      providerTimestamp: "Jul 31, 2026 12:14 PM ET",
      retrievedAt: "2026-07-31T16:14:20.000Z",
      ageMs: 20_000,
      isRealTime: true,
      source: "NASDAQ_OFFICIAL"
    }
  );
});

test("normalizes the underlying price and shares multiplier into a theoretical token price", () => {
  const underlying = parseNasdaqStockQuote(nasdaqPayload, "2026-07-31T16:14:20.000Z");
  const observation = buildTheoreticalPriceObservation({
    instrument,
    underlying,
    rwaDynamic: {
      stockInfo: { price: "196.794" },
      tokenInfo: { sharesMultiplier: "1.000932054247057497" }
    },
    dynamicRetrievedAt: "2026-07-31T16:14:21.000Z",
    observedAt: "2026-07-31T16:14:21.000Z"
  });

  assert.equal(observation.theoreticalTokenPrice, 196.7432045828016);
  assert.equal(observation.multiplier.value, 1.0009320542470575);
  assert.equal(observation.multiplier.basis, "UNDERLYING_SHARES_PER_TOKEN");
  assert.equal(observation.referenceConflictPct, 0.11904761904762355);
  assert.deepEqual(observation.vetoReasons, []);
  assert.deepEqual(observation.warnings, ["MULTIPLIER_EFFECTIVE_TIME_UNAVAILABLE"]);
  assert.equal(observation.dataQuality.provenanceComplete, false);
  assert.equal(observation.eligibleForLive, false);
});

test("fails closed for stale, non-real-time, conflicting, or invalid price inputs", () => {
  const underlying = parseNasdaqStockQuote({
    data: {
      ...nasdaqPayload.data,
      primaryData: {
        ...nasdaqPayload.data.primaryData,
        lastTradeTimestamp: "Jul 31, 2026 12:10 PM ET",
        isRealTime: false
      }
    }
  }, "2026-07-31T16:14:20.000Z");
  const observation = buildTheoreticalPriceObservation({
    instrument,
    underlying,
    rwaDynamic: {
      stockInfo: { price: "190" },
      tokenInfo: { sharesMultiplier: "0" }
    },
    dynamicRetrievedAt: "2026-07-31T16:14:21.000Z",
    observedAt: "2026-07-31T16:14:21.000Z",
    maxUnderlyingAgeMs: 60_000,
    maxReferenceConflictPct: 0.5
  });

  assert.equal(observation.theoreticalTokenPrice, null);
  assert.deepEqual(observation.vetoReasons, [
    "UNDERLYING_NOT_REAL_TIME",
    "UNDERLYING_STALE",
    "INVALID_SHARES_MULTIPLIER",
    "REFERENCE_PRICE_CONFLICT"
  ]);
  assert.deepEqual(observation.warnings, ["MULTIPLIER_EFFECTIVE_TIME_UNAVAILABLE"]);
  assert.equal(observation.eligibleForLive, false);
});

test("rejects malformed Nasdaq stock responses instead of converting missing values to zero", () => {
  assert.throws(
    () => parseNasdaqStockQuote({ data: { symbol: "NVDA", primaryData: {} } }),
    /Invalid Nasdaq stock response/
  );
});

test("fetches only the requested official Nasdaq stock identity", async () => {
  let requestedUrl = null;
  const quote = await fetchNasdaqStockQuote("nvda", {
    retrievedAt: "2026-07-31T16:14:20.000Z",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => nasdaqPayload };
    }
  });
  assert.match(requestedUrl, /\/NVDA\/info\?assetclass=stocks$/);
  assert.equal(quote.symbol, "NVDA");

  await assert.rejects(
    fetchNasdaqStockQuote("TSLA", {
      fetchImpl: async () => ({ ok: true, json: async () => nasdaqPayload })
    }),
    /identity mismatch/
  );
});
