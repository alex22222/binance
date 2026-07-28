import assert from "node:assert/strict";
import test from "node:test";
import { buildShadowOutcomeReport } from "../src/shadow-outcomes.mjs";

function scan(scanId, symbol, recordedAt, price, decision) {
  return {
    recordType: "market_scan",
    scanId,
    symbol,
    recordedAt,
    signal: { lastPrice: price },
    shadowDowntrendVeto: { decision },
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

  assert.equal(report.method.priceSource, "UNDERLYING_SCAN_CLOSE_PROXY");
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
