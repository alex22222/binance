import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildBawEnvironment } from "../src/baw-runtime.mjs";
import { loadDashboardSnapshot } from "../src/dashboard.mjs";
import { liveDashboardHtml } from "../src/live-dashboard-html.mjs";
import { dashboardLoginHtml } from "../src/dashboard-login-html.mjs";
import { strategyLabHtml } from "../src/strategy-lab-html.mjs";
import { activateEmergencyStop, clearEmergencyStop } from "../src/reliability.mjs";
import { createTracer } from "../src/trace.mjs";
import { approvalDecisionStatus, recordApprovalDecision } from "../src/approvals.mjs";
import { readApprovalControl, writeApprovalControl } from "../src/approval-control.mjs";
import { assertSwitchableStrategy, writeStrategyControl } from "../src/strategy-lab.mjs";
import { createWalletLoginManager } from "../src/wallet-login.mjs";
import {
  dashboardAllowedOrigins,
  dashboardAuthConfig,
  dashboardCredentialsAuthorized,
  dashboardSessionCookie,
  dashboardRequestAuthorized
} from "../src/dashboard-auth.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const faviconPath = resolve(projectRoot, "assets/binance-favicon.svg");
const configPath = resolve(projectRoot, process.env.BOT_CONFIG || "config.json");
const host = "127.0.0.1";
const port = Number(process.env.DASHBOARD_PORT || 4173);
const authConfig = dashboardAuthConfig();
const allowedOrigins = dashboardAllowedOrigins({ host, port });
const execFileAsync = promisify(execFile);

async function executeBaw(args) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      process.env.BAW_CLI_PATH || "baw",
      [...args, "--json"],
      {
        env: buildBawEnvironment({
          environment: process.env,
          instanceId: process.env.BINANCE_INSTANCE_ID
        }),
        maxBuffer: 1024 * 1024,
        timeout: args[1] === "verify" ? 310_000 : 30_000
      }
    ));
  } catch (error) {
    stdout = error.stdout;
    if (!stdout) throw error;
  }
  const result = JSON.parse(stdout);
  if (!result.success) throw new Error(result.error?.message || "Wallet login failed");
  return result.data;
}

const walletLogin = createWalletLoginManager({ executeBaw });

async function loadConfig() {
  return JSON.parse(await readFile(configPath, "utf8"));
}

function approvalControlPath(config) {
  return resolve(dirname(resolve(projectRoot, config.stateFile)), "approval-control.json");
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

async function readFormBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4_096) throw new Error("Request body too large");
  }
  return new URLSearchParams(body);
}

function requireAllowedOrigin(request) {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin.replace(/\/$/, ""))) {
    const error = new Error("Cross-origin request rejected");
    error.statusCode = 403;
    throw error;
  }
}

