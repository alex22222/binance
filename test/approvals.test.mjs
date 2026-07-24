import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  approvalDecisionStatus,
  createApprovalRequest,
  loadApprovalDecision,
  recordApprovalDecision
} from "../src/approvals.mjs";

const order = {
  side: "BUY",
  symbol: "NVDA",
  address: "0x1111111111111111111111111111111111111111",
  fromToken: "0x55d398326f99059fF775485246999027B3197955",
  toToken: "0x1111111111111111111111111111111111111111",
  fromTokenQty: "50",
  expectedOutputQty: "0.42",
  quoteTimestamp: "2026-07-24T13:00:00.000Z",
  audit: {
    status: "OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED"
  }
};

test("creates a time-limited approval bound to the exact trade", () => {
  const request = createApprovalRequest(order, {
    createdAt: "2026-07-24T13:00:00.000Z",
    ttlSeconds: 300
  });

  assert.match(request.approvalId, /^[a-f0-9]{24}$/);
  assert.equal(request.status, "PENDING_CONFIRMATION");
  assert.equal(request.expiresAt, "2026-07-24T13:05:00.000Z");
  assert.equal(request.address, order.address);
  assert.equal(request.fromToken, order.fromToken);
  assert.equal(request.toToken, order.toToken);
  assert.equal(request.fromTokenQty, "50");
  assert.equal(request.dyorRequired, true);
});

test("accepts only a fresh, matching, explicit DYOR approval", () => {
  const request = createApprovalRequest(order, {
    createdAt: "2026-07-24T13:00:00.000Z",
    ttlSeconds: 300
  });
  const approved = {
    approvalId: request.approvalId,
    decision: "APPROVE",
    dyorAcknowledged: true,
    decidedAt: "2026-07-24T13:01:00.000Z"
  };

  assert.equal(approvalDecisionStatus(request, null, Date.parse("2026-07-24T13:01:00.000Z")).status, "WAITING");
  assert.equal(approvalDecisionStatus(request, approved, Date.parse("2026-07-24T13:01:01.000Z")).status, "APPROVED");
  assert.equal(approvalDecisionStatus(request, { ...approved, dyorAcknowledged: false }, Date.parse("2026-07-24T13:01:01.000Z")).status, "INVALID");
  assert.equal(approvalDecisionStatus(request, { ...approved, approvalId: "aaaaaaaaaaaaaaaaaaaaaaaa" }, Date.parse("2026-07-24T13:01:01.000Z")).status, "INVALID");
  assert.equal(approvalDecisionStatus(request, approved, Date.parse("2026-07-24T13:05:01.000Z")).status, "EXPIRED");
});

test("records an approval decision once and refuses replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-approval-"));
  const request = createApprovalRequest(order, {
    createdAt: "2026-07-24T13:00:00.000Z",
    ttlSeconds: 300
  });
  const decision = {
    approvalId: request.approvalId,
    decision: "APPROVE",
    dyorAcknowledged: true,
    decidedAt: "2026-07-24T13:01:00.000Z"
  };

  await recordApprovalDecision(directory, request, decision);
  assert.deepEqual(await loadApprovalDecision(directory, request.approvalId), decision);
  await assert.rejects(
    () => recordApprovalDecision(directory, request, { ...decision, decision: "REJECT" }),
    /already recorded/i
  );
});
