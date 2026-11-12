import assert from "node:assert/strict";
import test from "node:test";
import { cycleWorkItem } from "../src/cycle-plan.mjs";

test("a cycle finishes a pending order before approvals, exits, or a new entry", () => {
  assert.equal(cycleWorkItem({ pendingOrder: { intentId: "a" }, approvalRequest: { approvalId: "b" } }), "pending-order");
  assert.equal(cycleWorkItem({ approvalRequest: { approvalId: "b" } }), "approval");
  assert.equal(cycleWorkItem({}), "positions-then-entry");
  assert.equal(cycleWorkItem(null), "positions-then-entry");
});
