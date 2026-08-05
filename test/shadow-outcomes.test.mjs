import assert from "node:assert/strict";
import test from "node:test";
import { buildShadowOutcomeReport } from "../src/shadow-outcomes.mjs";

function scan(scanId, symbol, recordedAt, price, decision, pullbackDecision = "WOULD_WAIT") {
  return {
    recordType: "market_scan",
    scanId,
    symbol,
    recordedAt,
    signal: { lastPrice: price },
    shadowDowntrendVeto: { decision },
    shadowTrendPullback: { decision: pullbackDecision },
    shadowTrendQuality: { decision: "WOULD_ALLOW" },
    gates: { marketOpen: true, trendPassed: true }
  };
}

test("labels forward shadow outcomes and compares allow versus block cohorts", () => {
  const records = [
    scan("entry-a", "NVDA", "2026-07-28T13:30:00.000Z", 100, "WOULD_ALLOW"),
    {
      recordType: "quote_evaluation",
      scanId: "entry-a",
      symbol: "NVDA",
      recordedAt: "2026-07-28T13:30:01.000Z",
      executionCost: { allInCostPct: 0.5 },
      initialRisk: { initialRiskPct: 1 },
      costCoverage: { allowed: true }
    },
    scan("future-a", "NVDA", "2026-07-28T13:45:00.000Z", 102, "WOULD_ALLOW"),
    scan("entry-b", "TSLA", "2026-07-28T13:30:00.000Z", 200, "WOULD_BLOCK"),
    {
      recordType: "quote_evaluation",
      scanId: "entry-b",
      symbol: "TSLA",
      recordedAt: "2026-07-28T13:30:01.000Z",
      executionCost: { allInCostPct: 0.5 },
      initialRisk: { initialRiskPct: 2 },
      costCoverage: { allowed: true }
    },
    scan("future-b", "TSLA", "2026-07-28T13:45:00.000Z", 196, "WOULD_BLOCK")
  ];

  const report = buildShadowOutcomeReport(records, {
    generatedAt: "2026-07-28T14:00:00.000Z",
    horizonsMinutes: [15]
  });

  assert.equal(report.method.priceSource, "TOKEN_SCAN_CLOSE_PROXY");
  assert.equal(report.candidates, 2);
  assert.equal(report.shadowLabeledCandidates, 2);
  assert.equal(report.horizons[0].labeled, 2);
  assert.equal(report.horizons[0].cohorts.WOULD_ALLOW.winRatePct, 100);
  assert.ok(Math.abs(report.horizons[0].cohorts.WOULD_ALLOW.averageNetReturnPct - 1.5) < 1e-9);
  assert.equal(report.horizons[0].cohorts.WOULD_BLOCK.winRatePct, 0);
  assert.ok(Math.abs(report.horizons[0].cohorts.WOULD_BLOCK.averageNetReturnPct - (-2.5)) < 1e-9);
  assert.ok(Math.abs(report.outcomes[0].netReturnR - 1.5) < 1e-9);
  assert.equal(report.outcomes[0].exitReason, "HORIZON_MARK");
  assert.equal(report.outcomes[0].maePct, -0.5);
  assert.ok(Math.abs(report.outcomes[0].mfePct - 1.5) < 1e-9);
});

