import assert from "node:assert/strict";
import test from "node:test";
import { rolloverRiskDay } from "../src/risk-day.mjs";

test("rolls daily risk at New York midnight while preserving live state", () => {
  const state = {
    date: "2026-08-19",
    realizedPnlUsdt: -1.25,
    realizedGrossPnlUsdt: -1.1,
    gasCostUsdt: 0.15,
    positions: [{ symbol: "NVDA", quantity: "1" }],
    pendingOrder: { orderId: "pending-1" },
    approvalRequest: { approvalId: "approval-1" },
    roundTripGasHistoryUsdt: [0.04],
    cooldownUntil: { NVDA: 123 },
    initialStopHistory: [{ symbol: "NVDA", nyseDate: "2026-08-19" }],
    shadowEntryHistory: [{ symbol: "NVDA", date: "2026-08-19" }]
  };

  const result = rolloverRiskDay(state, Date.parse("2026-08-20T04:00:00.000Z"));

  assert.equal(result.changed, true);
  assert.equal(result.previousDate, "2026-08-19");
  assert.equal(result.currentDate, "2026-08-20");
  assert.equal(state.date, "2026-08-20");
  assert.equal(state.realizedPnlUsdt, 0);
  assert.equal(state.realizedGrossPnlUsdt, 0);
  assert.equal(state.gasCostUsdt, 0);
  assert.deepEqual(state.positions, [{ symbol: "NVDA", quantity: "1" }]);
  assert.deepEqual(state.pendingOrder, { orderId: "pending-1" });
  assert.deepEqual(state.approvalRequest, { approvalId: "approval-1" });
  assert.deepEqual(state.roundTripGasHistoryUsdt, [0.04]);
  assert.deepEqual(state.cooldownUntil, { NVDA: 123 });
  assert.equal(state.initialStopHistory.length, 1);
  assert.equal(state.shadowEntryHistory.length, 1);
});

test("uses the New York date across daylight-saving offsets and does not reset twice", () => {
  const summer = {
    date: "2026-07-27",
    realizedPnlUsdt: -0.5,
    realizedGrossPnlUsdt: -0.4,
    gasCostUsdt: 0.1
  };
  const winter = {
    date: "2026-01-26",
    realizedPnlUsdt: -0.5,
    realizedGrossPnlUsdt: -0.4,
    gasCostUsdt: 0.1
  };

  assert.equal(
    rolloverRiskDay(summer, Date.parse("2026-07-28T03:59:59.000Z")).changed,
    false
  );
  assert.equal(
    rolloverRiskDay(summer, Date.parse("2026-07-28T04:00:00.000Z")).currentDate,
    "2026-07-28"
  );
  assert.equal(
    rolloverRiskDay(winter, Date.parse("2026-01-27T04:59:59.000Z")).changed,
    false
  );
  assert.equal(
    rolloverRiskDay(winter, Date.parse("2026-01-27T05:00:00.000Z")).currentDate,
    "2026-01-27"
  );
  assert.equal(rolloverRiskDay(winter, Date.parse("2026-01-27T05:01:00.000Z")).changed, false);
});
