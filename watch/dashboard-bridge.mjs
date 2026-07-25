function authorizationHeader(username, password) {
  if (!username && !password) return null;
  if (!username || !password) {
    throw new Error("Dashboard bridge username and password must be configured together");
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function normalizedAddress(value) {
  return String(value || "").toLowerCase();
}

export function approvalMatchesSignal(approval, signal) {
  if (!approval) return { matched: false, reason: "NO_APPROVAL" };
  if (approval.side !== signal.side) return { matched: false, reason: "SIDE_MISMATCH" };
  if (signal.symbol && approval.symbol !== signal.symbol) {
    return { matched: false, reason: "SYMBOL_MISMATCH" };
  }
  if (signal.address && normalizedAddress(approval.address) !== normalizedAddress(signal.address)) {
    return { matched: false, reason: "ADDRESS_MISMATCH" };
  }
  if (signal.approvalId && approval.approvalId !== signal.approvalId) {
    return { matched: false, reason: "APPROVAL_ID_MISMATCH" };
  }
  return { matched: true, reason: "MATCHED" };
}

export function approvalDecisionPayload(approval) {
  const auditUnavailable = approval.audit?.status === "OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED";
  return {
    approvalId: approval.approvalId,
    decision: "APPROVE",
    confirmation: `APPROVE:${approval.approvalId}`,
    dyorAcknowledged: true,
    auditUnavailableAcknowledged: auditUnavailable
  };
}

export async function approveSignalThroughDashboard({
  signal,
  dashboardUrl,
  username,
  password,
  fetchImpl = fetch
}) {
  const authorization = authorizationHeader(username, password);
  const headers = authorization ? { Authorization: authorization } : {};
  const baseUrl = dashboardUrl.replace(/\/$/, "");
  const snapshotResponse = await fetchImpl(`${baseUrl}/api/snapshot`, { headers });
  if (!snapshotResponse.ok) {
    throw new Error(`Dashboard snapshot failed: HTTP ${snapshotResponse.status}`);
  }
  const snapshot = await snapshotResponse.json();
  const match = approvalMatchesSignal(snapshot.approvalRequest, signal);
  if (!match.matched) return { status: "NOT_READY", reason: match.reason };

  const response = await fetchImpl(`${baseUrl}/api/approval-decision`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Origin: new URL(baseUrl).origin
    },
    body: JSON.stringify(approvalDecisionPayload(snapshot.approvalRequest))
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      status: "REJECTED",
      reason: body.error || `HTTP ${response.status}`,
      httpStatus: response.status
    };
  }
  return {
    status: "APPROVED",
    approvalId: snapshot.approvalRequest.approvalId,
    outcome: body.status
  };
}
