import assert from "node:assert/strict";
import test from "node:test";
import {
  createNasdaqCompositeLoader,
  parseNasdaqComposite
} from "../src/nasdaq-index.mjs";

const payload = {
  data: {
    symbol: "COMP",
    companyName: "NASDAQ Composite Index",
    marketStatus: "Open",
    primaryData: {
      lastSalePrice: "25,177.52",
      netChange: "+55.34",
      percentageChange: "+0.22%",
      deltaIndicator: "up",
      lastTradeTimestamp: "Jul 31, 2026 11:13 AM ET",
      isRealTime: false
    }
  }
};

test("parses the official Nasdaq composite quote without claiming it is real time", () => {
  assert.deepEqual(parseNasdaqComposite(payload, "2026-07-31T15:13:30.000Z"), {
    symbol: "COMP",
    name: "NASDAQ Composite Index",
    value: 25177.52,
    change: 55.34,
    changePct: 0.22,
    direction: "up",
    marketStatus: "Open",
    providerTimestamp: "Jul 31, 2026 11:13 AM ET",
    isRealTime: false,
    source: "NASDAQ_OFFICIAL",
    checkedAt: "2026-07-31T15:13:30.000Z",
    stale: false
  });
});

test("caches the Nasdaq quote for sixty seconds and keeps the last value on failure", async () => {
  let calls = 0;
  const load = createNasdaqCompositeLoader({
    fetchImpl: async () => {
      calls += 1;
      if (calls > 1) throw new Error("temporary network failure");
      return { ok: true, json: async () => payload };
    }
  });

  const first = await load({ nowMs: Date.parse("2026-07-31T15:13:30.000Z") });
  const cached = await load({ nowMs: Date.parse("2026-07-31T15:14:00.000Z") });
  const stale = await load({ nowMs: Date.parse("2026-07-31T15:14:31.000Z") });

  assert.equal(calls, 2);
  assert.strictEqual(cached, first);
  assert.equal(stale.value, 25177.52);
  assert.equal(stale.stale, true);
});

test("throttles repeated requests when the Nasdaq source is initially unavailable", async () => {
  let calls = 0;
  const load = createNasdaqCompositeLoader({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("source unavailable");
    }
  });

  assert.equal(await load({ nowMs: 1_000 }), null);
  assert.equal(await load({ nowMs: 30_000 }), null);
  assert.equal(calls, 1);
});
