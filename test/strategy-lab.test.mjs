import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  basisExitReached,
  buildStrategyComparison,
  entryExecutionDecision,
  executableBasisDecision,
  readStrategyControl,
  STRATEGY_TAXONOMY,
  writeEntryPauseControl,
  writeStrategyControl
} from "../src/strategy-lab.mjs";

test("admits only an executable discount that covers all costs", () => {
  const result = executableBasisDecision({
    executableBuyPrice: 98,
    underlyingPrice: 100,
    sharesMultiplier: 1,
    allInCostPct: 0.8,
    minNetEdgePct: 0.3
  });
  assert.equal(result.allowed, true);
  assert.ok(Math.abs(result.netEdgePct - 1.2) < 1e-9);
  assert.equal(executableBasisDecision({
    executableBuyPrice: 99.5,
    underlyingPrice: 100,
    sharesMultiplier: 1,
    allInCostPct: 0.4,
    minNetEdgePct: 0.3
  }).allowed, false);
});

test("exits a basis position when the executable sell price converges", () => {
  assert.equal(basisExitReached({ executableSellPrice: 99.95, fairTokenPrice: 100 }), true);
  assert.equal(basisExitReached({ executableSellPrice: 99.5, fairTokenPrice: 100 }), false);
});

test("persists only the live weekly strategy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "strategy-control-"));
  const path = join(directory, "control.json");
  await writeStrategyControl(path, "weekly-etf-dual-momentum-defense");
  assert.equal((await readStrategyControl(path)).strategyId, "weekly-etf-dual-momentum-defense");
  await assert.rejects(() => writeStrategyControl(path, "residual-reversal"), /not switchable/);
  await assert.rejects(() => writeStrategyControl(path, "adaptive-momentum"), /not switchable/);
});

test("pauses only BUY execution and preserves the pause across strategy switches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "entry-pause-control-"));
  const path = join(directory, "control.json");

  await writeEntryPauseControl(path, true, "weekly-etf-dual-momentum-defense", "test");
  assert.equal((await readStrategyControl(path)).entriesPaused, true);
  assert.deepEqual(entryExecutionDecision({ entriesPaused: true, side: "BUY" }), {
    allowed: false,
    reason: "ENTRIES_PAUSED"
  });
  assert.deepEqual(entryExecutionDecision({ entriesPaused: true, side: "SELL" }), {
    allowed: true,
    reason: "EXIT_ALLOWED"
  });

  await writeStrategyControl(path, "weekly-etf-dual-momentum-defense");
  const switched = await readStrategyControl(path);
  assert.equal(switched.strategyId, "weekly-etf-dual-momentum-defense");
  assert.equal(switched.entriesPaused, true);

  await writeEntryPauseControl(path, false, "weekly-etf-dual-momentum-defense", "test");
  assert.equal((await readStrategyControl(path)).entriesPaused, false);
});

test("compares realized returns by strategy without inventing missing results", () => {
  const comparison = buildStrategyComparison("adaptive-momentum", [
    { event: "sell_submission", status: "simulated", details: { strategyId: "adaptive-momentum", realizedPnlUsdt: 2 } },
    { event: "sell_submission", status: "simulated", details: { strategyId: "adaptive-momentum", realizedPnlUsdt: -1 } }
  ]);
  const momentum = comparison.find((strategy) => strategy.id === "adaptive-momentum");
  const basis = comparison.find((strategy) => strategy.id === "executable-basis-reversion");
  assert.equal(momentum.performanceByEvidence.simulated.trades, 2);
  assert.equal(momentum.performanceByEvidence.simulated.realizedPnlUsdt, 1);
  assert.equal(momentum.performanceByEvidence.simulated.winRatePct, 50);
  assert.equal(momentum.performance.trades, 0);
  assert.equal(momentum.performance.realizedPnlUsdt, null);
  assert.equal(basis.performance.trades, 0);
  assert.equal(basis.performance.winRatePct, null);
  assert.equal(basis.performance.maxDrawdownUsdt, null);
});

