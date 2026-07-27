import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardSnapshot } from "../src/dashboard.mjs";

const config = {
  mode: "shadow",
  symbols: ["NVDA", "TSLA"],
  maxTradeUsdt: 50,
  dailyLossLimitUsdt: 10,
  maxOpenPositions: 1,
  pollSeconds: 60,
  entryIntervalMinutes: 15,
  regularOnlyEntries: true,
  disasterStopLossPct: 8,
  atrPeriod: 14,
  atrStopMultiplier: 1.5,
  entryAtrMultiplier: 0.75,
  minInitialStopPct: 1,
  maxInitialStopPct: 3.5,
  profitProtectionR: 1,
  trailingAtrMultiplier: 1,
  finalTakeProfitR: 2,
  signalReviewHours: 4,
  signalReviewMinR: 0.5,
  minDirectionalMinutes: 9,
  maxRoundTripCostPct: 0.7,
  slippagePct: 0.5,
  executionBufferPct: 0.1,
  estimatedRoundTripGasUsdt: 0.1,
  minNetEdgePct: 0.3
};

test("builds a live position snapshot from the latest executable sell quote", () => {
  const nowMs = Date.parse("2026-07-24T13:00:00.000Z");
  const snapshot = buildDashboardSnapshot({
    config,
    state: {
      date: "2026-07-24",
      realizedPnlUsdt: -1,
      updatedAt: "2026-07-24T12:59:30.000Z",
      lastError: null,
      walletBalance: {
        totalUsd: 449.67578352,
        assetCount: 2,
        checkedAt: "2026-07-24T12:59:00.000Z"
      },
      pendingOrder: null,
      position: {
        symbol: "NVDA",
        address: "0xabc",
        quantity: 0.5,
        costBasisUsdt: 50,
        initialRiskPct: 2,
        profitFloorPct: 1.7,
        entryAtr15Pct: 1,
        currentAtr15Pct: 0.9,
        peakReturnPct: 8.5,
        profitProtectionActive: true,
        trailingStopPct: 7.6,
        openedAt: "2026-07-24T12:00:00.000Z",
        lastQuoteProceedsUsdt: 54,
        lastQuoteAt: "2026-07-24T12:59:30.000Z",
        entryGasUsdt: 0.04,
        entryGasSource: "ACTUAL_RECEIPT",
        shadow: false
      }
    },
    traceRecords: [],
    nowMs
  });

  assert.equal(snapshot.health.status, "RUNNING");
  assert.equal(snapshot.position.grossUnrealizedPnlUsdt, 4);
  assert.equal(snapshot.position.unrealizedPnlUsdt, 3.91);
  assert.ok(Math.abs(snapshot.position.returnPct - 7.82) < 1e-9);
  assert.equal(snapshot.position.entryGasUsdt, 0.04);
  assert.equal(snapshot.position.estimatedExitGasUsdt, 0.05);
  assert.equal(snapshot.risk.dailyLossRemainingUsdt, 9);
  assert.equal(snapshot.risk.disasterStopLossPct, 8);
  assert.equal(snapshot.position.initialRiskPct, 2);
  assert.equal(snapshot.position.profitFloorPct, 1.7);
  assert.equal(snapshot.position.trailingStopPct, 7.6);
  assert.equal(snapshot.position.address, "0xabc");
  assert.equal(snapshot.strategy.regularOnlyEntries, true);
  assert.equal(snapshot.strategy.effectiveRoundTripGasUsdt, 0.1);
  assert.equal(snapshot.strategy.gasEstimateSource, "CONFIGURED");
  assert.equal(snapshot.strategy.actualGasSampleCount, 0);
  assert.equal(snapshot.walletBalance.totalUsd, 449.67578352);
  assert.equal(snapshot.walletBalance.assetCount, 2);
});

