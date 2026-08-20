import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildTradingReview,
  shouldGenerateTradingReview,
  writeTradingReviewArchive
} from "../src/trade-review.mjs";

const records = [
  {
    timestamp: "2026-07-30T13:48:53.000Z",
    cycleId: "entry-msft",
    event: "shadow_sub_strategy",
    status: "observed",
    details: {
      symbol: "MSFT",
      subStrategyId: "shadow-trend-pullback-confirmation",
      decision: "WOULD_WAIT",
      reason: "WAITING_FOR_CONTROLLED_PULLBACK"
    }
  },
  {
    timestamp: "2026-07-30T13:48:54.000Z",
    cycleId: "entry-msft",
    event: "buy_submission",
    status: "submitted",
    details: {
      symbol: "MSFT",
      strategyId: "adaptive-momentum",
      amountUsdt: 50,
      allInCostPct: 0.56,
      netEdgeProxyPct: 1.21,
      initialRiskPct: 1.27,
      shadowRegimeRelativePullbackDecision: "WOULD_WAIT",
      shadowRegimeRelativePullbackReason: "PULLBACK_NOT_CONFIRMED",
      orderId: "buy-msft"
    }
  },
  {
    timestamp: "2026-07-30T13:49:57.000Z",
    cycleId: "entry-msft-finished",
    event: "pending_order",
    status: "finished",
    details: {
      side: "BUY",
      symbol: "MSFT",
      orderId: "buy-msft",
      gasUsdt: 0.02
    }
  },
  {
    timestamp: "2026-07-30T14:06:19.000Z",
    cycleId: "monitor-msft",
    event: "shadow_exit_counterfactual",
    status: "observed",
    details: {
      symbol: "MSFT",
      decision: "WOULD_EXIT",
      reason: "EARLY_BREAKOUT_FAILED",
      returnPct: -1.34,
      estimatedNetPnlUsdt: -0.35,
      estimatedNetR: -0.55,
      executableProceedsUsdt: 49.68,
      estimatedExitGasUsdt: 0.03
    }
  },
  {
    timestamp: "2026-07-30T14:07:33.000Z",
    cycleId: "stop-msft-1",
    event: "exit_decision",
    status: "allowed",
    details: {
      symbol: "MSFT",
      reason: "stop_loss_override",
      exitType: "INITIAL_STOP"
    }
  },
  {
    timestamp: "2026-07-30T14:07:35.000Z",
    cycleId: "stop-msft-1",
    event: "trade_approval",
    status: "requested",
    details: {
      side: "SELL",
      symbol: "MSFT"
    }
  },
  {
    timestamp: "2026-07-30T14:08:39.000Z",
    cycleId: "stop-msft-1-approved",
    event: "exit_decision",
    status: "skipped",
    details: {
      symbol: "MSFT",
      reason: "dynamic_exit_not_triggered"
    }
  },
  {
    timestamp: "2026-07-30T15:02:13.000Z",
    cycleId: "stop-msft-2",
    event: "exit_decision",
    status: "allowed",
    details: {
      symbol: "MSFT",
      reason: "stop_loss_override",
      exitType: "INITIAL_STOP"
    }
  },
  {
    timestamp: "2026-07-30T15:02:14.000Z",
    cycleId: "stop-msft-2",
    event: "trade_approval",
    status: "requested",
    details: {
      side: "SELL",
      symbol: "MSFT"
    }
  },
  {
    timestamp: "2026-07-30T15:03:22.000Z",
    cycleId: "sell-msft",
    event: "pending_order",
    status: "finished",
    details: {
      side: "SELL",
      symbol: "MSFT",
      strategyId: "adaptive-momentum",
      orderId: "sell-msft",
      grossPnlUsdt: -0.76,
      gasCostUsdt: 0.04,
      realizedPnlUsdt: -0.8,
      exitReason: "INITIAL_STOP",
      maePct: -1.54,
      mfePct: 0.02,
      realizedR: -1.26
    }
  },
  {
    timestamp: "2026-07-30T19:59:22.000Z",
    cycleId: "close-boundary",
    event: "wallet_cli",
    status: "failed",
    details: {
      operation: "market-order quote",
      error: "no available liquidity"
    }
  }
];

