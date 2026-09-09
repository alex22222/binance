import assert from "node:assert/strict";
import test from "node:test";
import { createNasdaqStockMarketLoader } from "../src/nasdaq-stock-market.mjs";

test("loads and caches official daily stock changes without inventing unavailable data", async () => {
  let calls = 0;
  const load = createNasdaqStockMarketLoader({
    fetchQuote: async (symbol) => {
      calls += 1;
      if (symbol === "TSLA") throw new Error("unavailable");
      return {
        changePct: 1.25,
        marketStatus: "OPEN",
        providerTimestamp: "Jul 31, 2026 12:14 PM ET",
        isRealTime: true,
        source: "NASDAQ_OFFICIAL"
      };
    }
  });

  const first = await load(["NVDA", "TSLA"], { nowMs: 1_000 });
  const cached = await load(["NVDA", "TSLA"], { nowMs: 30_000 });

  assert.deepEqual(first.NVDA, {
    changePct: 1.25,
    marketStatus: "OPEN",
    providerTimestamp: "Jul 31, 2026 12:14 PM ET",
    isRealTime: true,
    source: "NASDAQ_OFFICIAL",
    stale: false
  });
  assert.equal(first.TSLA, null);
  assert.strictEqual(cached, first);
  assert.equal(calls, 2);
});
