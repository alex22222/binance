import assert from "node:assert/strict";
import test from "node:test";

import { buildShadowBasisReadiness } from "../src/shadow-basis-readiness.mjs";

function recordsForSignal(index, { complete = true, returnPct = 1, dataQuality = true } = {}) {
  const signalId = `signal-${String(index).padStart(3, "0")}`;
  const decidedAtMs = Date.parse("2026-01-02T14:30:00.000Z") + index * 60_000;
  const records = [{
    recordType: "shadow_basis_decision",
    shadowBasisDecision: {
      signalId,
      decision: "SHADOW_SIGNAL",
      decidedAt: new Date(decidedAtMs).toISOString(),
      checkpointHorizonsMs: [3_000, 10_000, 30_000, 60_000]
    }
  }];
  for (const horizonMs of complete ? [3_000, 10_000, 30_000, 60_000] : [3_000]) {
    records.push({
      recordType: "shadow_basis_checkpoint",
      signalId,
      horizonMs,
      status: "CAPTURED",
      sampledAt: new Date(decidedAtMs + horizonMs).toISOString(),
      netExecutableReturnPct: horizonMs === 60_000 ? returnPct : returnPct / 2,
      dataQuality: { eligible: dataQuality }
    });
  }
  return records;
}

test("keeps model research and automation closed while forward evidence is insufficient", () => {
  const report = buildShadowBasisReadiness(recordsForSignal(0, { complete: false }));

  assert.equal(report.samples.signals, 1);
  assert.equal(report.samples.completeSignals, 0);
  assert.equal(report.modelResearchEligible, false);
  assert.equal(report.strategyPromotionEligible, false);
  assert.equal(report.automaticTradingEligible, false);
  assert.ok(report.modelResearchBlockers.includes("INSUFFICIENT_COMPLETE_SIGNALS"));
  assert.deepEqual(report.automationBlockers, [
    "EXPLICIT_AUTHORIZATION_REQUIRED",
    "AUTOMATIC_TRADING_NOT_IMPLEMENTED"
  ]);
});

test("uses chronological out-of-sample net executable results, PF, drawdown, coverage, and quality", () => {
  const records = [];
  for (let index = 0; index < 100; index += 1) {
    records.push(...recordsForSignal(index, {
      returnPct: index >= 70 && index % 2 ? -0.25 : 1
    }));
  }
  const report = buildShadowBasisReadiness(records);

  assert.equal(report.samples.completeSignals, 100);
  assert.equal(report.samples.checkpointCoverage, 1);
  assert.equal(report.samples.dataQualityPassRate, 1);
  assert.equal(report.split.trainingSignals, 70);
  assert.equal(report.split.outOfSampleSignals, 30);
  assert.equal(report.outOfSample.profitFactor, 4);
  assert.equal(report.outOfSample.maxDrawdownPct, 0.25);
  assert.equal(report.modelResearchEligible, true);
  assert.equal(report.strategyPromotionEligible, true);
  assert.equal(report.automaticTradingEligible, false);
});