test("builds a real-trade daily review without counting Shadow as fills", () => {
  const report = buildTradingReview({
    records,
    state: {
      positions: [{
        symbol: "GOOGL",
        strategyId: "adaptive-momentum",
        costBasisUsdt: 50,
        lastQuoteProceedsUsdt: 50.2,
        entryGasUsdt: 0.01,
        lastSignalValid: false,
        openedAt: "2026-07-30T15:56:42.000Z"
      }]
    },
    tradingDate: "2026-07-30",
    generatedAt: "2026-07-30T22:15:00.000Z",
    reviewPhase: "PRELIMINARY",
    sessionDates: ["2026-07-24", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30"],
    externalMarket: {
      status: "AVAILABLE",
      marketAttributedLossSharePct: 25,
      lossDirectionAlignmentPct: 33.3,
      trades: []
    },
    premarketBrief: {
      status: "AVAILABLE",
      advice: { level: "SELECTIVE_LONG", executionEffect: "NONE" }
    }
  });

  assert.equal(report.daily.trades, 1);
  assert.equal(report.daily.realizedPnlUsdt, -0.8);
  assert.equal(report.daily.gasCostUsdt, 0.04);
  assert.equal(report.daily.winRatePct, 0);
  assert.equal(report.daily.exitReasons.INITIAL_STOP, 1);
  assert.equal(report.trades[0].stopTriggerCount, 2);
  assert.equal(report.trades[0].stopRevalidationCancelledCount, 1);
  assert.equal(report.trades[0].entryShadow.pullback.decision, "WOULD_WAIT");
  assert.equal(report.trades[0].entryShadow.regimeRelativePullback.decision, "WOULD_WAIT");
  assert.equal(report.trades[0].earlyExitShadow.decision, "WOULD_EXIT");
  assert.equal(report.trades[0].earlyExitShadow.estimatedNetPnlUsdt, -0.35);
  assert.ok(Math.abs(report.trades[0].earlyExitShadow.estimatedSavingsUsdt - 0.45) < 1e-9);
  assert.equal(report.reviewPhase, "PRELIMINARY");
  assert.equal(report.shadowCounterfactuals.regimeRelativePullbackMomentum.labeledTrades, 1);
  assert.equal(report.shadowCounterfactuals.regimeRelativePullbackMomentum.vetoedTrades, 1);
  assert.equal(report.shadowCounterfactuals.regimeRelativePullbackMomentum.avoidedLossUsdt, 0.8);
  assert.equal(report.shadowCounterfactuals.regimeRelativePullbackMomentum.missedProfitUsdt, 0);
  assert.equal(report.shadowCounterfactuals.regimeRelativePullbackMomentum.netPnlImprovementUsdt, 0.8);
  assert.equal(report.openPositions[0].symbol, "GOOGL");
  assert.equal(report.systemFailures.count, 1);
  assert.equal(report.periods.find(({ sessions }) => sessions === 5).trades, 1);
  assert.equal(report.externalMarket.marketAttributedLossSharePct, 25);
  assert.equal(report.premarketBrief.advice.level, "SELECTIVE_LONG");
  assert.match(report.findings.join(" "), /止损/);
  assert.match(report.findings.join(" "), /回撤/);
});

test("archives daily reviews and keeps a newest-first history index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-trade-review-"));
  const first = buildTradingReview({
    records,
    state: { positions: [] },
    tradingDate: "2026-07-30",
    generatedAt: "2026-07-30T22:15:00.000Z",
    sessionDates: ["2026-07-30"]
  });
  await writeTradingReviewArchive(directory, first);
  await writeTradingReviewArchive(directory, {
    ...first,
    generatedAt: "2026-07-31T22:15:00.000Z",
    tradingDate: "2026-07-31"
  });

  const latest = JSON.parse(await readFile(join(directory, "latest.json"), "utf8"));
  const index = JSON.parse(await readFile(join(directory, "index.json"), "utf8"));
  assert.equal(latest.tradingDate, "2026-07-31");
  assert.deepEqual(index.reports.map(({ tradingDate }) => tradingDate), [
    "2026-07-31",
    "2026-07-30"
  ]);
});

test("refreshes a preliminary archive once as final without repeatedly rewriting it", () => {
  assert.equal(shouldGenerateTradingReview({
    currentNewYorkDate: "2026-12-25",
    tradingDate: "2026-12-24",
    archivedPhase: "PRELIMINARY"
  }), true);
  assert.equal(shouldGenerateTradingReview({
    currentNewYorkDate: "2026-12-25",
    tradingDate: "2026-12-24",
    archivedPhase: "FINAL"
  }), false);
  assert.equal(shouldGenerateTradingReview({
    currentNewYorkDate: "2026-12-24",
    tradingDate: "2026-12-24",
    archivedPhase: null
  }), true);
});