test("compares adaptive momentum with trend pullback candidates under one market regime", () => {
  const records = [
    scan("adaptive", "NVDA", "2026-07-28T13:30:00.000Z", 100, "WOULD_ALLOW"),
    {
      recordType: "quote_evaluation",
      scanId: "adaptive",
      symbol: "NVDA",
      recordedAt: "2026-07-28T13:30:01.000Z",
      executionCost: { allInCostPct: 0.5 },
      initialRisk: { initialRiskPct: 1 },
      costCoverage: { allowed: true }
    },
    scan("adaptive-future", "NVDA", "2026-07-28T13:45:00.000Z", 101, "WOULD_ALLOW"),
    {
      recordType: "market_scan",
      scanId: "pullback",
      symbol: "TSLA",
      recordedAt: "2026-07-28T13:30:00.000Z",
      signal: { lastPrice: 200 },
      shadowDowntrendVeto: { decision: "WOULD_ALLOW" },
      shadowTrendPullback: { decision: "WOULD_ENTER" },
      gates: { marketOpen: true, trendPassed: false }
    },
    {
      recordType: "quote_evaluation",
      scanId: "pullback",
      symbol: "TSLA",
      recordedAt: "2026-07-28T13:30:01.000Z",
      executionCost: { allInCostPct: 0.5 },
      initialRisk: { initialRiskPct: 2 },
      shadowTrendPullbackCostCoverage: { allowed: true },
      costCoverage: { allowed: false }
    },
    scan("pullback-future", "TSLA", "2026-07-28T13:45:00.000Z", 204, "WOULD_ALLOW"),
    {
      recordType: "shadow_market_regime",
      cycleId: "cycle-1",
      recordedAt: "2026-07-28T13:30:02.000Z",
      decision: "WOULD_ALLOW"
    }
  ];

  records[0].cycleId = "cycle-1";
  records[1].cycleId = "cycle-1";
  records[3].cycleId = "cycle-1";
  records[4].cycleId = "cycle-1";
  const report = buildShadowOutcomeReport(records, {
    generatedAt: "2026-07-28T14:00:00.000Z",
    horizonsMinutes: [15]
  });

  const comparison = report.horizons[0].strategyCohorts;
  assert.equal(comparison["adaptive-momentum"].samples, 1);
  assert.equal(comparison["trend-pullback-confirmation"].samples, 1);
  assert.equal(report.marketRegimeLabeledCandidates, 2);
  assert.equal(report.horizons[0].marketRegimeCohorts.WOULD_ALLOW.samples, 2);
  assert.equal(report.horizons[0].marketRegimeCohorts.WOULD_BLOCK.samples, 0);
  assert.equal(report.outcomes.find(({ scanId }) => scanId === "pullback").marketRegimeDecision, "WOULD_ALLOW");
});

test("tracks the independent regime-relative pullback shadow cohort", () => {
  const records = [
    scan("composite", "NVDA", "2026-07-28T13:30:00.000Z", 100, "WOULD_ALLOW", "WOULD_ENTER"),
    {
      recordType: "quote_evaluation",
      scanId: "composite",
      symbol: "NVDA",
      recordedAt: "2026-07-28T13:30:01.000Z",
      executionCost: { allInCostPct: 0.5 },
      initialRisk: { initialRiskPct: 1 },
      shadowTrendPullbackCostCoverage: { allowed: true },
      costCoverage: { allowed: false }
    },
    {
      recordType: "shadow_candidate_comparison",
      scanId: "composite",
      symbol: "NVDA",
      recordedAt: "2026-07-28T13:30:02.000Z",
      regimeRelativePullbackMomentum: {
        decision: "WOULD_ENTER",
        benchmarkReturn60mPct: 0.5,
        benchmarkRelativeReturn60mPct: 1.5,
        relativeStrengthRank: 1,
        stockUniverseSize: 8,
        costAllowed: true
      }
    },
    scan("composite-future", "NVDA", "2026-07-28T13:45:00.000Z", 102, "WOULD_ALLOW")
  ];

  const report = buildShadowOutcomeReport(records, {
    generatedAt: "2026-07-28T14:00:00.000Z",
    horizonsMinutes: [15]
  });

  const cohort = report.horizons[0].strategyCohorts["regime-relative-pullback-momentum"];
  assert.equal(report.regimeRelativePullbackLabeledCandidates, 1);
  assert.equal(cohort.samples, 1);
  assert.equal(cohort.winRatePct, 100);
  assert.ok(Math.abs(cohort.averageNetReturnPct - 1.5) < 1e-9);
  const outcome = report.outcomes.find(({ scanId }) => scanId === "composite");
  assert.equal(outcome.regimeRelativePullbackDecision, "WOULD_ENTER");
  assert.equal(outcome.benchmarkRelativeReturn60mPct, 1.5);
});
