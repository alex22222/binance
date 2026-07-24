import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDashboardSnapshot } from "../src/dashboard.mjs";
import { liveDashboardHtml } from "../src/live-dashboard-html.mjs";
import { activateEmergencyStop, clearEmergencyStop } from "../src/reliability.mjs";
import { createTracer } from "../src/trace.mjs";
import { approvalDecisionStatus, recordApprovalDecision } from "../src/approvals.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = resolve(projectRoot, process.env.BOT_CONFIG || "config.json");
const host = "127.0.0.1";
const port = Number(process.env.DASHBOARD_PORT || 4173);

async function loadConfig() {
  return JSON.parse(await readFile(configPath, "utf8"));
}

async function stopBot(config, reason) {
  await activateEmergencyStop(resolve(projectRoot, config.emergencyStopFile), {
    reason,
    requestedBy: "dashboard"
  });
  try {
    const pid = Number((await readFile(resolve(projectRoot, config.processLockFile), "utf8")).trim());
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
  }
}

async function traceOperatorAction(config, event, status, details) {
  const trace = createTracer(resolve(projectRoot, config.traceFile), { runId: randomUUID() });
  await trace(event, status, details);
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_024) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function requireLocalOrigin(request) {
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}:${port}`) throw new Error("Cross-origin request rejected");
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(liveDashboardHtml());
      return;
    }
    if (request.method === "GET" && request.url === "/api/snapshot") {
      const config = await loadConfig();
      const snapshot = await loadDashboardSnapshot({
        configPath,
        statePath: resolve(projectRoot, config.stateFile),
        tracePath: resolve(projectRoot, config.traceFile),
        emergencyStopPath: resolve(projectRoot, config.emergencyStopFile)
      });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(JSON.stringify(snapshot));
      return;
    }
    if (request.method === "POST" && request.url === "/api/emergency-stop") {
      requireLocalOrigin(request);
      const config = await loadConfig();
      await stopBot(config, "dashboard_operator");
      await traceOperatorAction(config, "emergency_stop", "activated", {
        reason: "dashboard_operator",
        requestedBy: "dashboard"
      });
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ success: true, emergencyStop: true }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/emergency-resume") {
      requireLocalOrigin(request);
      const body = await readJsonBody(request);
      if (body.confirm !== "RESUME") {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ success: false, error: "Explicit RESUME confirmation required" }));
        return;
      }
      const config = await loadConfig();
      await clearEmergencyStop(
        resolve(projectRoot, config.emergencyStopFile),
        resolve(projectRoot, config.emergencyStopHistoryDirectory || "state/emergency-stop-history")
      );
      await traceOperatorAction(config, "emergency_stop", "cleared", {
        requestedBy: "dashboard",
        botRestarted: false
      });
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ success: true, emergencyStop: false, botRestarted: false }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/approval-decision") {
      requireLocalOrigin(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        response.writeHead(415, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ success: false, error: "JSON request required" }));
        return;
      }
      const body = await readJsonBody(request);
      const config = await loadConfig();
      const state = JSON.parse(await readFile(resolve(projectRoot, config.stateFile), "utf8"));
      const approval = state.approvalRequest;
      if (!approval || body.approvalId !== approval.approvalId) {
        response.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ success: false, error: "Approval request is no longer current" }));
        return;
      }
      const expectedConfirmation = `${body.decision}:${approval.approvalId}`;
      if (!["APPROVE", "REJECT"].includes(body.decision) || body.confirmation !== expectedConfirmation) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ success: false, error: "Exact trade confirmation required" }));
        return;
      }
      const auditUnavailable = approval.audit?.status === "OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED";
      if (body.decision === "APPROVE" && auditUnavailable && body.auditUnavailableAcknowledged !== true) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ success: false, error: "Explicit acknowledgment of unavailable security audit required" }));
        return;
      }
      const decision = {
        approvalId: approval.approvalId,
        decision: body.decision,
        dyorAcknowledged: body.decision === "APPROVE" && body.dyorAcknowledged === true,
        auditUnavailableAcknowledged: body.decision === "APPROVE" && auditUnavailable && body.auditUnavailableAcknowledged === true,
        decidedAt: new Date().toISOString()
      };
      const outcome = approvalDecisionStatus(approval, decision);
      if (!["APPROVED", "REJECTED"].includes(outcome.status)) {
        response.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ success: false, error: `Approval is ${outcome.status}` }));
        return;
      }
      await recordApprovalDecision(
        resolve(projectRoot, config.approvalDecisionDirectory),
        approval,
        decision
      );
      await traceOperatorAction(config, "trade_approval", body.decision === "APPROVE" ? "approved" : "rejected", {
        approvalId: approval.approvalId,
        side: approval.side,
        symbol: approval.symbol,
        address: approval.address,
        requestedBy: "dashboard",
        dyorAcknowledged: decision.dyorAcknowledged,
        auditUnavailableAcknowledged: decision.auditUnavailableAcknowledged
      });
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({
        success: true,
        approvalId: approval.approvalId,
        decision: body.decision,
        status: body.decision === "APPROVE" ? "APPROVED_PENDING_REVALIDATION" : "REJECTED"
      }));
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, host, () => {
  console.log(`Agentic Wallet dashboard: http://${host}:${port}`);
});
