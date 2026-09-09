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

test("persists only switchable strategies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "strategy-control-"));
  const path = join(directory, "control.json");
  await writeStrategyControl(path, "executable-basis-reversion");
  assert.equal((await readStrategyControl(path)).strategyId, "executable-basis-reversion");
  await assert.rejects(() => writeStrategyControl(path, "residual-reversal"), /not switchable/);
});

test("pauses only BUY execution and preserves the pause across strategy switches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "entry-pause-control-"));
  const path = join(directory, "control.json");

  await writeEntryPauseControl(path, true, "adaptive-momentum", "test");
  assert.equal((await readStrategyControl(path)).entriesPaused, true);
  assert.deepEqual(entryExecutionDecision({ entriesPaused: true, side: "BUY" }), {
    allowed: false,
    reason: "ENTRIES_PAUSED"
  });
  assert.deepEqual(entryExecutionDecision({ entriesPaused: true, side: "SELL" }), {
    allowed: true,
    reason: "EXIT_ALLOWED"
  });

  await writeStrategyControl(path, "executable-basis-reversion");
  const switched = await readStrategyControl(path);
  assert.equal(switched.strategyId, "executable-basis-reversion");
  assert.equal(switched.entriesPaused, true);

  await writeEntryPauseControl(path, false, "adaptive-momentum", "test");
  assert.equal((await readStrategyControl(path)).entriesPaused, false);
});

test("compares realized returns by strategy without inventing missing results", () => {
  const comparison = buildStrategyComparison("adaptive-momentum", [
    { event: "sell_submission", status: "simulated", details: { strategyId: "adaptive-momentum", realizedPnlUsdt: 2 } },
    { event: "sell_submission", status: "simulated", details: { strategyId: "adaptive-momentum", realizedPnlUsdt: -1 } }
  ]);
  const momentum = comparison.find((strategy) => strategy.id === "adaptive-momentum");
  const basis = comparison.find((strategy) => strategy.id === "executable-basis-reversion");
  assert.equal(momentum.performance.trades, 2);
  assert.equal(momentum.performance.realizedPnlUsdt, 1);
  assert.equal(momentum.performance.winRatePct, 50);
  assert.equal(basis.performance.trades, 0);
  assert.equal(basis.performance.winRatePct, null);
});

test("attaches the same non-enforcing shadow risk overlays to every strategy", () => {
  const comparison = buildStrategyComparison("adaptive-momentum", []);

  assert.equal(comparison.length, 10);
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
