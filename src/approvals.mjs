import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const approvalIdPattern = /^[a-f0-9]{24}$/;
const decisions = new Set(["APPROVE", "REJECT"]);

function approvalPath(directory, approvalId) {
  if (!approvalIdPattern.test(String(approvalId))) throw new Error("Invalid approval ID");
  return join(directory, `${approvalId}.json`);
}

export function createApprovalRequest(order, {
  createdAt = new Date().toISOString(),
  ttlSeconds
} = {}) {
  const expiresAtMs = Date.parse(createdAt) + Number(ttlSeconds) * 1000;
  if (!Number.isFinite(expiresAtMs)) throw new Error("Invalid approval expiry");
  if (!["BUY", "SELL"].includes(order.side)) throw new Error("Approval side must be BUY or SELL");
  const normalized = {
    side: order.side,
    symbol: order.symbol,
    address: order.address,
    fromToken: order.fromToken,
    toToken: order.toToken,
    fromTokenQty: String(order.fromTokenQty),
    createdAt
  };
  const approvalId = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 24);
  return {
    ...order,
    ...normalized,
    approvalId,
    status: "PENDING_CONFIRMATION",
    createdAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    dyorRequired: true
  };
}

export function approvalDecisionStatus(request, decision, nowMs = Date.now()) {
  if (!request) return { status: "NONE" };
  const expiresAtMs = Date.parse(request.expiresAt || "");
  if (!Number.isFinite(expiresAtMs) || nowMs > expiresAtMs) return { status: "EXPIRED" };
  if (!decision) return { status: "WAITING" };
  if (
    decision.approvalId !== request.approvalId ||
    !decisions.has(decision.decision) ||
    !Number.isFinite(Date.parse(decision.decidedAt || "")) ||
    Date.parse(decision.decidedAt) > expiresAtMs
  ) {
    return { status: "INVALID" };
  }
  if (decision.decision === "REJECT") return { status: "REJECTED" };
  if (decision.dyorAcknowledged !== true) return { status: "INVALID" };
  return { status: "APPROVED" };
}

export async function recordApprovalDecision(directory, request, decision) {
  const status = approvalDecisionStatus(request, decision, Date.parse(decision.decidedAt || ""));
  if (!["APPROVED", "REJECTED"].includes(status.status)) {
    throw new Error(`Invalid approval decision: ${status.status}`);
  }
  const path = approvalPath(directory, request.approvalId);
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(decision, null, 2)}\n`, "utf8");
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Approval decision already recorded");
    throw error;
  } finally {
    await handle?.close();
  }
  return path;
}

export async function loadApprovalDecision(directory, approvalId) {
  try {
    return JSON.parse(await readFile(approvalPath(directory, approvalId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