test("shows pending orders and the latest signal for each symbol", () => {
  const snapshot = buildDashboardSnapshot({
    config,
    state: {
      date: "2026-07-24",
      realizedPnlUsdt: 0,
      updatedAt: "2026-07-24T12:59:30.000Z",
      position: null,
      pendingOrder: { side: "BUY", symbol: "TSLA", orderId: "order-1" }
    },
    traceRecords: [
      {
        timestamp: "2026-07-24T12:58:00.000Z",
        sequence: 1,
        event: "candidate_rejected",
        status: "skipped",
        details: { symbol: "NVDA", trend15mPct: -0.2, upMinutes: 6 }
      },
      {
        timestamp: "2026-07-24T12:59:00.000Z",
        sequence: 2,
        event: "candidate_evaluated",
        status: "succeeded",
        details: {
          symbol: "TSLA",
          dataFetchedAt: "2026-07-24T12:58:57.250Z",
          trend15mPct: 1.1,
          upMinutes: 11,
          roundTripCostPct: 0.4,
          allInCostPct: 0.9,
          netEdgeProxyPct: 0.2,
          atr15Pct: 0.7,
          initialRiskPct: 1.55,
          finalTakeProfitPct: 3.1,
          costCoverageAllowed: false,
          costCoverageReason: "INSUFFICIENT_NET_EDGE",
          shadowConcentrationDecision: "WOULD_LIMIT",
          shadowCompletedEntriesToday: 1,
          shadowTrendQualityDecision: "WOULD_BLOCK",
          shadowTrendEfficiency: 0.2,
          shadowPositionSizeDecision: "WOULD_REDUCE",
          shadowSuggestedTradeUsdt: 32.26
        }
      }
    ],
    nowMs: Date.parse("2026-07-24T13:00:00.000Z")
  });

  assert.equal(snapshot.pendingOrder.orderId, "order-1");
  assert.equal(snapshot.signals.TSLA.trend15mPct, 1.1);
  assert.equal(snapshot.signals.TSLA.dataFetchedAt, "2026-07-24T12:58:57.250Z");
  assert.equal(snapshot.signals.TSLA.allInCostPct, 0.9);
  assert.equal(snapshot.signals.TSLA.atr15Pct, 0.7);
  assert.equal(snapshot.signals.TSLA.initialRiskPct, 1.55);
  assert.equal(snapshot.signals.TSLA.costCoverageAllowed, false);
  assert.equal(snapshot.signals.TSLA.shadowConcentrationDecision, "WOULD_LIMIT");
  assert.equal(snapshot.signals.TSLA.shadowTrendQualityDecision, "WOULD_BLOCK");
  assert.equal(snapshot.signals.TSLA.shadowTrendEfficiency, 0.2);
  assert.equal(snapshot.signals.TSLA.shadowSuggestedTradeUsdt, 32.26);
  assert.equal(snapshot.signals.NVDA.upMinutes, 6);
});

test("keeps an unavailable wallet balance distinct from a zero balance", () => {
  const snapshot = buildDashboardSnapshot({
    config,
    state: {
      date: "2026-07-24",
      realizedPnlUsdt: 0,
      updatedAt: "2026-07-24T12:59:30.000Z",
      walletBalance: {
        totalUsd: null,
        assetCount: 0,
        checkedAt: null,
        lastCheckFailedAt: "2026-07-24T12:59:00.000Z"
      }
    },
    traceRecords: [],
    nowMs: Date.parse("2026-07-24T13:00:00.000Z")
  });

  assert.equal(snapshot.walletBalance.totalUsd, null);
});

test("exposes daily wallet values as an asset trend without inventing missing days", () => {
  const snapshot = buildDashboardSnapshot({
    config,
    state: {
      date: "2026-07-27",
      realizedPnlUsdt: 0,
      updatedAt: "2026-07-27T15:01:00.000Z",
      walletBalance: {
        totalUsd: 455.5,
        assetCount: 2,
        checkedAt: "2026-07-27T15:00:00.000Z"
      }
    },
    walletBalanceHistory: [
      { date: "2026-07-25", totalUsd: 448, assetCount: 2, checkedAt: "2026-07-25T15:00:00.000Z" },
      { date: "2026-07-26", totalUsd: 452, assetCount: 2, checkedAt: "2026-07-26T15:00:00.000Z" }
    ],
    traceRecords: [],
    nowMs: Date.parse("2026-07-27T15:01:00.000Z")
  });

  assert.deepEqual(snapshot.assetTrend, [
    { date: "2026-07-25", totalUsd: 448, assetCount: 2, checkedAt: "2026-07-25T15:00:00.000Z" },
    { date: "2026-07-26", totalUsd: 452, assetCount: 2, checkedAt: "2026-07-26T15:00:00.000Z" },
    { date: "2026-07-27", totalUsd: 455.5, assetCount: 2, checkedAt: "2026-07-27T15:00:00.000Z" }
  ]);
});

