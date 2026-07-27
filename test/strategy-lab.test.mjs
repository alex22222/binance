import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  basisExitReached,
  buildStrategyComparison,
  executableBasisDecision,
  readStrategyControl,
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

test("attaches the same non-enforcing shadow downtrend veto to every strategy", () => {
  const comparison = buildStrategyComparison("adaptive-momentum", []);

  assert.equal(comparison.length, 4);
  for (const strategy of comparison) {
    assert.equal(strategy.subStrategies.length, 1);
    assert.equal(strategy.subStrategies[0].id, "shadow-downtrend-veto");
    assert.equal(strategy.subStrategies[0].mode, "SHADOW");
    assert.equal(strategy.subStrategies[0].enforced, false);
    assert.ok(strategy.subStrategies[0].role.length > 0);
  }
});
