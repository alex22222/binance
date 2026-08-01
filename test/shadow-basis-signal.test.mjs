import assert from "node:assert/strict";
import test from "node:test";

import { buildShadowBasisDecision } from "../src/shadow-basis-signal.mjs";

const executableBasis = {
  observedAt: "2026-08-01T01:00:03.000Z",
  instrument: {
    instrumentId: "binance-web3-rwa:bsc:0xa9ee",
    underlyingSymbol: "NVDA",
    contractAddress: "0xa9ee"
  },
  theoreticalPrice: 100,
  buyBasisPct: -1,
  sellBasisPct: -1.2,
  grossDiscountPct: 1,
  allInCostPct: 0.5,
  netEntryEdgePct: 0.5,
  execution: {
    buy: { inputUsdt: 50, outputToken: 0.505, unitPriceUsdt: 99 },
    sell: { inputToken: 0.505, outputUsdt: 49.9, unitPriceUsdt: 98.811881 }
  }
};

test("emits a trackable Shadow signal only after every hard entry gate passes", () => {
  const result = buildShadowBasisDecision({
    signalId: "signal-1",
    eligibility: { entryAllowed: true, protectiveExitAllowed: true, vetoReasons: [] },
    executableBasis,
    decidedAt: "2026-08-01T01:00:04.000Z"
  });

  assert.equal(result.decision, "SHADOW_SIGNAL");
  assert.equal(result.enforcedForLive, false);
  assert.equal(result.signalId, "signal-1");
  assert.deepEqual(result.checkpointHorizonsMs, [3_000, 10_000, 30_000, 60_000]);
  assert.equal(result.baseline.netEntryEdgePct, 0.5);
});

test("a hard veto blocks the Shadow signal even when its calculated edge is positive", () => {
  const result = buildShadowBasisDecision({
    signalId: "signal-2",
    eligibility: {
      entryAllowed: false,
      protectiveExitAllowed: true,
      vetoReasons: ["CORPORATE_ACTION_BLACKOUT"]
    },
    executableBasis,
    decidedAt: "2026-08-01T01:00:04.000Z"
  });

  assert.equal(result.decision, "BLOCKED");
  assert.deepEqual(result.reasons, ["CORPORATE_ACTION_BLACKOUT"]);
  assert.equal(result.checkpointHorizonsMs, null);
});