function requireAuthentication(request, response) {
  if (dashboardRequestAuthorized(request, authConfig)) return true;
  if (request.method === "GET" && ["/", "/strategies"].includes(request.url)) {
    response.writeHead(303, {
      "Location": "/login",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end();
    return false;
  }
  response.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "WWW-Authenticate": 'Basic realm="Agentic Wallet Dashboard", charset="UTF-8"',
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify({ error: "Authentication required" }));
  return false;
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/favicon.svg") {
      response.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(await readFile(faviconPath));
      return;
    }
    if (request.method === "GET" && request.url === "/login") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(dashboardLoginHtml());
      return;
    }
    if (request.method === "POST" && request.url === "/login") {
      if (!String(request.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) {
        response.writeHead(415, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end("Form submission required");
        return;
      }
      const body = await readFormBody(request);
      if (!dashboardCredentialsAuthorized(body.get("username"), body.get("password"), authConfig)) {
        response.writeHead(401, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(dashboardLoginHtml({ invalid: true }));
        return;
      }
      response.writeHead(303, {
        "Location": "/",
        "Set-Cookie": dashboardSessionCookie(authConfig),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end();
      return;
    }
    if (!requireAuthentication(request, response)) return;
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(liveDashboardHtml());
      return;
    }
    if (request.method === "GET" && request.url === "/strategies") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(strategyLabHtml());
      return;
    }
    if (request.method === "GET" && request.url === "/api/snapshot") {
      const config = await loadConfig();
      const snapshot = await loadDashboardSnapshot({
        configPath,
        statePath: resolve(projectRoot, config.stateFile),
        tracePath: resolve(projectRoot, config.traceFile),
        signalHistoryPath: resolve(projectRoot, "state/dashboard-signal-history.jsonl"),
        approvalControlPath: approvalControlPath(config),
        emergencyStopPath: resolve(projectRoot, config.emergencyStopFile),
        strategyControlPath: resolve(projectRoot, config.strategyControlFile)
      });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(JSON.stringify(snapshot));
      return;
    }
    if (request.method === "GET" && request.url === "/api/strategy-validation") {
      const report = await readFile(resolve(projectRoot, "state/strategy-validation/latest.json"), "utf8")
        .then(JSON.parse)
        .catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(JSON.stringify(report ? { available: true, ...report } : { available: false }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/auto-approval") {
      requireAllowedOrigin(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        response.writeHead(415, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ error: "JSON request required" }));
        return;
      }
      const body = await readJsonBody(request);
      const expected = body.enabled === true ? "ENABLE_AUTO_APPROVAL" : "DISABLE_AUTO_APPROVAL";
      if (typeof body.enabled !== "boolean" || body.confirmation !== expected) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ error: "Exact automatic approval confirmation required" }));
        return;
      }
      const control = await writeApprovalControl(
        approvalControlPath(await loadConfig()),
        body.enabled
      );
      const config = await loadConfig();
      await traceOperatorAction(config, "auto_approval", body.enabled ? "enabled" : "disabled", {
        requestedBy: "dashboard",
        appliesTo: "future_approvals"
      });
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(control));
      return;
    }
    if (request.method === "POST" && request.url === "/api/wallet-login/start") {
      requireAllowedOrigin(request);
      const config = await loadConfig();
      const state = JSON.parse(await readFile(resolve(projectRoot, config.stateFile), "utf8"));
      if (state.walletSession?.status !== "EXPIRED") {
        response.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ error: "Wallet login is available only after a confirmed disconnect" }));
        return;
      }
      const login = await walletLogin.start();
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(login));
      return;
    }
    if (request.method === "GET" && request.url === "/api/wallet-login/status") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(walletLogin.status()));
      return;
    }
    if (request.method === "POST" && request.url === "/api/strategy") {
      requireAllowedOrigin(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        response.writeHead(415, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ success: false, error: "JSON request required" }));
        return;
      }
      const body = await readJsonBody(request);
      const config = await loadConfig();
      const strategy = assertSwitchableStrategy(body.strategyId);
      const control = await writeStrategyControl(
        resolve(projectRoot, config.strategyControlFile),
        strategy.id
      );
      await traceOperatorAction(config, "strategy_switch", "succeeded", {
        strategyId: strategy.id,
        requestedBy: "dashboard",
        appliesTo: "next_entry"
      });
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ success: true, strategy: control, appliesTo: "next_entry" }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/emergency-stop") {
      requireAllowedOrigin(request);
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
      requireAllowedOrigin(request);
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
      requireAllowedOrigin(request);
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        response.writeHead(415, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ success: false, error: "JSON request required" }));
        return;
      }
      const body = await readJsonBody(request);
      const config = await loadConfig();
      const approvalControl = await readApprovalControl(approvalControlPath(config));
      if (approvalControl.enabled) {
        response.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({
          success: false,
          error: "Manual decisions are disabled while automatic approval is enabled"
        }));
        return;
      }
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
    response.writeHead(error.statusCode || 500, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, host, () => {
  console.log(`Agentic Wallet dashboard: http://${host}:${port}`);
});