test("uses read-only local signal history until a newer server signal replaces it", () => {
  const snapshot = buildDashboardSnapshot({
    config,
    state: {
      date: "2026-07-25",
      realizedPnlUsdt: 0,
      updatedAt: "2026-07-25T15:38:05.000Z",
      lastMarketSession: "offhours",
      position: null,
      pendingOrder: null
    },
    signalHistoryRecords: [
      {
        timestamp: "2026-07-25T01:45:00.000Z",
        event: "candidate_rejected",
        status: "skipped",
        details: {
          symbol: "NVDA",
          trend15mPct: 0.01,
          upMinutes: 4,
          atr15Pct: 0.07,
          signalSource: "local-history"
        }
      },
      {
        timestamp: "2026-07-25T01:45:00.000Z",
        event: "candidate_rejected",
        status: "skipped",
        details: {
          symbol: "TSLA",
          trend15mPct: -0.02,
          upMinutes: 7,
          atr15Pct: 0.14,
          signalSource: "local-history"
        }
      }
    ],
    traceRecords: [
      {
        timestamp: "2026-07-25T13:35:00.000Z",
        event: "candidate_evaluated",
        status: "succeeded",
        details: {
          symbol: "NVDA",
          trend15mPct: 0.2,
          upMinutes: 10,
          atr15Pct: 0.1
        }
      }
    ],
    nowMs: Date.parse("2026-07-25T15:40:00.000Z")
  });

  assert.equal(snapshot.marketSession, "offhours");
  assert.equal(snapshot.signals.NVDA.trend15mPct, 0.2);
  assert.equal(snapshot.signals.NVDA.source, "server-live");
  assert.equal(snapshot.signals.TSLA.trend15mPct, -0.02);
  assert.equal(snapshot.signals.TSLA.source, "local-history");
  assert.equal(snapshot.signals.TSLA.dataFetchedAt, "2026-07-25T01:45:00.000Z");
});

test("shows a fresh approval request as actionable and an expired one as read-only", () => {
  const request = {
    approvalId: "0123456789abcdef01234567",
    status: "PENDING_CONFIRMATION",
    side: "BUY",
    symbol: "NVDA",
    address: "0x1111111111111111111111111111111111111111",
    fromToken: "0x55d398326f99059fF775485246999027B3197955",
    toToken: "0x1111111111111111111111111111111111111111",
    fromTokenQty: "50",
    expectedOutputQty: "0.42",
    createdAt: "2026-07-24T12:59:00.000Z",
    expiresAt: "2026-07-24T13:04:00.000Z",
    dyorRequired: true
  };
  const active = buildDashboardSnapshot({
    config,
    state: {
      date: "2026-07-24",
      realizedPnlUsdt: 0,
      updatedAt: "2026-07-24T12:59:30.000Z",
      position: null,
      pendingOrder: null,
      approvalRequest: request
    },
    traceRecords: [],
    nowMs: Date.parse("2026-07-24T13:00:00.000Z")
  });
  assert.equal(active.approvalRequest.approvalId, request.approvalId);
  assert.equal(active.approvalRequest.canDecide, true);

  const expired = buildDashboardSnapshot({
    config,
    state: {
      date: "2026-07-24",
      realizedPnlUsdt: 0,
      updatedAt: "2026-07-24T13:05:00.000Z",
      position: null,
      pendingOrder: null,
      approvalRequest: request
    },
    traceRecords: [],
    nowMs: Date.parse("2026-07-24T13:05:00.000Z")
  });
  assert.equal(expired.approvalRequest.canDecide, false);
  assert.equal(expired.approvalRequest.displayStatus, "EXPIRED");
});

