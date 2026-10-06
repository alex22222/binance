import assert from "node:assert/strict";
import test from "node:test";
import { btcRadarHtml } from "../src/btc-radar-html.mjs";
import { dcaScenario, ladderProbability } from "../src/btc-radar-risk.mjs";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const position = { avg: 100, sz_btc: 1, liq: 90, lever: 10, ladder: { ctVal: 0.01, pending: [[98, 50], [96, 50]] } };

test("fills every safety order above the stop before taking the loss", () => {
  const all = dcaScenario({ position, price: 102, stop: 95, takeProfit: 104, capitalUsdt: 100, takerFee: 0, maintenanceMargin: 0 });
  assert.equal(all.fills, 2);
  assert.equal(all.worstSize, 2);
  assert.equal(all.worstAverage, 98.5);
  assert.equal(all.lossAtStop, 7);
  assert.equal(all.profitAtTarget, 4);
  assert.equal(all.lossShare, 0.07);
  assert.equal(all.profitShare, 0.04);
  assert.equal(all.breakevenWinRate, 7 / 11);
  close(all.worstLiquidation, 88.65);
  close(all.stopAboveLiquidation, 95 / 88.65 - 1);
  close(all.stopDistance, 95 / 102 - 1);
  close(all.targetFromAverage, 0.04);

  const partial = dcaScenario({ position, price: 102, stop: 97, takeProfit: 104, takerFee: 0, maintenanceMargin: 0 });
  assert.equal(partial.fills, 1);
  assert.equal(partial.worstSize, 1.5);
  close(partial.lossAtStop, 3.5);
  assert.equal(partial.lossShare, null);

  const withFees = dcaScenario({ position, price: 102, stop: 95, takeProfit: 104 });
  close(withFees.lossAtStop, 7 + 2 * 95 * 0.0005);
  close(withFees.profitAtTarget, 4 - 104 * 0.0005);
});

test("reports an unbounded loss when there is no stop", () => {
  const noStop = dcaScenario({ position, price: 102, stop: 0, takeProfit: 104, capitalUsdt: 100 });
  assert.equal(noStop.stop, null);
  assert.equal(noStop.lossAtStop, null);
  assert.equal(noStop.lossShare, null);
  assert.equal(noStop.fills, 2);
  assert.equal(noStop.breakevenWinRate, null);
});

test("interpolates and clamps Polymarket probability ladders", () => {
  const ladder = { 80000: 0.2, 76000: 0.05 };
  close(ladderProbability(ladder, 78000), 0.125);
  assert.equal(ladderProbability(ladder, 70000), 0.05);
  assert.equal(ladderProbability(ladder, 90000), 0.2);
  assert.equal(ladderProbability({}, 78000), null);
  assert.equal(ladderProbability(ladder, Number.NaN), null);
});

test("the radar page embeds exactly the functions tested here", () => {
  const html = btcRadarHtml({ nonce: "n" });
  assert.ok(html.includes(dcaScenario.toString()));
  assert.ok(html.includes(ladderProbability.toString()));
});
