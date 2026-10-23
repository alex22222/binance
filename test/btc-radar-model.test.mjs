import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateBtcRadar, pyFixed, pyRound, pyRoundInt } from "../src/btc-radar-model.mjs";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/btc-radar/${name}.json`, import.meta.url), "utf8"));

test("retains the five original factor formulas and normalizes without Polymarket", async () => {
  for (const name of ["a", "b"]) {
    const input = await fixture(`model-input-${name}`);
    const expected = await fixture(`model-expected-${name}`);
    const result = evaluateBtcRadar(input);
    assert.deepEqual(result.factors.slice(1), expected.factors.slice(1), `fixture ${name}`);
    const weighted = expected.factors.slice(1).reduce((sum, f) => sum + f.weight * f.score, 0) / 75;
    assert.equal(result.score, pyRound(weighted, 1));
  }
  const tie = evaluateBtcRadar(await fixture("model-input-b"));
  assert.equal(tie.factors[0].score, null);
});

test("rounds the exact binary value half to even like Python", () => {
  assert.equal(pyFixed(22.5, 0), "22");
  assert.equal(pyFixed(23.5, 0), "24");
  assert.equal(pyFixed(0.125, 2), "0.12");
  assert.equal(pyFixed(-0.04, 1, { sign: true }), "-0.0");
  assert.equal(pyFixed(0.04, 1, { sign: true }), "+0.0");
  assert.equal(pyFixed(4170.4, 0, { grouping: true }), "4,170");
  assert.equal(pyFixed(1234567.891, 2, { grouping: true }), "1,234,567.89");
  assert.equal(pyRoundInt(48.5), 48);
  assert.equal(pyRoundInt(49.5), 50);
  assert.ok(Object.is(pyRoundInt(-0.4), 0));
  assert.equal(pyRound(63.45, 1), 63.5);
  assert.equal(pyRound(2.675, 2), 2.67);
  assert.throws(() => pyFixed(Number.NaN, 1), /non-finite/);
});

test("scores unavailable sentiment as neutral and labels it instead of inventing ratios", async () => {
  const input = await fixture("model-input-a");
  const derivatives = (result) => result.factors.find(({ key }) => key === "deriv");
  const neutral = evaluateBtcRadar({ ...input, sentiment: { bull: 0.3, bear: 0 } });
  const missing = evaluateBtcRadar({ ...input, sentiment: null });
  assert.equal(derivatives(missing).score, derivatives(neutral).score);
  assert.deepEqual(derivatives(missing).metrics[2], ["舆情多 / 空", "未接入"]);
});

test("grades the position without depending on a prediction-market ladder", async () => {
  const input = await fixture("model-input-a");
  const near = evaluateBtcRadar({ ...input, position: { ...input.position, sl: input.price * 0.98 } });
  assert.equal(near.position.level, "red");
  assert.equal(near.position.level_name, "接近止损");
  const safe = evaluateBtcRadar({ ...input, position: { ...input.position, sl: input.price * 0.9 } });
  assert.equal(safe.position.level, "green");
  assert.equal(evaluateBtcRadar({ ...input, position: null }).position, null);
  assert.equal(evaluateBtcRadar({ ...input, poly_week: { dips: {}, reaches: {} } }).score, near.score);
});

test("short risk and touch probabilities follow the upward stop and downward target", async () => {
  const input = await fixture("model-input-a");
  const held = { ...input.position, direction: "short", sl: input.price * 1.1, tp: input.price * 0.96, liq: input.price * 1.2 };
  const result = evaluateBtcRadar({ ...input, position: held });
  assert.equal(result.position.level, "green");
  assert.equal(result.position.d_sl, 10);
  const expected = evaluateBtcRadar({ ...input, position: { ...held, direction: "long", sl: held.tp, tp: held.sl } });
  assert.equal(result.position.p_sl_week, expected.position.p_tp_week);
  assert.equal(result.position.p_tp_week, expected.position.p_sl_week);
  assert.equal(evaluateBtcRadar({ ...input, position: { ...held, sl: input.price * 1.02 } }).position.level, "red");
});
