import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBstocksEligibility } from "../src/entry-eligibility.mjs";

function cleanInputs(overrides = {}) {
  return {
    instrument: {
      instrumentId: "binance-web3-rwa:bsc:0xa9ee",
      underlyingSymbol: "NVDA",
      contractAddress: "0xa9ee",
      discoveryStatus: "LIVE_ALLOWED"
    },
    universeChanges: { baselineAvailable: true, contractChanges: [], multiplierChanges: [] },
    assetStatus: {
      openState: true,
      reasonCode: "TRADING",
      marketStatus: "regular"
    },
    statusRetrievedAt: "2026-08-01T01:00:00.000Z",
    companyAction: {
      status: "CLEAR",
      source: "NASDAQ_OFFICIAL",
      checkedAt: "2026-08-01T01:00:00.000Z"
    },
    theoreticalPrice: {
      vetoReasons: [],
      multiplier: { effectiveAt: "2026-07-31T20:00:00.000Z" }
    },
    executableBasis: {
      vetoReasons: [],
      roundTripCostPct: 0.4,
      execution: {
        buy: { ageMs: 2_000 },
        sell: { ageMs: 1_000 }
      }
    },
    observedAt: "2026-08-01T01:00:01.000Z",
    maxStatusAgeMs: 10_000,
    maxCompanyActionAgeMs: 86_400_000,
    maxRoundTripCostPct: 0.7,
    ...overrides
  };
}

test("allows an entry only when identity, market, company action, liquidity, and data checks all pass", () => {
  assert.deepEqual(evaluateBstocksEligibility(cleanInputs()), {
    schemaVersion: 1,
    evaluatedAt: "2026-08-01T01:00:01.000Z",
    entryAllowed: true,
    protectiveExitAllowed: true,
    vetoReasons: [],
    checks: {
      identity: true,
      market: true,
      companyAction: true,
      referenceData: true,
      liquidity: true,
      freshness: true
    }
  });
});

test("aggregates hard entry vetoes without allowing signal strength to override them", () => {
  const result = evaluateBstocksEligibility(cleanInputs({
    instrument: {
      instrumentId: "binance-web3-rwa:bsc:0xa9ee",
      underlyingSymbol: "NVDA",
      contractAddress: "0xa9ee",
      discoveryStatus: "RESEARCH_ONLY"
    },
    universeChanges: {
      baselineAvailable: true,
      contractChanges: [{ symbol: "NVDA", previousContractAddresses: ["0xold"], currentContractAddresses: ["0xa9ee"] }],
      multiplierChanges: [{ instrumentId: "binance-web3-rwa:bsc:0xa9ee", previousMultiplier: 1, currentMultiplier: 0.5 }]
    },
    assetStatus: { openState: false, reasonCode: "CORPORATE_ACTION", marketStatus: "closed" },
    statusRetrievedAt: "2026-08-01T00:59:40.000Z",
    companyAction: { status: "PENDING", source: "NASDAQ_OFFICIAL", checkedAt: "2026-07-30T00:00:00.000Z" },
    theoreticalPrice: { vetoReasons: ["REFERENCE_PRICE_CONFLICT"], multiplier: { effectiveAt: null } },
    executableBasis: {
      vetoReasons: ["BUY_QUOTE_STALE"],
      roundTripCostPct: 1.2,
      execution: { buy: { ageMs: 20_000 }, sell: { ageMs: 20_000 } }
    }
  }));

  assert.equal(result.entryAllowed, false);
  assert.equal(result.protectiveExitAllowed, true);
  assert.deepEqual(result.vetoReasons, [
    "NOT_LIVE_ALLOWED",
    "IDENTITY_CHANGED",
    "MULTIPLIER_CHANGED",
    "ASSET_NOT_OPEN",
    "ASSET_NOT_TRADING",
    "MARKET_NOT_REGULAR",
    "MARKET_STATUS_STALE",
    "CORPORATE_ACTION_UNRESOLVED",
    "COMPANY_ACTION_STATUS_STALE",
    "REFERENCE_PRICE_CONFLICT",
    "BUY_QUOTE_STALE",
    "LIQUIDITY_COST_TOO_HIGH"
  ]);
});

test("protective exits remain allowed even when every new-entry gate fails", () => {
  const result = evaluateBstocksEligibility(cleanInputs({
    instrument: null,
    assetStatus: null,
    companyAction: null,
    theoreticalPrice: null,
    executableBasis: null
  }));

  assert.equal(result.entryAllowed, false);
  assert.equal(result.protectiveExitAllowed, true);
  assert.ok(result.vetoReasons.length > 0);
});

test("propagates an official corporate-action blackout as an entry-only veto", () => {
  const result = evaluateBstocksEligibility(cleanInputs({
    companyAction: {
      status: "BLOCKED",
      source: "NASDAQ_OFFICIAL_CALENDARS",
      checkedAt: "2026-08-01T01:00:00.000Z",
      vetoReasons: ["CORPORATE_ACTION_BLACKOUT"]
    }
  }));

  assert.equal(result.entryAllowed, false);
  assert.equal(result.protectiveExitAllowed, true);
  assert.deepEqual(result.vetoReasons, ["CORPORATE_ACTION_BLACKOUT"]);
});

test("requires a persisted multiplier baseline when the provider has no effective time", () => {
  const result = evaluateBstocksEligibility(cleanInputs({
    universeChanges: { baselineAvailable: false, contractChanges: [], multiplierChanges: [] },
    theoreticalPrice: {
      vetoReasons: [],
      warnings: ["MULTIPLIER_EFFECTIVE_TIME_UNAVAILABLE"],
      multiplier: { effectiveAt: null }
    }
  }));

  assert.equal(result.entryAllowed, false);
  assert.deepEqual(result.vetoReasons, ["MULTIPLIER_BASELINE_UNAVAILABLE"]);
});