test("separates terminal Live logs from simulations and excludes missing PnL", () => {
  const record = (pnl, orderId, timestamp = "2026-09-25T10:00:00Z") => ({
    timestamp, event: "pending_order", status: "finished",
    details: {side:"SELL", strategyId:"adaptive-momentum", realizedPnlUsdt:pnl, orderId}
  });
  const trace = [record(4, "a"), record(-2, "b", "2026-09-26T10:00:00Z"), record(4, "a"),
    ...[null, undefined, "", true, "bad"].map((pnl, i) => record(pnl, "invalid-" + i)),
    {event:"sell_submission", status:"simulated", details:{strategyId:"adaptive-momentum", realizedPnlUsdt:100}},
    {event:"sell_submission", status:"submitted", details:{strategyId:"adaptive-momentum", realizedPnlUsdt:50}}
  ];
  const strategy = buildStrategyComparison("adaptive-momentum", trace).find(({id}) => id === "adaptive-momentum");
  assert.equal(strategy.performance.trades, 2);
  assert.equal(strategy.performance.realizedPnlUsdt, 2);
  assert.equal(strategy.performance.maxDrawdownUsdt, 2);
  assert.equal(strategy.performance.duplicateRecords, 1);
  assert.equal(strategy.performance.excludedRecords, 5);
  assert.equal(strategy.performance.scope, "TRACE_WINDOW_NOT_FULL_HISTORY");
  assert.equal(strategy.performance.period.from, "2026-09-25T10:00:00.000Z");
  assert.equal(strategy.performanceByEvidence.simulated.realizedPnlUsdt, 100);
});

test("conflicting order outcomes are unknown rather than added twice", () => {
  const trace = [1, 2].map(realizedPnlUsdt => ({
    event:"pending_order", status:"finished", details:{side:"SELL", strategyId:"adaptive-momentum", orderId:"conflict", realizedPnlUsdt}
  }));
  const strategy = buildStrategyComparison("adaptive-momentum", trace).find(({id}) => id === "adaptive-momentum");
  assert.equal(strategy.performance.conflictingOrders, 1);
  assert.equal(strategy.performance.realizedPnlUsdt, null);
});

test("orders terminal fills by time and preserves genuine zero returns", () => {
  const trace = [[-2, "2026-09-26"], [4, "2026-09-25"], [0, "2026-09-27"]].map(([pnl, day]) => ({
    timestamp: day + "T10:00:00Z", event: "pending_order", status: "finished",
    details: { side: "SELL", strategyId: "adaptive-momentum", orderId: day, realizedPnlUsdt: pnl }
  }));
  const performance = buildStrategyComparison("adaptive-momentum", trace)[1].performance;
  assert.equal(performance.trades, 3);
  assert.equal(performance.maxDrawdownUsdt, 2);
  assert.equal(performance.profitFactor, 2);
  const zero = buildStrategyComparison("adaptive-momentum", trace.slice(-1))[1].performance;
  assert.equal(zero.realizedPnlUsdt, 0);
  assert.equal(zero.winRatePct, 0);
  assert.equal(zero.maxDrawdownUsdt, 0);
});

test("does not invent a drawdown sequence for undated fills", () => {
  const trace = [{ event: "pending_order", status: "finished", details: {
    side: "SELL", strategyId: "adaptive-momentum", orderId: "undated", realizedPnlUsdt: -2
  } }];
  const performance = buildStrategyComparison("adaptive-momentum", trace)[1].performance;
  assert.equal(performance.realizedPnlUsdt, -2);
  assert.equal(performance.maxDrawdownUsdt, null);
  assert.deepEqual(performance.period, { from: null, to: null });
});

test("keeps the enhanced weekly ETF strategy as the only live-switchable strategy", () => {
  const comparison = buildStrategyComparison("adaptive-momentum", []);

  assert.equal(comparison.length, 12);
  assert.deepEqual(comparison.filter(({ switchable }) => switchable).map(({ id }) => id), [
    "weekly-etf-dual-momentum-defense"
  ]);
  const pullback = comparison.find((strategy) => strategy.id === "trend-pullback-confirmation");
  const relativePullback = comparison.find(
    (strategy) => strategy.id === "regime-relative-pullback-momentum"
  );
  assert.equal(pullback.status, "SHADOW");
  assert.equal(pullback.switchable, false);
  assert.equal(relativePullback.status, "SHADOW");
  assert.equal(relativePullback.switchable, false);
  for (const strategy of comparison) {
    assert.equal(strategy.direction, "LONG_ONLY");
    if (strategy.id === "weekly-etf-dual-momentum-defense") {
      assert.equal(strategy.switchable, true);
      assert.equal(strategy.validationStatus, "LIVE_MANUAL_APPROVAL");
      assert.deepEqual(strategy.subStrategies, []);
      continue;
    }
    assert.equal(strategy.subStrategies.length, 6);
    assert.equal(strategy.subStrategies[0].id, "shadow-market-regime-filter");
    assert.equal(strategy.subStrategies[0].mode, "SHADOW");
    assert.equal(strategy.subStrategies[0].enforced, false);
    assert.ok(strategy.subStrategies[0].role.length > 0);
    assert.equal(strategy.subStrategies[1].id, "shadow-downtrend-veto");
    assert.equal(strategy.subStrategies[2].id, "shadow-weak-rebound-veto");
    assert.equal(strategy.subStrategies[3].id, "shadow-net-edge-margin");
    assert.equal(strategy.subStrategies[4].id, "shadow-correlated-exposure-cap");
    assert.equal(strategy.subStrategies[5].id, "shadow-entry-failure-stop");
    assert.equal(strategy.subStrategies[5].mode, "SHADOW");
    assert.equal(strategy.subStrategies[5].enforced, false);
  }
});

