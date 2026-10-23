import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateBtcRadar, evaluateRadarPosition } from "../src/btc-radar-model.mjs";
import { priceLadder, selectWeeklyEvent } from "../src/btc-radar-sources.mjs";
import * as risk from "../src/btc-radar-risk.mjs";
import { btcRadarAlertReasons } from "../src/btc-radar.mjs";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const HOUR = 3_600_000;
const market = (yes, extra = {}) => ({ question: "Will Bitcoin reach $84,000 October 19-25?", outcomes: ["Yes", "No"], outcomePrices: [yes, 1 - yes], ...extra });

test("resolved, inactive, expired and ambiguous contracts cannot override a live quote", () => {
  const live = market(0.165, { active: true, closed: false, createdAt: "2026-10-22T00:00:00Z" });
  const ladder = priceLadder([
    market(1, { closed: true }), live,
    market(0.9, { active: false }), market(0.8, { endDate: "2026-10-22T00:00:00Z" }),
    market(0.6, { createdAt: "2026-10-21T00:00:00Z" }),
    market(0.1, { question: "Will Bitcoin dip to $78,000 October 19-25?" })
  ], NOW);
  assert.equal(ladder.reaches[84000], 0.165);
  assert.deepEqual(priceLadder([market(0.3), market(0.7)], NOW).reaches, {}, "unknown duplicate windows are not merged");
  assert.deepEqual(priceLadder([market(1, { closed: true })], NOW), { dips: {}, reaches: {} });
});

test("future weekly windows are not selected as the current week", () => {
  assert.equal(selectWeeklyEvent([{ title: "What price will Bitcoin hit October 26-November 1?", endDate: "2026-11-02T05:00:00Z" }], NOW), null);
});

test("calendar touch quotes neither predict stop/target probabilities nor affect the pressure score", async () => {
  const input = JSON.parse(await readFile(new URL("./fixtures/btc-radar/model-input-a.json", import.meta.url), "utf8"));
  const first = evaluateBtcRadar(input);
  const second = evaluateBtcRadar({ ...input, poly_week: { dips: {}, reaches: { 84000: 1 } }, poly_month: null });
  assert.equal(first.score, second.score);
  assert.equal(first.modelVersion, "pressure-v2-no-touch-probability");
  assert.equal(first.factors.find(f => f.key === "poly").score, null);
  assert.equal(first.factors.find(f => f.key === "poly").weight, 0);
  assert.equal(first.position.p_sl_week, null);
  assert.equal(first.position.p_tp_week, null);
  assert.doesNotMatch(JSON.stringify(first.factors.find(f => f.key === "poly")), /本周跌 4%|本周涨 4%|上涨概率/);
});

test("liquidation before stop is red for both directions and the alert explains the actual risk", () => {
  for (const [direction, sl, liq] of [["long", 90, 95], ["short", 110, 105], ["long", 95, 95]]) {
    const held = evaluateRadarPosition({ source: "account", direction, sl, liq, mark_price: 100, last_price: 100 }, 100, {});
    assert.equal(held.level, "red");
    assert.equal(held.risk_reason, "LIQUIDATION_BEFORE_STOP");
    assert.match(held.level_name, /强平/);
    assert.ok(btcRadarAlertReasons(null, { positions: [held] }).some(reason => /强平/.test(reason)));
  }
});

test("near liquidation is high risk even without a stop; unknown or stale positions are never safe", () => {
  const held = (extra) => evaluateRadarPosition({ source: "account", direction: "long", sl: 90, liq: 80, mark_price: 100, last_price: 100, ...extra }, 100, {});
  assert.equal(held({ liq: 98, sl: null }).level, "red");
  assert.notEqual(held({ liq: null }).level, "green");
  assert.notEqual(held({ stale: true }).level, "green");
  assert.doesNotMatch(held({}).level_name, /安全/);
});

test("freshness expires the oldest scored input, not merely the newly stamped snapshot", () => {
  const ts = new Date(NOW).toISOString();
  const old = new Date(NOW - 6 * HOUR).toISOString();
  assert.equal(risk.btcRadarFreshness({ ts }, NOW).expired, false);
  assert.equal(risk.btcRadarFreshness({ ts }, NOW + 5 * HOUR + 1).expired, true);
  const stale = risk.btcRadarFreshness({ ts, data_status: { sourceFetchedAt: { treasury: old } } }, NOW);
  assert.equal(stale.expired, true);
  assert.ok(stale.expiredSources.includes("treasury"));
  assert.equal(risk.btcRadarFreshness({ ts: "invalid" }, NOW).expired, true);
});

test("a model upgrade is not announced as worsening market conditions", () => {
  assert.deepEqual(btcRadarAlertReasons({ modelVersion: "old", level: "green" }, { modelVersion: "pressure-v2-no-touch-probability", level: "orange" }), []);
});
