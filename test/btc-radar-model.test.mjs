import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateBtcRadar, pyFixed, pyRound, pyRoundInt } from "../src/btc-radar-model.mjs";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/btc-radar/${name}.json`, import.meta.url), "utf8"));

test("reproduces btc_alert.py output byte for byte, including rounding ties", async () => {
  for (const name of ["a", "b"]) {
    const input = await fixture(`model-input-${name}`);
    const expected = await fixture(`model-expected-${name}`);
    assert.equal(JSON.stringify(evaluateBtcRadar(input)), JSON.stringify(expected), `fixture ${name}`);
  }
  const tie = evaluateBtcRadar(await fixture("model-input-b"));
  assert.deepEqual(tie.factors[0].metrics.slice(0, 2), [["本周跌 4%", "22%"], ["本周涨 4%", "34%"]]);
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

test("grades the position by distance to the stop and fails closed on an empty ladder", async () => {
  const input = await fixture("model-input-a");
  const near = evaluateBtcRadar({ ...input, position: { ...input.position, sl: input.price * 0.98 } });
  assert.equal(near.position.level, "red");
  assert.equal(near.position.level_name, "接近止损");
  const safe = evaluateBtcRadar({ ...input, position: { ...input.position, sl: input.price * 0.9 } });
  assert.equal(safe.position.level, "green");
  assert.equal(evaluateBtcRadar({ ...input, position: null }).position, null);
  assert.throws(
    () => evaluateBtcRadar({ ...input, poly_week: { ...input.poly_week, dips: {} } }),
    /Empty probability ladder/
  );
});
