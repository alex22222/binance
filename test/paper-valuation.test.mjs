import assert from "node:assert/strict";
import test from "node:test";
import { paperExitValuation } from "../src/paper-valuation.mjs";

test("legacy weekly marks include the pending sell cost without rewriting saved equity or trades", () => {
  const state = { initialCapitalUsdt: 50, equityUsdt: 49.75, trades: [{ pnlUsdt: 1 }],
    position: { quantity: 0.4975, markPrice: 100, entryCapitalUsdt: 50, entryCostUsdt: 0.25 } };
  const before = JSON.stringify(state), value = paperExitValuation(state);
  assert.ok(Math.abs(value.hypotheticalExitNetPnlUsdt + 0.49875) < 1e-9);
  assert.ok(Math.abs(value.liquidationEquityUsdt - 49.50125) < 1e-9);
  assert.equal(JSON.stringify(state), before);
});
test("Turtle already reserves a full round trip; never deduct the sell cost twice", () => {
  const value = paperExitValuation({ position: { quantity: 0.5, markPrice: 101, notionalUsdt: 50, grossReturnPct: 1, netReturnPct: 0, unrealizedPnlUsdt: 0 } });
  assert.equal(value.hypotheticalExitNetPnlUsdt, 0);
  assert.equal(value.costModel, "LEGACY_FLAT_NOTIONAL_ROUND_TRIP");
  assert.equal(value.liquidationEquityUsdt, null);
});
test("unknown price or cost is unknown, not zero", () => {
  assert.equal(paperExitValuation({ position: { markPrice: 100, quantity: 0.5, entryCapitalUsdt: 50 } }).hypotheticalExitNetPnlUsdt, null);
});
