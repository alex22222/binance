import assert from "node:assert/strict";
import test from "node:test";

import {
  loadWeeklyEtfDefensiveSignal,
  weeklyEtfLiveDecisionWindow,
  weeklyEtfLiveExitDecision
} from "../src/weekly-etf-live.mjs";

test("removed risk assets cannot be reused from an old cached Live decision", () => {
  const now = Date.parse("2026-10-12T14:00:00Z");
  assert.equal(weeklyEtfLiveDecisionWindow(now, { week: "2026-10-12", decision: { target: "VTI" } }).decisionUsable, false);
});

test("Live data collection and ranking require only QQQ, SPY and SGOV", async () => {
  const fetched = [];
  const dates = Array.from({ length: 30 }, (_, i) => Date.parse("2026-08-01") / 1000 + i * 86400);
  dates[29] = Date.parse("2026-09-18") / 1000;
  const { signal } = await loadWeeklyEtfDefensiveSignal("2026-09-21", { fetchImpl: async (url) => {
    fetched.push(new URL(url).pathname.split("/").at(-1));
    return { ok: true, json: async () => ({ chart: { result: [{ timestamp: dates,
      indicators: { adjclose: [{ adjclose: dates.map((_, i) => 100 + i) }] } }] } }) };
  } });
  assert.deepEqual(fetched.sort(), ["QQQ", "SGOV", "SPY"]);
  assert.deepEqual(signal.allRiskAssets.map(a => a.ticker), ["QQQ", "SPY"]);
});

test("creates a weekly decision only during the first NYSE session but can finish a cached rotation later", () => {
  const monday = Date.parse("2026-09-21T14:00:00.000Z");
  const tuesday = Date.parse("2026-09-22T14:00:00.000Z");
  const friday = Date.parse("2026-09-18T14:00:00.000Z");

  assert.equal(weeklyEtfLiveDecisionWindow(monday).canCreateDecision, true);
  assert.equal(weeklyEtfLiveDecisionWindow(friday).canCreateDecision, false);
  assert.equal(weeklyEtfLiveDecisionWindow(tuesday).decisionUsable, false);
  assert.equal(weeklyEtfLiveDecisionWindow(tuesday, {
    week: "2026-09-21",
    decision: { signalDate: "2026-09-18", target: "QQQ" }
  }).decisionUsable, true);
});

test("treats the Tuesday after Labor Day as the first NYSE session", () => {
  const holiday = weeklyEtfLiveDecisionWindow(Date.parse("2026-09-07T14:00:00.000Z"));
  const tuesday = weeklyEtfLiveDecisionWindow(Date.parse("2026-09-08T14:00:00.000Z"));

  assert.equal(holiday.canCreateDecision, false);
  assert.equal(tuesday.canCreateDecision, true);
});

test("weekly live exits only for disaster protection or a changed weekly target", () => {
  assert.deepEqual(weeklyEtfLiveExitDecision({
    positionSymbol: "QQQ",
    target: "QQQ",
    returnPct: 3,
    disasterStopLossPct: 8
  }), { type: null, target: "QQQ" });
  assert.deepEqual(weeklyEtfLiveExitDecision({
    positionSymbol: "QQQ",
    target: "SGOV",
    returnPct: -1,
    disasterStopLossPct: 8
  }), { type: "WEEKLY_REBALANCE", target: "SGOV" });
  assert.deepEqual(weeklyEtfLiveExitDecision({
    positionSymbol: "QQQ",
    target: "CASH",
    returnPct: -1,
    disasterStopLossPct: 8
  }), { type: "WEEKLY_TO_CASH", target: "CASH" });
  assert.deepEqual(weeklyEtfLiveExitDecision({
    positionSymbol: "QQQ",
    target: "QQQ",
    returnPct: -8,
    disasterStopLossPct: 8
  }), { type: "DISASTER_STOP", target: "QQQ" });
});
