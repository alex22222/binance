import assert from "node:assert/strict";
import test from "node:test";
import { dynamicExitDecision } from "../src/strategy-exit.mjs";

const base = {
  returnPct: 0,
  initialRiskPct: 2,
  atr15Pct: 1,
  peakReturnPct: 0,
  profitProtectionActive: false,
  openedAtMs: Date.parse("2026-07-27T13:30:00.000Z"),
  nowMs: Date.parse("2026-07-27T13:31:00.000Z"),
  signalValid: true,
  disasterStopLossPct: 8,
  profitProtectionR: 1,
  trailingAtrMultiplier: 1,
  finalTakeProfitR: 2,
  signalReviewHours: 4,
  signalReviewMinR: 0.5,
  profitFloorPct: 0.2
};

test("shared dynamic exit preserves stop, target, and trailing precedence", () => {
  assert.equal(dynamicExitDecision({ ...base, returnPct: -8.1 }).type, "DISASTER_STOP");
  assert.equal(dynamicExitDecision({ ...base, returnPct: -2 }).type, "INITIAL_STOP");
  assert.equal(dynamicExitDecision({ ...base, returnPct: 4 }).type, "TAKE_PROFIT_2R");
  assert.equal(dynamicExitDecision({
    ...base,
    returnPct: 2,
    peakReturnPct: 3,
    profitProtectionActive: true
  }).type, "TRAILING_STOP");
});

test("shared dynamic exit uses the supplied replay time instead of wall-clock time", () => {
  assert.equal(dynamicExitDecision({
    ...base,
    nowMs: base.openedAtMs + 4 * 60 * 60_000 - 1,
    signalValid: false
  }).type, null);
  assert.equal(dynamicExitDecision({
    ...base,
    nowMs: base.openedAtMs + 4 * 60 * 60_000,
    signalValid: false
  }).type, "SIGNAL_TIMEOUT");
});