test("keeps an automatically approved request read-only while it awaits revalidation", () => {
  const nowMs = Date.parse("2026-07-24T13:00:00.000Z");
  const snapshot = buildDashboardSnapshot({
    config: { ...config, mode: "live" },
    state: {
      date: "2026-07-24",
      realizedPnlUsdt: 0,
      updatedAt: "2026-07-24T12:59:30.000Z",
      position: null,
      pendingOrder: null,
      approvalRequest: {
        approvalId: "0123456789abcdef01234567",
        status: "PENDING_CONFIRMATION",
        side: "BUY",
        symbol: "TSLA",
        expiresAt: "2026-07-24T13:04:00.000Z"
      }
    },
    approvalControl: {
      enabled: true,
      updatedAt: "2026-07-24T12:00:00.000Z",
      updatedBy: "dashboard"
    },
    traceRecords: [],
    nowMs
  });

  assert.equal(snapshot.approvalRequest.automaticallyApproved, true);
  assert.equal(snapshot.approvalRequest.canDecide, false);
  assert.equal(snapshot.approvalRequest.displayStatus, "AUTO_APPROVED_REVALIDATING");
});

test("marks an old heartbeat as stale and exposes the last cycle error", () => {
  const snapshot = buildDashboardSnapshot({
    config,
    state: {
      date: "2026-07-24",
      realizedPnlUsdt: 0,
      updatedAt: "2026-07-24T12:50:00.000Z",
      lastError: "Wallet status is UNCONNECTED",
      position: null,
      pendingOrder: null
    },
    traceRecords: [],
    nowMs: Date.parse("2026-07-24T13:00:00.000Z")
  });

  assert.equal(snapshot.health.status, "STALE");
  assert.equal(snapshot.health.lastError, "Wallet status is UNCONNECTED");
});

test("marks a recent heartbeat as degraded when the latest cycle failed", () => {
  const snapshot = buildDashboardSnapshot({
    config,
    state: {
      date: "2026-07-24",
      realizedPnlUsdt: 0,
      updatedAt: "2026-07-24T12:59:59.000Z",
      lastError: "NETWORK_ERROR: Connection reset by server",
      position: null,
      pendingOrder: null
    },
    traceRecords: [],
    nowMs: Date.parse("2026-07-24T13:00:00.000Z")
  });

  assert.equal(snapshot.health.status, "DEGRADED");
});

test("distinguishes a required wallet login from a service degradation", () => {
  const snapshot = buildDashboardSnapshot({
    config,
    state: {
      date: "2026-07-24",
      realizedPnlUsdt: 0,
      updatedAt: "2026-07-24T12:59:59.000Z",
      lastError: "SESSION_EXPIRED: Please log in first.",
      walletSession: {
        status: "EXPIRED",
        errorCode: 10003002,
        errorName: "SESSION_EXPIRED"
      },
      position: null,
      pendingOrder: null
    },
    traceRecords: [],
    nowMs: Date.parse("2026-07-24T13:00:00.000Z")
  });

  assert.equal(snapshot.health.status, "AUTH_REQUIRED");
});

test("shows a durable emergency stop as halted even when the last heartbeat is recent", () => {
  const snapshot = buildDashboardSnapshot({
    config,
    state: {
      date: "2026-07-24",
      realizedPnlUsdt: 0,
      updatedAt: "2026-07-24T12:59:59.000Z",
      emergencyStop: {
        active: true,
        reason: "operator",
        activatedAt: "2026-07-24T12:59:58.000Z"
      },
      position: null,
      pendingOrder: null
    },
    traceRecords: [],
    nowMs: Date.parse("2026-07-24T13:00:00.000Z")
  });

  assert.equal(snapshot.health.status, "HALTED");
  assert.equal(snapshot.health.emergencyStop.reason, "operator");
});
