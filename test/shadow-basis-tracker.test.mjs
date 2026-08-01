import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildShadowBasisCheckpoint,
  createShadowBasisTracker
} from "../src/shadow-basis-tracker.mjs";

const decision = {
  signalId: "signal-1",
  decidedAt: "2026-08-01T01:00:00.000Z",
  decision: "SHADOW_SIGNAL",
  checkpointHorizonsMs: [3_000, 10_000, 30_000, 60_000],
  baseline: {
    observedAt: "2026-08-01T01:00:00.000Z",
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
    gasCostPct: 0.2,
    executionBufferPct: 0.1,
    netEntryEdgePct: 0.5,
    execution: {
      buy: { inputUsdt: 50, outputToken: 0.505050505, unitPriceUsdt: 99 },
      sell: { inputToken: 0.505050505, outputUsdt: 49.9, unitPriceUsdt: 98.802 }
    }
  }
};

test("calculates deviation persistence and executable return from the baseline token quantity", () => {
  const checkpoint = buildShadowBasisCheckpoint({
    decision,
    horizonMs: 3_000,
    dueAt: "2026-08-01T01:00:03.000Z",
    sampledAt: "2026-08-01T01:00:03.200Z",
    sample: {
      executableBasis: {
        buyBasisPct: -0.7,
        sellBasisPct: -0.9,
        grossDiscountPct: 0.7,
        allInCostPct: 0.45,
        netEntryEdgePct: 0.25,
        execution: { buy: { inputUsdt: 50 }, sell: { outputUsdt: 49.95 } }
      },
      baselineExitQuote: {
        inputToken: 0.505050505,
        outputUsdt: 50.25,
        quotedAt: "2026-08-01T01:00:03.100Z"
      },
      marketStatus: { openState: true, reasonCode: "TRADING", marketStatus: "regular" },
      dataQuality: { eligible: true }
    }
  });

  assert.equal(checkpoint.status, "CAPTURED");
  assert.equal(checkpoint.actualDelayMs, 200);
  assert.equal(checkpoint.deviationSurvived, true);
  assert.equal(checkpoint.changes.netEntryEdgePctPoints, -0.25);
  assert.equal(checkpoint.executableReturnPct, 0.5);
  assert.equal(checkpoint.netExecutableReturnPct, 0.3);
  assert.equal(checkpoint.conservativeReturnPct, 0.2);
  assert.equal(checkpoint.baselineExitQuote.inputToken, 0.505050505);
});

test("persists all horizons, captures due work, and marks overdue work without inventing samples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-basis-tracker-"));
  const statePath = join(directory, "pending.json");
  let nowMs = Date.parse("2026-08-01T01:00:00.000Z");
  const timers = [];
  const records = [];
  const tracker = createShadowBasisTracker({
    statePath,
    now: () => nowMs,
    setTimerImpl: (callback, delayMs) => {
      const timer = { callback, delayMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimerImpl: () => {},
    sample: async () => ({
      executableBasis: {
        buyBasisPct: -0.5,
        sellBasisPct: -0.7,
        grossDiscountPct: 0.5,
        allInCostPct: 0.4,
        netEntryEdgePct: 0.1,
        execution: { buy: { inputUsdt: 50 }, sell: { outputUsdt: 49.95 } }
      },
      baselineExitQuote: {
        inputToken: 0.505050505,
        outputUsdt: 50.1,
        quotedAt: "2026-08-01T01:00:03.000Z"
      }
    }),
    record: async (record) => records.push(record)
  });

  try {
    await tracker.start();
    await tracker.track(decision);
    let state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.pending.length, 4);
    assert.deepEqual(timers.map(({ delayMs }) => delayMs), [3_000, 10_000, 30_000, 60_000]);

    nowMs = Date.parse("2026-08-01T01:00:03.000Z");
    await timers[0].callback();
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.pending.length, 3);
    assert.equal(records[0].status, "CAPTURED");
    await tracker.stop();

    nowMs = Date.parse("2026-08-01T01:01:10.000Z");
    const recoveredRecords = [];
    const recovered = createShadowBasisTracker({
      statePath,
      now: () => nowMs,
      sample: async () => {
        throw new Error("overdue checkpoints must not sample");
      },
      record: async (record) => recoveredRecords.push(record)
    });
    await recovered.start();
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.pending.length, 0);
    assert.deepEqual(recoveredRecords.map(({ status }) => status), ["MISSED", "MISSED", "MISSED"]);
    await recovered.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