test("registers the three daily high-hit-rate candidates as research only", () => {
  const comparison = buildStrategyComparison("adaptive-momentum", []);
  const candidates = [
    "daily-rsi2-trend-reversion",
    "daily-double7-trend-reversion",
    "daily-ibs-reversal"
  ].map((strategyId) => comparison.find(({ id }) => id === strategyId));

  assert.ok(candidates.every(Boolean));
  for (const strategy of candidates) {
    assert.equal(strategy.status, "RESEARCH");
    assert.equal(strategy.switchable, false);
    assert.equal(strategy.direction, "LONG_ONLY");
    assert.equal(strategy.timeframe, "DAILY_SIGNAL_REGULAR_SESSION_EXECUTION");
    assert.equal(strategy.validationStatus, "LOCAL_BACKTEST_EARLY_SAMPLE");
    assert.ok(strategy.backtestData.includes("Yahoo Finance 日线"));
    assert.ok(strategy.sources.length >= 1);
  }
});

test("registers turtle 55/20 as a non-switchable long-only research strategy", () => {
  const turtle = buildStrategyComparison("adaptive-momentum", [])
    .find(({ id }) => id === "daily-turtle-55-20");

  assert.ok(turtle);
  assert.equal(turtle.status, "RESEARCH");
  assert.equal(turtle.switchable, false);
  assert.equal(turtle.direction, "LONG_ONLY");
  assert.equal(turtle.family, "TREND_MOMENTUM");
  assert.equal(turtle.horizon, "SWING");
  assert.equal(turtle.timeframe, "DAILY_SIGNAL_REGULAR_SESSION_EXECUTION");
  assert.equal(turtle.validationStatus, "LOCAL_BACKTEST_INSUFFICIENT_SAMPLE");
  assert.ok(turtle.backtestData.includes("Yahoo Finance 日线"));
  assert.ok(turtle.sources.length >= 1);
});

test("registers weekly ETF rotation as a non-switchable Paper strategy", () => {
  const rotation = buildStrategyComparison("adaptive-momentum", [])
    .find(({ id }) => id === "weekly-etf-momentum-rsi-rotation");

  assert.ok(rotation);
  assert.equal(rotation.status, "RESEARCH");
  assert.equal(rotation.switchable, false);
  assert.equal(rotation.direction, "LONG_ONLY");
  assert.equal(rotation.family, "TREND_MOMENTUM");
  assert.equal(rotation.horizon, "SWING");
  assert.equal(rotation.timeframe, "WEEKLY_SIGNAL_REGULAR_SESSION_EXECUTION");
  assert.equal(rotation.validationStatus, "PAPER_TRACKING");
  assert.ok(rotation.backtestData.includes("Yahoo Finance"));
});

test("classifies every strategy by family, horizon, stage, and primary risk", () => {
  const comparison = buildStrategyComparison("adaptive-momentum", []);

  for (const strategy of comparison) {
    for (const dimension of ["family", "horizon", "stage", "riskCluster"]) {
      assert.equal(typeof strategy.classification[dimension].id, "string");
      assert.equal(typeof strategy.classification[dimension].label, "string");
      assert.equal(
        strategy.classification[dimension].label,
        STRATEGY_TAXONOMY[dimension][strategy.classification[dimension].id]
      );
    }
    assert.equal(strategy.classification.stage.id, strategy.status);
  }

  const momentum = comparison.find(({ id }) => id === "adaptive-momentum");
  assert.equal(momentum.classification.family.id, "TREND_MOMENTUM");
  assert.equal(momentum.classification.horizon.id, "FIFTEEN_MINUTE");
  assert.equal(momentum.classification.riskCluster.id, "CHASE_REVERSAL");

  const basis = comparison.find(({ id }) => id === "executable-basis-reversion");
  assert.equal(basis.classification.family.id, "STRUCTURAL_BASIS");
  assert.equal(basis.classification.riskCluster.id, "LIQUIDITY_QUOTE");

  const rsi2 = comparison.find(({ id }) => id === "daily-rsi2-trend-reversion");
  assert.equal(rsi2.classification.family.id, "MEAN_REVERSION");
  assert.equal(rsi2.classification.horizon.id, "MULTI_SESSION");
  assert.equal(rsi2.classification.stage.id, "RESEARCH");
});
