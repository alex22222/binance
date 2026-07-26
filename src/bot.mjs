import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  analyzeCandles,
  auditDecision,
  calculateAtrPct,
  costCoverageDecision,
  dailyLossReached,
  dynamicExitDecision,
  entryMarketAllowed,
  entrySessionDecision,
  entryStatusCheckDecision,
  executionCostEstimate,
  initialRiskDecision,
  nyseSessionPlan,
  pendingOrderAction,
  rankCandidates,
  roundTripCostPct,
  simulateRoundTrip,
  uniqueSymbols,
  validateConfig
} from "./strategy.mjs";
import { createTracer } from "./trace.mjs";
import {
  createMarketDataRecorder,
  normalizeCandles
} from "./market-data-recorder.mjs";
import { retry } from "./retry.mjs";
import { buildBawEnvironment } from "./baw-runtime.mjs";
import {
  approvalDecisionStatus,
  createApprovalRequest,
  loadApprovalDecision,
  recordApprovalDecision
} from "./approvals.mjs";
import { readApprovalControl } from "./approval-control.mjs";
import { feishuMessageWithDashboardLink } from "./feishu-message.mjs";
import {
  BawError,
  acquireProcessLock,
  assertQuoteFresh,
  createOrderIntent,
  isTransientNetworkError,
  matchingOrdersForIntent,
  quoteDriftPct,
  readEmergencyStop,
  recoveryActionForPending,
  resolveWalletStatus,
  runtimeFailureUpdate,
  walletSessionStatusFromSettings
} from "./reliability.mjs";
import {
  basisExitReached,
  DEFAULT_STRATEGY_ID,
  executableBasisDecision,
  readStrategyControl
} from "./strategy-lab.mjs";

const execFileAsync = promisify(execFile);
const BSC_CHAIN_ID = "56";
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const API_BASE = "https://www.binance.com/bapi/defi";
const AUDIT_URL = "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit";
const once = process.argv.includes("--once");
const testFeishu = process.argv.includes("--test-feishu");
const mockTrade = process.argv.includes("--mock-trade");
const projectRoot = resolve(import.meta.dirname, "..");
const configPath = resolve(projectRoot, process.env.BOT_CONFIG || "config.json");
let feishuTokenCache = null;
let traceAction = async () => {};
let recordMarketData = async () => {};
let currentCycleId = null;
let shutdownRequested = false;
let wakeLoop = null;

function log(message, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, path);
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function freshState() {
  return {
    date: shanghaiDate(),
    realizedPnlUsdt: 0,
    position: null,
    pendingOrder: null,
    approvalRequest: null,
    cooldownUntil: {},
    lastEntryDecisionAt: 0,
    lastMarketStatusCheckAt: 0,
    lastMarketSession: null,
    pendingNotifications: [],
    updatedAt: null,
    lastError: null,
    lastSettingsCheckAt: 0,
    sessionWarningFor: null
  };
}

async function loadState(path) {
  try {
    const state = await loadJson(path);
    if (state.date === shanghaiDate()) return state;
    return {
      ...freshState(),
      position: state.position,
      pendingOrder: state.pendingOrder,
      approvalRequest: state.approvalRequest
    };
  } catch (error) {
    if (error.code === "ENOENT") return freshState();
    throw error;
  }
}

async function fetchJson(url, options = {}) {
  const endpoint = new URL(url).pathname;
  await traceAction("external_api_call", "started", { endpoint, method: options.method || "GET" }, currentCycleId);
  try {
    const body = await retry(async () => {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent": "binance-web3-stock-bot/1.0",
          ...options.headers
        }
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${endpoint}`);
        error.status = response.status;
        throw error;
      }
      const result = await response.json();
      if (result.success !== true) throw new Error(result.message || result.messageDetail || `API error ${result.code}`);
      return result;
    }, {
      attempts: 3,
      delayMs: 500,
      shouldRetry: isTransientNetworkError,
      onRetry: async (error, attempt, nextAttempt) => {
        await traceAction("external_api_retry", "scheduled", {
          endpoint,
          attempt,
          nextAttempt,
          error: error.message
        }, currentCycleId);
      }
    });
    await traceAction("external_api_call", "succeeded", { endpoint, method: options.method || "GET" }, currentCycleId);
    return body.data;
  } catch (error) {
    await traceAction("external_api_call", "failed", { endpoint, method: options.method || "GET", error: error.message }, currentCycleId);
    throw error;
  }
}

function bawResultFromOutput(output, operation) {
  const result = JSON.parse(String(output));
  if (!result.success) {
    throw new BawError({
      code: result.error?.code,
      name: result.error?.name,
      message: result.error?.message,
      operation
    });
  }
  return result.data;
}

async function executeBaw(args, operation) {
  try {
    const { stdout } = await execFileAsync(process.env.BAW_CLI_PATH || "baw", [...args, "--json"], {
      env: buildBawEnvironment({
        environment: process.env,
        instanceId: process.env.BINANCE_INSTANCE_ID
      }),
      maxBuffer: 1024 * 1024
    });
    return bawResultFromOutput(stdout, operation);
  } catch (error) {
    if (error instanceof BawError) throw error;
    if (error.stdout) {
      try {
        return bawResultFromOutput(error.stdout, operation);
      } catch (parseError) {
        if (parseError instanceof BawError) throw parseError;
      }
    }
    throw error;
  }
}

async function baw(args, { stateChanging = false } = {}) {
  const operation = args.slice(0, 2).join(" ");
  await traceAction("wallet_cli", "started", { operation }, currentCycleId);
  try {
    const data = await retry(
      () => executeBaw(args, operation),
      {
        attempts: stateChanging ? 1 : 3,
        delayMs: 500,
        shouldRetry: isTransientNetworkError,
        onRetry: async (error, attempt, nextAttempt) => {
          await traceAction("wallet_cli_retry", "scheduled", {
            operation,
            attempt,
            nextAttempt,
            error: error.message
          }, currentCycleId);
        }
      }
    );
    await traceAction("wallet_cli", "succeeded", { operation }, currentCycleId);
    return data;
  } catch (error) {
    if (!error.operation) error.operation = operation;
    await traceAction("wallet_cli", "failed", {
      operation,
      error: error.message,
      code: error.code,
      name: error.name,
      stateChanging
    }, currentCycleId);
    throw error;
  }
}

function feishuConfigured() {
  return Boolean(
    process.env.FEISHU_WEBHOOK_URL ||
    (
      process.env.FEISHU_APP_ID &&
      process.env.FEISHU_APP_SECRET &&
      process.env.FEISHU_RECEIVE_ID
    )
  );
}

function feishuReceiveIdType(receiveId) {
  if (process.env.FEISHU_RECEIVE_ID_TYPE) return process.env.FEISHU_RECEIVE_ID_TYPE;
  if (receiveId.startsWith("oc_")) return "chat_id";
  if (receiveId.startsWith("ou_")) return "open_id";
  throw new Error("FEISHU_RECEIVE_ID_TYPE is required for an unrecognized Feishu ID");
}

function errorTraceDetails(error) {
  return {
    error: error.message,
    causeCode: error.cause?.code,
    causeMessage: error.cause?.message
  };
}

async function feishuFetch(url, options, stage) {
  return retry(async () => {
    const response = await fetch(url, options);
    if (response.status === 429 || response.status >= 500) {
      const error = new Error(`Feishu HTTP ${response.status}`);
      error.retryable = true;
      throw error;
    }
    return response;
  }, {
    attempts: 3,
    delayMs: 500,
    shouldRetry: (error) => error instanceof TypeError || error.retryable === true,
    onRetry: async (error, attempt, nextAttempt) => {
      await traceAction("feishu_retry", "scheduled", {
        stage,
        attempt,
        nextAttempt,
        ...errorTraceDetails(error)
      }, currentCycleId);
    }
  });
}

async function feishuTenantToken() {
  if (feishuTokenCache?.expiresAt > Date.now() + 60_000) return feishuTokenCache.token;
  const response = await feishuFetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET
    })
  }, "tenant_token");
  const body = await response.json();
  if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`Feishu token request failed: ${body.code ?? response.status} ${body.msg || ""}`.trim());
  }
  feishuTokenCache = {
    token: body.tenant_access_token,
    expiresAt: Date.now() + Number(body.expire || 7200) * 1000
  };
  return feishuTokenCache.token;
}

async function sendFeishu(text) {
  const message = feishuMessageWithDashboardLink(text);
  await traceAction("feishu_notification", "started", { messageLength: message.length }, currentCycleId);
  if (process.env.FEISHU_WEBHOOK_URL) {
    const response = await feishuFetch(process.env.FEISHU_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text: message } })
    }, "webhook");
    if (!response.ok) throw new Error(`Feishu webhook failed: HTTP ${response.status}`);
    await traceAction("feishu_notification", "succeeded", { channel: "webhook", messageLength: message.length }, currentCycleId);
    return;
  }

  const receiveId = process.env.FEISHU_RECEIVE_ID;
  const receiveIdType = feishuReceiveIdType(receiveId);
  const token = await feishuTenantToken();
  const response = await feishuFetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "text",
        content: JSON.stringify({ text: message })
      })
    },
    "message"
  );
  const body = await response.json();
  if (!response.ok || body.code !== 0) {
    throw new Error(`Feishu message failed: ${body.code ?? response.status} ${body.msg || ""}`.trim());
  }
  await traceAction("feishu_notification", "succeeded", { channel: "app", messageLength: message.length }, currentCycleId);
}

async function notify(state, text) {
  if (!feishuConfigured()) {
    state.pendingNotifications.push({ time: new Date().toISOString(), text });
    if (state.pendingNotifications.length > 100) state.pendingNotifications.shift();
    log("Feishu notification queued because credentials are missing");
    return false;
  }

  try {
    await sendFeishu(text);
    return true;
  } catch (error) {
    await traceAction("feishu_notification", "failed", {
      ...errorTraceDetails(error),
      messageLength: text.length
    }, currentCycleId);
    state.pendingNotifications.push({ time: new Date().toISOString(), text });
    log("Feishu notification failed and was queued", { error: error.message });
    return false;
  }
}

async function flushNotifications(state) {
  if (!feishuConfigured() || state.pendingNotifications.length === 0) return;
  const pending = [...state.pendingNotifications];
  state.pendingNotifications = [];
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index];
    const sent = await notify(state, item.text);
    if (!sent) {
      state.pendingNotifications.push(...pending.slice(index + 1));
      break;
    }
  }
}

async function resolveAssets(symbols) {
  const list = await fetchJson(`${API_BASE}/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=1`);
  const wanted = new Set(symbols);
  const assets = new Map();
  for (const item of list) {
    if (item.chainId === BSC_CHAIN_ID && wanted.has(item.ticker)) {
      assets.set(item.ticker, { ...item, isOfficialRwa: true });
    }
  }
  const missing = symbols.filter((symbol) => !assets.has(symbol));
  if (missing.length) throw new Error(`BSC contracts not found: ${missing.join(", ")}`);
  return assets;
}

async function assetStatus(address) {
  return fetchJson(`${API_BASE}/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai?chainId=${BSC_CHAIN_ID}&contractAddress=${address}`);
}

async function rwaDynamic(address) {
  return fetchJson(`${API_BASE}/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai?chainId=${BSC_CHAIN_ID}&contractAddress=${address}`);
}

async function candles(address, interval = "1m", limit = 31) {
  const data = await fetchJson(`${API_BASE}/v1/public/wallet-direct/buw/wallet/dex/market/token/kline/ai?chainId=${BSC_CHAIN_ID}&contractAddress=${address}&interval=${interval}&limit=${limit}`);
  return data.klineInfos || [];
}

async function quote(fromTokenQty, fromToken, toToken, slippagePct) {
  const result = await baw([
    "market-order",
    "quote",
    "--fromTokenQty",
    String(fromTokenQty),
    "--fromToken",
    fromToken,
    "--toToken",
    toToken,
    "--binanceChainId",
    BSC_CHAIN_ID,
    "--slippage",
    String(slippagePct)
  ]);
  return {
    ...result,
    quotedAt: new Date().toISOString()
  };
}

async function tokenBalance(address) {
  const balances = await baw([
    "wallet",
    "balance",
    "--tokenAddress",
    address,
    "--binanceChainId",
    BSC_CHAIN_ID
  ]);
  return Number(balances[0]?.balance || 0);
}

async function checkSessionExpiry(config, state) {
  const now = Date.now();
  if (now - Number(state.lastSettingsCheckAt || 0) < config.settingsCheckIntervalMinutes * 60_000) return;
  state.lastSettingsCheckAt = now;
  try {
    const settings = await baw(["wallet", "settings"]);
    const expiry = walletSessionStatusFromSettings({
      settings,
      nowMs: now,
      warningMs: config.sessionWarningHours * 60 * 60 * 1000
    });
    state.walletSession = {
      ...state.walletSession,
      status: expiry.status === "UNKNOWN" ? state.walletSession?.status || "CONNECTED" : expiry.status,
      checkedAt: new Date(now).toISOString(),
      sessionExpireTime: settings.sessionExpireTime || null,
      signInMaxTime: settings.signInMaxTime || null,
      inactiveSignOutTime: settings.inactiveSignOutTime || null,
      remainingMs: expiry.remainingMs
    };
    if (expiry.status === "EXPIRING" && state.sessionWarningFor !== expiry.maxExpireTime) {
      await notify(
        state,
        `[Agentic Stock Bot] WALLET SESSION EXPIRING\n到期时间: ${expiry.maxExpireTime}\n请在到期前重新登录；机器人不会自动处理二维码授权。`
      );
      state.sessionWarningFor = expiry.maxExpireTime;
    } else if (expiry.status === "CONNECTED") {
      state.sessionWarningFor = null;
    }
    await traceAction("wallet_session_check", "succeeded", {
      status: expiry.status,
      sessionExpireTime: settings.sessionExpireTime || null,
      signInMaxTime: settings.signInMaxTime || null,
      remainingMs: expiry.remainingMs
    }, currentCycleId);
  } catch (error) {
    await traceAction("wallet_session_check", "failed", {
      error: error.message,
      code: error.code,
      name: error.name
    }, currentCycleId);
  }
}

async function audit(asset, config) {
  const data = await fetchJson(AUDIT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "source": "agent",
      "User-Agent": "binance-web3/1.4 (Skill)"
    },
    body: JSON.stringify({
      binanceChainId: BSC_CHAIN_ID,
      contractAddress: asset.contractAddress,
      requestId: randomUUID()
    })
  });
  const hits = (data.riskItems || []).flatMap((item) => item.details || []).filter((detail) => detail.isHit);
  const buyTax = Number(data.extraInfo?.buyTax || 0);
  const sellTax = Number(data.extraInfo?.sellTax || 0);
  const result = auditDecision({
    hasResult: data.hasResult,
    isSupported: data.isSupported,
    riskLevel: data.riskLevel,
    riskLevelEnum: data.riskLevelEnum,
    hits,
    buyTax,
    sellTax,
    isOfficialRwa: asset.isOfficialRwa,
    allowUnsupportedOfficialRwa: config.allowUnsupportedAuditForOfficialRwa
  });
  await traceAction("token_audit_decision", "succeeded", {
    symbol: asset.ticker,
    address: asset.contractAddress,
    decision: result.status,
    officialRwa: asset.isOfficialRwa
  }, currentCycleId);
  return result;
}

function approvalDetailsMatch(request, details) {
  return (
    request.side === details.side &&
    request.symbol === details.symbol &&
    request.address.toLowerCase() === details.address.toLowerCase() &&
    request.fromToken.toLowerCase() === details.fromToken.toLowerCase() &&
    request.toToken.toLowerCase() === details.toToken.toLowerCase() &&
    Math.abs(Number(request.fromTokenQty) - Number(details.fromTokenQty)) < 1e-12
  );
}

async function requestTradeApproval(config, state, statePath, details) {
  const request = createApprovalRequest(details, {
    createdAt: details.createdAt,
    ttlSeconds: config.approvalTtlSeconds
  });
  state.approvalRequest = request;
  await saveJson(statePath, state);
  await traceAction("trade_approval", "requested", {
    approvalId: request.approvalId,
    side: request.side,
    symbol: request.symbol,
    address: request.address,
    expiresAt: request.expiresAt
  }, currentCycleId);
  const approvalControl = await readApprovalControl(
    resolve(dirname(statePath), "approval-control.json")
  );
  if (approvalControl.enabled) {
    const decision = {
      approvalId: request.approvalId,
      decision: "APPROVE",
      dyorAcknowledged: true,
      auditUnavailableAcknowledged: request.audit?.status === "OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED",
      decidedAt: new Date().toISOString()
    };
    await recordApprovalDecision(
      resolve(projectRoot, config.approvalDecisionDirectory),
      request,
      decision
    );
    await traceAction("trade_approval", "auto_approved", {
      approvalId: request.approvalId,
      side: request.side,
      symbol: request.symbol,
      appliesAfterRevalidation: true
    }, currentCycleId);
  }
  const valueLine = request.side === "BUY"
    ? `投入: ${Number(request.fromTokenQty).toFixed(2)} USDT`
    : `预计回收: ${Number(request.expectedOutputQty).toFixed(4)} USDT`;
  await notify(
    state,
    [
      `[Agentic Stock Bot] ${request.side} ${approvalControl.enabled ? "AUTO APPROVAL QUEUED" : "APPROVAL REQUIRED"}`,
      `${request.symbol} ${request.address}`,
      valueLine,
      `来源合约: ${request.fromToken}`,
      `目标合约: ${request.toToken}`,
      `滑点: ${config.slippagePct}% · MEV保护: 开 · Gas: HIGH`,
      `审计: ${request.audit?.riskLevel || request.audit?.status || "TRUSTED_TARGET"}`,
      `确认截止: ${request.expiresAt}`,
      `审批编号: ${request.approvalId}`,
      approvalControl.enabled
        ? "自动审批已记录；Bot 将在下一周期重新验证全部条件后决定是否执行。"
        : "请打开手机 Dashboard 查看完整数据并逐笔确认。真实链上交易不可撤销，请先自行研究（DYOR）。"
    ].join("\n")
  );
  return request;
}

async function swap(config, fromTokenQty, fromToken, toToken) {
  if (config.mode !== "live") {
    const result = { shadow: true, orderId: `shadow-${Date.now()}` };
    await traceAction("market_order", "simulated", {
      mode: config.mode,
      fromToken,
      toToken,
      fromTokenQty,
      orderId: result.orderId
    }, currentCycleId);
    return result;
  }
  return baw([
    "market-order",
    "swap",
    "--fromTokenQty",
    String(fromTokenQty),
    "--fromToken",
    fromToken,
    "--toToken",
    toToken,
    "--binanceChainId",
    BSC_CHAIN_ID,
    "--slippage",
    String(config.slippagePct),
    "--mev",
    "true",
    "--gasLevel",
    "HIGH"
  ], { stateChanging: true });
}

async function marketOrder(orderId) {
  const data = await baw(["market-order", "list", "--orderId", String(orderId)]);
  return data.list?.[0] || null;
}

async function ensureNotEmergencyStopped(emergencyStopPath, state) {
  if (shutdownRequested) {
    const error = new Error("Shutdown requested");
    error.code = "SHUTDOWN_REQUESTED";
    throw error;
  }
  const marker = await readEmergencyStop(emergencyStopPath);
  if (!marker?.active) {
    state.emergencyStop = null;
    return;
  }
  state.emergencyStop = marker;
  const error = new Error(`Emergency stop is active: ${marker.reason}`);
  error.code = "EMERGENCY_STOP";
  throw error;
}

async function submitOrder(config, state, statePath, emergencyStopPath, details) {
  if (config.mode !== "live") {
    return swap(config, details.fromTokenQty, details.fromToken, details.toToken);
  }

  await ensureNotEmergencyStopped(emergencyStopPath, state);
  const intent = createOrderIntent(details);
  state.pendingOrder = intent;
  await saveJson(statePath, state);
  await traceAction("order_intent", "persisted", {
    intentId: intent.intentId,
    side: intent.side,
    symbol: intent.symbol,
    address: intent.address
  }, currentCycleId);

  try {
    await ensureNotEmergencyStopped(emergencyStopPath, state);
    const result = await swap(config, details.fromTokenQty, details.fromToken, details.toToken);
    state.pendingOrder = {
      ...intent,
      status: "SUBMITTED",
      orderId: result.orderId,
      submittedAt: new Date().toISOString()
    };
    await saveJson(statePath, state);
    return result;
  } catch (error) {
    state.pendingOrder = {
      ...intent,
      status: "AMBIGUOUS",
      ambiguousAt: new Date().toISOString(),
      lastError: error.message
    };
    await saveJson(statePath, state);
    await traceAction("order_submission", "ambiguous", {
      intentId: intent.intentId,
      side: intent.side,
      symbol: intent.symbol,
      error: error.message
    }, currentCycleId);
    throw error;
  }
}

async function reconcilePendingOrder(state, statePath) {
  const pending = state.pendingOrder;
  const data = await baw([
    "market-order",
    "list",
    "--fromToken",
    pending.fromToken,
    "--toToken",
    pending.toToken,
    "--startTime",
    String(Date.parse(pending.createdAt) - 60_000),
    "--endTime",
    String(Date.now()),
    "--pageSize",
    "100",
    "--binanceChainId",
    BSC_CHAIN_ID
  ]);
  const matches = matchingOrdersForIntent(data.list || [], pending);
  if (matches.length === 1) {
    state.pendingOrder = {
      ...pending,
      status: "SUBMITTED",
      orderId: matches[0].orderId,
      reconciledAt: new Date().toISOString()
    };
    await saveJson(statePath, state);
    await traceAction("order_recovery", "reconciled", {
      intentId: pending.intentId,
      orderId: matches[0].orderId
    }, currentCycleId);
    return "RECONCILED";
  }

  state.pendingOrder = {
    ...pending,
    status: "REVIEW_REQUIRED",
    reviewReason: matches.length === 0 ? "NO_MATCHING_ORDER" : "MULTIPLE_MATCHING_ORDERS",
    reviewedAt: new Date().toISOString()
  };
  await saveJson(statePath, state);
  await traceAction("order_recovery", "halted", {
    intentId: pending.intentId,
    matchCount: matches.length,
    reason: state.pendingOrder.reviewReason
  }, currentCycleId);
  return "REVIEW_REQUIRED";
}

async function finalizePendingOrder(config, state, statePath) {
  const pending = state.pendingOrder;
  if (!pending) return false;
  const recoveryAction = recoveryActionForPending(pending);
  if (recoveryAction === "RECONCILE") {
    const result = await reconcilePendingOrder(state, statePath);
    if (result === "REVIEW_REQUIRED") {
      await notify(
        state,
        `[Agentic Stock Bot] ORDER REVIEW REQUIRED\n${pending.side} ${pending.symbol} ${pending.address}\nIntent: ${pending.intentId}`
      );
      return true;
    }
  } else if (recoveryAction === "HALT") {
    await traceAction("pending_order", "halted", {
      intentId: pending.intentId,
      reason: pending.reviewReason || "review_required"
    }, currentCycleId);
    return true;
  }

  const submitted = state.pendingOrder;
  const order = await marketOrder(submitted.orderId);
  const action = pendingOrderAction(order?.status);
  if (action === "WAIT") {
    await traceAction("pending_order", "waiting", { orderId: submitted.orderId, side: submitted.side }, currentCycleId);
    log("Order is still pending", { orderId: submitted.orderId, side: submitted.side });
    return true;
  }

  if (action === "FAIL") {
    await traceAction("pending_order", "failed", { orderId: submitted.orderId, side: submitted.side }, currentCycleId);
    state.pendingOrder = null;
    await notify(
      state,
      `[Agentic Stock Bot] ORDER FAILED\n${submitted.side} ${submitted.symbol}\n订单: ${submitted.orderId}`
    );
    return true;
  }

  if (submitted.side === "BUY") {
    const quantity = await tokenBalance(submitted.address);
    if (!(quantity > 0)) throw new Error(`Finished BUY has no token balance for ${submitted.symbol}`);
    state.position = {
      symbol: submitted.symbol,
      strategyId: submitted.strategyId || DEFAULT_STRATEGY_ID,
      address: submitted.address,
      quantity,
      costBasisUsdt: submitted.costBasisUsdt,
      entryCostCoverage: submitted.costCoverage,
      initialRiskPct: submitted.initialRiskPct,
      profitFloorPct: submitted.profitFloorPct,
      entryAtr15Pct: submitted.entryAtr15Pct,
      finalTakeProfitPct: submitted.finalTakeProfitPct,
      peakReturnPct: 0,
      profitProtectionActive: false,
      trailingStopPct: null,
      openedAt: submitted.createdAt,
      orderId: submitted.orderId,
      shadow: false
    };
    state.pendingOrder = null;
    await traceAction("pending_order", "finished", {
      orderId: submitted.orderId,
      side: submitted.side,
      symbol: submitted.symbol,
      quantity
    }, currentCycleId);
    await notify(
      state,
      [
        "[Agentic Stock Bot] BUY FINISHED",
        `${submitted.symbol} ${submitted.address}`,
        `实际持仓: ${quantity}`,
        `投入: ${submitted.costBasisUsdt} USDT`,
        `订单: ${submitted.orderId}`
      ].join("\n")
    );
    return true;
  }

  const usdtAfter = await tokenBalance(USDT_ADDRESS);
  const proceedsUsdt = Math.max(0, usdtAfter - submitted.usdtBefore);
  const realizedPnlUsdt = proceedsUsdt - submitted.costBasisUsdt;
  state.realizedPnlUsdt += realizedPnlUsdt;
  state.cooldownUntil[submitted.symbol] = Date.now() + config.reentryCooldownMinutes * 60_000;
  state.position = null;
  state.pendingOrder = null;
  await traceAction("pending_order", "finished", {
    orderId: submitted.orderId,
    side: submitted.side,
    symbol: submitted.symbol,
    strategyId: submitted.strategyId || DEFAULT_STRATEGY_ID,
    proceedsUsdt,
    realizedPnlUsdt
  }, currentCycleId);
  await notify(
    state,
    [
      `[Agentic Stock Bot] SELL FINISHED ${submitted.reason}`,
      `${submitted.symbol} ${submitted.address}`,
      `实际回收: ${proceedsUsdt.toFixed(4)} USDT`,
      `本笔盈亏: ${realizedPnlUsdt.toFixed(4)} USDT`,
      `当日累计已实现盈亏: ${state.realizedPnlUsdt.toFixed(4)} USDT`,
      `订单: ${submitted.orderId}`
    ].join("\n")
  );
  return true;
}

async function buildCandidate(symbol, asset, config, knownStatus = null) {
  const strategyId = config.activeStrategyId || DEFAULT_STRATEGY_ID;
  const scanId = randomUUID();
  const status = knownStatus || await assetStatus(asset.contractAddress);
  const marketOpen = entryMarketAllowed(status, config.regularOnlyEntries, Date.now());
  if (!marketOpen) {
    await recordMarketData("market_scan", {
      cycleId: currentCycleId,
      scanId,
      symbol,
      contractAddress: asset.contractAddress,
      marketStatus: status,
      gates: {
        marketOpen: false,
        trendPassed: false,
        quoteEvaluated: false
      }
    });
    await traceAction("candidate_rejected", "skipped", {
      symbol,
      reason: status.marketStatus === "offhours" ? "non_regular_session" : "market_status_gate",
      openState: status.openState,
      reasonCode: status.reasonCode,
      marketStatus: status.marketStatus
    }, currentCycleId);
    return null;
  }
  const [minuteKline, atrKline] = await Promise.all([
    candles(asset.contractAddress, "1m", 31),
    candles(asset.contractAddress, "15m", config.atrPeriod + 2)
  ]);
  const signal = analyzeCandles(minuteKline);
  const atr = calculateAtrPct(atrKline, config.atrPeriod);
  const requiredTrend15mPct = atr ? atr.atrPct * config.entryAtrMultiplier : null;
  const trendPassed = signal && atr
    ? signal.trend15mPct + 1e-9 >= requiredTrend15mPct && signal.upMinutes >= config.minDirectionalMinutes
    : false;
  await recordMarketData("market_scan", {
    cycleId: currentCycleId,
    scanId,
    symbol,
    contractAddress: asset.contractAddress,
    marketStatus: status,
    minuteCandles: normalizeCandles(minuteKline),
    atrCandles: normalizeCandles(atrKline),
    signal,
    atr,
    thresholds: {
      entryAtrMultiplier: config.entryAtrMultiplier,
      requiredTrend15mPct,
      minDirectionalMinutes: config.minDirectionalMinutes
    },
    gates: {
      marketOpen,
      trendPassed,
      quoteEvaluated: false
    }
  });
  if (!signal) {
    await traceAction("candidate_rejected", "skipped", { symbol, reason: "insufficient_closed_candles" }, currentCycleId);
    return null;
  }
  if (!atr) {
    await traceAction("candidate_rejected", "skipped", { symbol, reason: "insufficient_closed_atr_candles" }, currentCycleId);
    return null;
  }

  const candidate = { symbol, address: asset.contractAddress, asset, ...status, ...signal, atr15Pct: atr.atrPct };
  if (!marketOpen || (strategyId === DEFAULT_STRATEGY_ID && !trendPassed)) {
    await traceAction("candidate_rejected", "skipped", {
      symbol,
      reason: "market_or_trend_gate",
      openState: candidate.openState,
      reasonCode: candidate.reasonCode,
      trend15mPct: candidate.trend15mPct,
      requiredTrend15mPct,
      upMinutes: candidate.upMinutes,
      atr15Pct: candidate.atr15Pct
    }, currentCycleId);
    return { ...candidate, roundTripCostPct: Infinity };
  }

  const buyQuote = await quote(config.maxTradeUsdt, USDT_ADDRESS, candidate.address, config.slippagePct);
  const sellQuote = await quote(buyQuote.toCoinAmount, candidate.address, USDT_ADDRESS, config.slippagePct);
  const quotedRoundTripCostPct = roundTripCostPct(config.maxTradeUsdt, Number(sellQuote.toCoinAmount));
  const executionCost = executionCostEstimate({
    tradeUsdt: config.maxTradeUsdt,
    quotedRoundTripCostPct,
    executionBufferPct: config.executionBufferPct,
    estimatedRoundTripGasUsdt: config.estimatedRoundTripGasUsdt
  });
  let basis = null;
  let grossEdgeProxyPct = candidate.trend15mPct;
  if (strategyId === "executable-basis-reversion") {
    const dynamic = await rwaDynamic(candidate.address);
    basis = executableBasisDecision({
      executableBuyPrice: config.maxTradeUsdt / Number(buyQuote.toCoinAmount),
      underlyingPrice: Number(dynamic.stockInfo?.price),
      sharesMultiplier: Number(dynamic.tokenInfo?.sharesMultiplier || asset.multiplier),
      allInCostPct: executionCost.allInCostPct,
      minNetEdgePct: config.minNetEdgePct
    });
    grossEdgeProxyPct = basis.grossEdgePct;
  }
  const initialRisk = initialRiskDecision({
    atr15Pct: atr.atrPct,
    atrStopMultiplier: config.atrStopMultiplier,
    minStopPct: config.minInitialStopPct,
    maxStopPct: config.maxInitialStopPct
  });
  const finalTakeProfitPct = initialRisk.allowed
    ? initialRisk.initialRiskPct * config.finalTakeProfitR
    : null;
  const costCoverage = initialRisk.allowed
    ? costCoverageDecision({
        tradeUsdt: config.maxTradeUsdt,
        grossEdgeProxyPct,
        takeProfitPct: finalTakeProfitPct,
        quotedRoundTripCostPct,
        executionBufferPct: config.executionBufferPct,
        estimatedRoundTripGasUsdt: config.estimatedRoundTripGasUsdt,
        minNetEdgePct: config.minNetEdgePct
      })
    : {
        allowed: false,
        reason: initialRisk.reason,
        ...executionCost
      };
  const completed = {
    ...candidate,
    buyQuantity: buyQuote.toCoinAmount,
    buyQuotedAt: buyQuote.quotedAt,
    roundTripCostPct: quotedRoundTripCostPct,
    costCoverage,
    initialRisk,
    initialRiskPct: initialRisk.initialRiskPct,
    finalTakeProfitPct
  };
  completed.strategyId = strategyId;
  completed.grossEdgeProxyPct = grossEdgeProxyPct;
  completed.basis = basis;
  if (strategyId === "executable-basis-reversion" && !basis?.allowed) {
    completed.costCoverage = { ...costCoverage, allowed: false, reason: basis?.reason || "INVALID_BASIS_INPUT" };
  }
  await recordMarketData("quote_evaluation", {
    cycleId: currentCycleId,
    scanId,
    symbol,
    strategyId,
    contractAddress: asset.contractAddress,
    buyQuote: {
      toCoinAmount: buyQuote.toCoinAmount,
      quotedAt: buyQuote.quotedAt
    },
    sellQuote: {
      toCoinAmount: sellQuote.toCoinAmount,
      quotedAt: sellQuote.quotedAt
    },
    quotedRoundTripCostPct,
    executionCost,
    initialRisk,
    costCoverage,
    finalTakeProfitPct
  });
  await traceAction("candidate_evaluated", "succeeded", {
    symbol,
    trend15mPct: completed.trend15mPct,
    upMinutes: completed.upMinutes,
    roundTripCostPct: completed.roundTripCostPct,
    costCoverageAllowed: costCoverage.allowed,
    costCoverageReason: costCoverage.reason,
    allInCostPct: costCoverage.allInCostPct,
    netEdgeProxyPct: costCoverage.netEdgeProxyPct,
    atr15Pct: completed.atr15Pct,
    initialRiskAllowed: initialRisk.allowed,
    initialRiskReason: initialRisk.reason,
    initialRiskPct: completed.initialRiskPct,
    finalTakeProfitPct,
    gasCostPct: costCoverage.gasCostPct,
    executionBufferPct: costCoverage.executionBufferPct
  }, currentCycleId);
  return completed;
}

async function evaluateEntry(config, state, statePath, emergencyStopPath, approvedRequest = null) {
  if (dailyLossReached(state.realizedPnlUsdt, config.dailyLossLimitUsdt)) {
    await traceAction("entry_decision", "skipped", { reason: "daily_loss_limit" }, currentCycleId);
    return;
  }
  const now = Date.now();
  let schedule = null;
  if (!approvedRequest) {
    schedule = entryStatusCheckDecision({
      nowMs: now,
      lastMarketStatusCheckAt: state.lastMarketStatusCheckAt,
      lastEntryDecisionAt: state.lastEntryDecisionAt,
      lastMarketSession: state.lastMarketSession,
      entryIntervalMinutes: config.entryIntervalMinutes,
      pollSeconds: config.pollSeconds
    });
    if (!schedule.due) {
      await traceAction("entry_decision", "skipped", {
        reason: "market_status_interval",
        scheduleReason: schedule.reason,
        intervalMs: schedule.intervalMs
      }, currentCycleId);
      return;
    }
    state.lastMarketStatusCheckAt = now;
  }

  const symbols = approvedRequest ? [approvedRequest.symbol] : config.symbols;
  const eligibleSymbols = [];
  for (const symbol of symbols) {
    if ((state.cooldownUntil[symbol] || 0) > now) {
      await traceAction("candidate_rejected", "skipped", { symbol, reason: "cooldown" }, currentCycleId);
    } else {
      eligibleSymbols.push(symbol);
    }
  }
  if (eligibleSymbols.length === 0) {
    await traceAction("entry_decision", "skipped", { reason: "no_eligible_symbol" }, currentCycleId);
    return;
  }

  const assets = await resolveAssets(eligibleSymbols);
  const statusEntries = (await Promise.all(
    eligibleSymbols.map(async (symbol) => {
      try {
        return {
          symbol,
          status: await assetStatus(assets.get(symbol).contractAddress)
        };
      } catch (error) {
        await recordMarketData("candidate_error", {
          cycleId: currentCycleId,
          symbol,
          contractAddress: assets.get(symbol)?.contractAddress || null,
          phase: "market_status",
          error: error.message
        });
        await traceAction("candidate_evaluation", "failed", {
          symbol,
          phase: "market_status",
          error: error.message
        }, currentCycleId);
        log("Market status check failed", { symbol, error: error.message });
        return null;
      }
    })
  )).filter(Boolean);
  const nysePlan = nyseSessionPlan(now);
  const sessionDecision = entrySessionDecision(statusEntries, config.regularOnlyEntries, now);
  const observedMarketSession = sessionDecision.shouldScan
    ? "regular"
    : statusEntries.some(({ status }) => status.marketStatus === "offhours")
      ? "offhours"
      : statusEntries.length > 0
        ? "closed"
        : state.lastMarketSession || null;
  state.lastMarketSession = observedMarketSession;
  await recordMarketData("market_session_check", {
    cycleId: currentCycleId,
    regularOnlyEntries: config.regularOnlyEntries,
    statuses: statusEntries.map(({ symbol, status }) => ({
      symbol,
      openState: status.openState,
      reasonCode: status.reasonCode,
      marketStatus: status.marketStatus
    })),
    schedule,
    nysePlan,
    observedMarketSession,
    decision: sessionDecision
  });
  if (!sessionDecision.shouldScan) {
    const reason = statusEntries.length === 0 && eligibleSymbols.length > 0
      ? "market_status_unavailable"
      : "non_regular_session";
    await traceAction("entry_decision", "skipped", {
      reason,
      regularOnlyEntries: config.regularOnlyEntries,
      statusCount: statusEntries.length,
      nysePlan
    }, currentCycleId);
    log("Heavy entry scan skipped", { reason });
    return;
  }
  if (!approvedRequest) state.lastEntryDecisionAt = now;

  const statusBySymbol = new Map(statusEntries.map(({ symbol, status }) => [symbol, status]));
  const candidates = (await Promise.all(
    sessionDecision.symbols.map(async (symbol) => {
      try {
        return await buildCandidate(symbol, assets.get(symbol), config, statusBySymbol.get(symbol));
      } catch (error) {
        await recordMarketData("candidate_error", {
          cycleId: currentCycleId,
          symbol,
          contractAddress: assets.get(symbol)?.contractAddress || null,
          error: error.message
        });
        await traceAction("candidate_evaluation", "failed", { symbol, error: error.message }, currentCycleId);
        log("Candidate evaluation failed", { symbol, error: error.message });
        return null;
      }
    })
  )).filter(Boolean);

  const selected = config.activeStrategyId === "executable-basis-reversion"
    ? candidates.filter((candidate) => candidate.costCoverage?.allowed)
      .sort((left, right) => right.costCoverage.netEdgeProxyPct - left.costCoverage.netEdgeProxyPct)[0]
    : rankCandidates(candidates, config)[0];
  if (!selected) {
    await traceAction("entry_decision", "skipped", { reason: "no_candidate_passed" }, currentCycleId);
    log("No entry candidate passed all gates");
    return;
  }

  await traceAction("candidate_selected", "succeeded", {
    symbol: selected.symbol,
    trend15mPct: selected.trend15mPct,
    upMinutes: selected.upMinutes,
    roundTripCostPct: selected.roundTripCostPct,
    costCoverageAllowed: selected.costCoverage.allowed,
    costCoverageReason: selected.costCoverage.reason,
    allInCostPct: selected.costCoverage.allInCostPct,
    netEdgeProxyPct: selected.costCoverage.netEdgeProxyPct,
    atr15Pct: selected.atr15Pct,
    initialRiskPct: selected.initialRiskPct,
    finalTakeProfitPct: selected.finalTakeProfitPct
  }, currentCycleId);
  const auditResult = await audit(selected.asset, config);
  if (config.mode === "live" && !feishuConfigured()) {
    throw new Error("Feishu credentials are required in live mode");
  }

  const usdtBefore = await tokenBalance(USDT_ADDRESS);
  if (usdtBefore < config.maxTradeUsdt) throw new Error(`Insufficient USDT: ${usdtBefore}`);
  const freshBuyQuote = await quote(config.maxTradeUsdt, USDT_ADDRESS, selected.address, config.slippagePct);
  assertQuoteFresh({
    quotedAt: freshBuyQuote.quotedAt,
    maxAgeMs: config.quoteMaxAgeSeconds * 1000
  });
  const driftPct = quoteDriftPct(selected.buyQuantity, freshBuyQuote.toCoinAmount);
  if (driftPct > config.maxQuoteDriftPct) {
    await traceAction("entry_decision", "skipped", {
      reason: "quote_drift",
      symbol: selected.symbol,
      driftPct,
      maxQuoteDriftPct: config.maxQuoteDriftPct
    }, currentCycleId);
    return;
  }
  const freshSellQuote = await quote(freshBuyQuote.toCoinAmount, selected.address, USDT_ADDRESS, config.slippagePct);
  const freshRoundTripCostPct = roundTripCostPct(config.maxTradeUsdt, Number(freshSellQuote.toCoinAmount));
  if (freshRoundTripCostPct > config.maxRoundTripCostPct) {
    await traceAction("entry_decision", "skipped", {
      reason: "fresh_round_trip_cost",
      symbol: selected.symbol,
      freshRoundTripCostPct
    }, currentCycleId);
    return;
  }
  const freshExecutionCost = executionCostEstimate({
    tradeUsdt: config.maxTradeUsdt,
    quotedRoundTripCostPct: freshRoundTripCostPct,
    executionBufferPct: config.executionBufferPct,
    estimatedRoundTripGasUsdt: config.estimatedRoundTripGasUsdt
  });
  const freshInitialRisk = initialRiskDecision({
    atr15Pct: selected.atr15Pct,
    atrStopMultiplier: config.atrStopMultiplier,
    minStopPct: config.minInitialStopPct,
    maxStopPct: config.maxInitialStopPct
  });
  if (!freshInitialRisk.allowed) {
    await traceAction("entry_decision", "skipped", {
      reason: "fresh_initial_risk_rejected",
      symbol: selected.symbol,
      atr15Pct: selected.atr15Pct,
      allInCostPct: freshExecutionCost.allInCostPct,
      requiredRiskPct: freshInitialRisk.requiredRiskPct,
      maxInitialStopPct: config.maxInitialStopPct
    }, currentCycleId);
    return;
  }
  const freshFinalTakeProfitPct = freshInitialRisk.initialRiskPct * config.finalTakeProfitR;
  const freshProfitFloorPct = freshExecutionCost.allInCostPct + config.minNetEdgePct;
  const freshCostCoverage = costCoverageDecision({
    tradeUsdt: config.maxTradeUsdt,
    grossEdgeProxyPct: selected.grossEdgeProxyPct ?? selected.trend15mPct,
    takeProfitPct: freshFinalTakeProfitPct,
    quotedRoundTripCostPct: freshRoundTripCostPct,
    executionBufferPct: config.executionBufferPct,
    estimatedRoundTripGasUsdt: config.estimatedRoundTripGasUsdt,
    minNetEdgePct: config.minNetEdgePct
  });
  await traceAction("cost_coverage_decision", freshCostCoverage.allowed ? "succeeded" : "skipped", {
    symbol: selected.symbol,
    ...freshCostCoverage
  }, currentCycleId);
  if (!freshCostCoverage.allowed) {
    await traceAction("entry_decision", "skipped", {
      reason: "fresh_cost_not_covered",
      symbol: selected.symbol,
      costCoverageReason: freshCostCoverage.reason,
      allInCostPct: freshCostCoverage.allInCostPct,
      netEdgeProxyPct: freshCostCoverage.netEdgeProxyPct,
      atr15Pct: selected.atr15Pct,
      initialRiskPct: freshInitialRisk.initialRiskPct,
      finalTakeProfitPct: freshFinalTakeProfitPct
    }, currentCycleId);
    return;
  }
  const createdAt = new Date().toISOString();
  const orderDetails = {
    side: "BUY",
    strategyId: selected.strategyId || DEFAULT_STRATEGY_ID,
    symbol: selected.symbol,
    address: selected.address,
    fromToken: USDT_ADDRESS,
    toToken: selected.address,
    fromTokenQty: config.maxTradeUsdt,
    costBasisUsdt: config.maxTradeUsdt,
    costCoverage: freshCostCoverage,
    initialRiskPct: freshInitialRisk.initialRiskPct,
    profitFloorPct: freshProfitFloorPct,
    entryAtr15Pct: selected.atr15Pct,
    finalTakeProfitPct: freshFinalTakeProfitPct,
    usdtBefore,
    createdAt
  };
  const approvalDetails = {
    ...orderDetails,
    expectedOutputQty: freshBuyQuote.toCoinAmount,
    quoteTimestamp: freshBuyQuote.quotedAt,
    trend15mPct: selected.trend15mPct,
    upMinutes: selected.upMinutes,
    roundTripCostPct: freshRoundTripCostPct,
    allInCostPct: freshCostCoverage.allInCostPct,
    netEdgeProxyPct: freshCostCoverage.netEdgeProxyPct,
    audit: auditResult
  };
  if (config.mode === "live" && !approvedRequest) {
    await requestTradeApproval(config, state, statePath, approvalDetails);
    return;
  }
  if (approvedRequest) {
    if (!approvalDetailsMatch(approvedRequest, orderDetails)) {
      throw new Error(`Approved BUY no longer matches ${selected.symbol}`);
    }
    const approvalDriftPct = quoteDriftPct(approvedRequest.expectedOutputQty, freshBuyQuote.toCoinAmount);
    if (approvalDriftPct > config.maxQuoteDriftPct || approvedRequest.audit?.status !== auditResult.status) {
      await traceAction("trade_approval", "invalidated", {
        approvalId: approvedRequest.approvalId,
        side: "BUY",
        symbol: selected.symbol,
        reason: approvalDriftPct > config.maxQuoteDriftPct ? "quote_drift" : "audit_changed",
        approvalDriftPct,
        maxQuoteDriftPct: config.maxQuoteDriftPct
      }, currentCycleId);
      await notify(
        state,
        `[Agentic Stock Bot] BUY APPROVAL INVALIDATED\n${selected.symbol} ${selected.address}\n报价或审计已变化，未执行交易；等待下一次完整扫描。`
      );
      return;
    }
  }
  const result = await submitOrder(config, state, statePath, emergencyStopPath, orderDetails);
  if (result.shadow) {
    state.position = {
      symbol: selected.symbol,
      strategyId: selected.strategyId || DEFAULT_STRATEGY_ID,
      address: selected.address,
      quantity: freshBuyQuote.toCoinAmount,
      costBasisUsdt: config.maxTradeUsdt,
      entryCostCoverage: freshCostCoverage,
      initialRiskPct: freshInitialRisk.initialRiskPct,
      profitFloorPct: freshProfitFloorPct,
      entryAtr15Pct: selected.atr15Pct,
      finalTakeProfitPct: freshFinalTakeProfitPct,
      peakReturnPct: 0,
      profitProtectionActive: false,
      trailingStopPct: null,
      openedAt: createdAt,
      orderId: result.orderId,
      shadow: true
    };
  }
  await traceAction("buy_submission", result.shadow ? "simulated" : "submitted", {
    symbol: selected.symbol,
    strategyId: selected.strategyId || DEFAULT_STRATEGY_ID,
    address: selected.address,
    amountUsdt: config.maxTradeUsdt,
    allInCostPct: freshCostCoverage.allInCostPct,
    netEdgeProxyPct: freshCostCoverage.netEdgeProxyPct,
    atr15Pct: selected.atr15Pct,
    initialRiskPct: freshInitialRisk.initialRiskPct,
    profitFloorPct: freshProfitFloorPct,
    finalTakeProfitPct: freshFinalTakeProfitPct,
    orderId: result.orderId
  }, currentCycleId);
  await notify(
    state,
    [
      `[Agentic Stock Bot] BUY SUBMITTED ${config.mode.toUpperCase()}`,
      `${selected.symbol} ${selected.address}`,
      `投入: ${config.maxTradeUsdt} USDT`,
      `15分钟趋势: ${selected.trend15mPct.toFixed(3)}%`,
      `报价往返成本: ${freshRoundTripCostPct.toFixed(3)}%`,
      `全成本估算: ${freshCostCoverage.allInCostPct.toFixed(3)}%`,
      `扣除成本后信号余量: ${freshCostCoverage.netEdgeProxyPct.toFixed(3)}%`,
      `ATR15: ${selected.atr15Pct.toFixed(3)}%`,
      `初始风险 R: ${freshInitialRisk.initialRiskPct.toFixed(3)}%`,
      `成本保护下限: ${freshProfitFloorPct.toFixed(3)}%`,
      `最终止盈 2R: ${freshFinalTakeProfitPct.toFixed(3)}%`,
      `审计: ${auditResult.riskLevel || auditResult.status}`,
      `订单: ${result.orderId}`
    ].join("\n")
  );
}

async function evaluateExit(config, state, statePath, emergencyStopPath, approvedRequest = null) {
  const position = state.position;
  if (!position) return;

  const quantity = position.shadow ? Number(position.quantity) : await tokenBalance(position.address);
  if (!(quantity > 0)) throw new Error(`Position balance missing for ${position.symbol}`);
  if (!(Number(position.initialRiskPct) > 0)) {
    throw new Error(`Position risk metadata missing for ${position.symbol}`);
  }
  const [sellQuote, minuteKline, atrKline, dynamic] = await Promise.all([
    quote(quantity, position.address, USDT_ADDRESS, config.slippagePct),
    candles(position.address, "1m", 31),
    candles(position.address, "15m", config.atrPeriod + 2),
    position.strategyId === "executable-basis-reversion" ? rwaDynamic(position.address) : null
  ]);
  const signal = analyzeCandles(minuteKline);
  const atr = calculateAtrPct(atrKline, config.atrPeriod);
  if (!atr) throw new Error(`ATR data missing for ${position.symbol}`);
  const signalValid = signal
    ? signal.trend15mPct + 1e-9 >= atr.atrPct * config.entryAtrMultiplier && signal.upMinutes >= config.minDirectionalMinutes
    : null;
  const proceedsUsdt = Number(sellQuote.toCoinAmount);
  const returnPct = ((proceedsUsdt / position.costBasisUsdt) - 1) * 100;
  const storedProfitFloorPct = Number(position.profitFloorPct);
  const entryAllInCostPct = Number(position.entryCostCoverage?.allInCostPct);
  const profitFloorPct = storedProfitFloorPct > 0
    ? storedProfitFloorPct
    : (Number.isFinite(entryAllInCostPct) ? entryAllInCostPct : 0) + config.minNetEdgePct;
  position.lastQuoteProceedsUsdt = proceedsUsdt;
  position.lastQuoteAt = sellQuote.quotedAt;
  position.currentAtr15Pct = atr.atrPct;
  position.lastSignalValid = signalValid;
  position.lastSignalTrend15mPct = signal?.trend15mPct ?? null;
  position.profitFloorPct = profitFloorPct;
  let reason = dynamicExitDecision({
    returnPct,
    initialRiskPct: Number(position.initialRiskPct),
    atr15Pct: atr.atrPct,
    peakReturnPct: Number(position.peakReturnPct || 0),
    profitProtectionActive: position.profitProtectionActive === true,
    openedAtMs: Date.parse(position.openedAt),
    signalValid,
    disasterStopLossPct: config.disasterStopLossPct,
    profitProtectionR: config.profitProtectionR,
    trailingAtrMultiplier: config.trailingAtrMultiplier,
    finalTakeProfitR: config.finalTakeProfitR,
    signalReviewHours: config.signalReviewHours,
    signalReviewMinR: config.signalReviewMinR,
    profitFloorPct
  });
  const fairTokenPrice = dynamic
    ? Number(dynamic.stockInfo?.price) * Number(dynamic.tokenInfo?.sharesMultiplier)
    : null;
  if (!reason.type && basisExitReached({
    executableSellPrice: proceedsUsdt / quantity,
    fairTokenPrice,
    exitBasisPct: config.basisExitPct
  })) {
    reason = { ...reason, type: "BASIS_NORMALIZED" };
  }
  position.peakReturnPct = reason.peakReturnPct;
  position.profitProtectionActive = reason.profitProtectionActive;
  position.trailingStopPct = reason.trailingStopPct;
  if (!reason.type) {
    await traceAction("exit_decision", "skipped", {
      symbol: position.symbol,
      reason: "dynamic_exit_not_triggered",
      proceedsUsdt,
      returnPct,
      atr15Pct: atr.atrPct,
      initialRiskPct: position.initialRiskPct,
      peakReturnPct: reason.peakReturnPct,
      profitProtectionActive: reason.profitProtectionActive,
      trailingStopPct: reason.trailingStopPct,
      profitFloorPct,
      finalTakeProfitPct: reason.finalTakeProfitPct,
      signalValid,
      heldMs: reason.heldMs
    }, currentCycleId);
    log("Position monitored", {
      symbol: position.symbol,
      returnPct,
      peakReturnPct: reason.peakReturnPct,
      trailingStopPct: reason.trailingStopPct
    });
    return;
  }

  const confirmationQuote = await quote(quantity, position.address, USDT_ADDRESS, config.slippagePct);
  assertQuoteFresh({
    quotedAt: confirmationQuote.quotedAt,
    maxAgeMs: config.quoteMaxAgeSeconds * 1000
  });
  const confirmedProceedsUsdt = Number(confirmationQuote.toCoinAmount);
  const confirmedReturnPct = ((confirmedProceedsUsdt / position.costBasisUsdt) - 1) * 100;
  let confirmedReason = dynamicExitDecision({
    returnPct: confirmedReturnPct,
    initialRiskPct: Number(position.initialRiskPct),
    atr15Pct: atr.atrPct,
    peakReturnPct: reason.peakReturnPct,
    profitProtectionActive: reason.profitProtectionActive,
    openedAtMs: Date.parse(position.openedAt),
    signalValid,
    disasterStopLossPct: config.disasterStopLossPct,
    profitProtectionR: config.profitProtectionR,
    trailingAtrMultiplier: config.trailingAtrMultiplier,
    finalTakeProfitR: config.finalTakeProfitR,
    signalReviewHours: config.signalReviewHours,
    signalReviewMinR: config.signalReviewMinR,
    profitFloorPct
  });
  if (!confirmedReason.type && basisExitReached({
    executableSellPrice: confirmedProceedsUsdt / quantity,
    fairTokenPrice,
    exitBasisPct: config.basisExitPct
  })) {
    confirmedReason = { ...confirmedReason, type: "BASIS_NORMALIZED" };
  }
  position.peakReturnPct = confirmedReason.peakReturnPct;
  position.profitProtectionActive = confirmedReason.profitProtectionActive;
  position.trailingStopPct = confirmedReason.trailingStopPct;
  if (!confirmedReason.type) {
    await traceAction("exit_decision", "skipped", {
      symbol: position.symbol,
      reason: "fresh_quote_no_longer_triggers_exit",
      proceedsUsdt: confirmedProceedsUsdt,
      returnPct: confirmedReturnPct,
      peakReturnPct: confirmedReason.peakReturnPct,
      trailingStopPct: confirmedReason.trailingStopPct,
      profitFloorPct
    }, currentCycleId);
    return;
  }
  const usdtBefore = config.mode === "live" ? await tokenBalance(USDT_ADDRESS) : null;
  const createdAt = new Date().toISOString();
  const orderDetails = {
    side: "SELL",
    strategyId: position.strategyId || DEFAULT_STRATEGY_ID,
    symbol: position.symbol,
    address: position.address,
    fromToken: position.address,
    toToken: USDT_ADDRESS,
    fromTokenQty: quantity,
    quantity,
    costBasisUsdt: position.costBasisUsdt,
    usdtBefore,
    reason: confirmedReason.type,
    createdAt
  };
  const approvalDetails = {
    ...orderDetails,
    expectedOutputQty: confirmedProceedsUsdt,
    quoteTimestamp: confirmationQuote.quotedAt,
    expectedReturnPct: confirmedReason.returnPct,
    initialRiskPct: position.initialRiskPct,
    atr15Pct: atr.atrPct,
    trailingStopPct: confirmedReason.trailingStopPct,
    profitFloorPct,
    audit: {
      status: "TRUSTED_TARGET_USDT"
    }
  };
  if (config.mode === "live" && !approvedRequest) {
    await requestTradeApproval(config, state, statePath, approvalDetails);
    return;
  }
  if (approvedRequest) {
    if (!approvalDetailsMatch(approvedRequest, orderDetails)) {
      throw new Error(`Approved SELL no longer matches ${position.symbol}`);
    }
    const approvalDriftPct = quoteDriftPct(approvedRequest.expectedOutputQty, confirmedProceedsUsdt);
    if (approvalDriftPct > config.maxQuoteDriftPct) {
      await traceAction("trade_approval", "invalidated", {
        approvalId: approvedRequest.approvalId,
        side: "SELL",
        symbol: position.symbol,
        reason: "quote_drift",
        approvalDriftPct,
        maxQuoteDriftPct: config.maxQuoteDriftPct
      }, currentCycleId);
      await notify(
        state,
        `[Agentic Stock Bot] SELL APPROVAL INVALIDATED\n${position.symbol} ${position.address}\n报价漂移超过 ${config.maxQuoteDriftPct}%，未执行交易；重新评估退出条件。`
      );
      return;
    }
  }
  const result = await submitOrder(config, state, statePath, emergencyStopPath, orderDetails);
  if (result.shadow) {
    const realizedPnlUsdt = confirmedProceedsUsdt - position.costBasisUsdt;
    state.realizedPnlUsdt += realizedPnlUsdt;
    state.cooldownUntil[position.symbol] = Date.now() + config.reentryCooldownMinutes * 60_000;
    state.position = null;
  }
  await traceAction("sell_submission", result.shadow ? "simulated" : "submitted", {
    symbol: position.symbol,
    strategyId: position.strategyId || DEFAULT_STRATEGY_ID,
    address: position.address,
    reason: confirmedReason.type,
    expectedProceedsUsdt: confirmedProceedsUsdt,
    realizedPnlUsdt: result.shadow ? confirmedProceedsUsdt - position.costBasisUsdt : null,
    returnPct: confirmedReason.returnPct,
    initialRiskPct: position.initialRiskPct,
    atr15Pct: atr.atrPct,
    trailingStopPct: confirmedReason.trailingStopPct,
    profitFloorPct,
    orderId: result.orderId
  }, currentCycleId);
  await notify(
    state,
    [
      `[Agentic Stock Bot] SELL SUBMITTED ${config.mode.toUpperCase()} ${confirmedReason.type}`,
      `${position.symbol} ${position.address}`,
      `预计回收: ${confirmedProceedsUsdt.toFixed(4)} USDT`,
      `预计盈亏: ${(confirmedProceedsUsdt - position.costBasisUsdt).toFixed(4)} USDT (${confirmedReason.returnPct.toFixed(3)}%)`,
      `初始风险 R: ${Number(position.initialRiskPct).toFixed(3)}%`,
      `ATR15: ${atr.atrPct.toFixed(3)}%`,
      `成本保护下限: ${profitFloorPct.toFixed(3)}%`,
      `移动保护线: ${confirmedReason.trailingStopPct == null ? "未启用" : `${confirmedReason.trailingStopPct.toFixed(3)}%`}`,
      `订单: ${result.orderId}`
    ].join("\n")
  );
}

async function processTradeApproval(config, state, statePath, emergencyStopPath) {
  const request = state.approvalRequest;
  if (!request) return false;
  const decisionDirectory = resolve(projectRoot, config.approvalDecisionDirectory);
  const decision = await loadApprovalDecision(decisionDirectory, request.approvalId);
  const outcome = approvalDecisionStatus(request, decision);
  if (outcome.status === "WAITING") {
    await traceAction("trade_approval", "waiting", {
      approvalId: request.approvalId,
      side: request.side,
      symbol: request.symbol,
      expiresAt: request.expiresAt
    }, currentCycleId);
    return true;
  }

  state.approvalRequest = null;
  state.lastApprovalDecision = {
    approvalId: request.approvalId,
    side: request.side,
    symbol: request.symbol,
    status: outcome.status,
    decidedAt: decision?.decidedAt || new Date().toISOString()
  };
  await saveJson(statePath, state);
  await traceAction("trade_approval", outcome.status === "APPROVED" ? "approved" : "closed", {
    approvalId: request.approvalId,
    side: request.side,
    symbol: request.symbol,
    outcome: outcome.status
  }, currentCycleId);

  if (outcome.status !== "APPROVED") {
    await notify(
      state,
      `[Agentic Stock Bot] ${request.side} APPROVAL ${outcome.status}\n${request.symbol} ${request.address}\n未执行链上交易。`
    );
    return true;
  }

  await ensureNotEmergencyStopped(emergencyStopPath, state);
  if (request.side === "BUY") {
    if (state.position) throw new Error("Approved BUY blocked because a position already exists");
    await evaluateEntry(config, state, statePath, emergencyStopPath, request);
    return true;
  }
  if (!state.position) throw new Error("Approved SELL blocked because the position no longer exists");
  await evaluateExit(config, state, statePath, emergencyStopPath, request);
  return true;
}

async function cycle(config, state, statePath, emergencyStopPath) {
  currentCycleId = randomUUID();
  await traceAction("cycle", "started", {
    hasPosition: Boolean(state.position),
    hasPendingOrder: Boolean(state.pendingOrder)
  }, currentCycleId);
  try {
    await ensureNotEmergencyStopped(emergencyStopPath, state);
    await flushNotifications(state);
    const wallet = await resolveWalletStatus((args) => baw(args));
    if (wallet.verifiedBy) {
      await traceAction("wallet_status_fallback", "succeeded", {
        status: wallet.status,
        verifiedBy: wallet.verifiedBy
      }, currentCycleId);
    }
    if (wallet.status !== "CONNECTED") {
      throw new BawError({
        code: 100001005,
        name: "WALLET_UNCONNECTED",
        message: `Wallet status is ${wallet.status}`,
        operation: "wallet status"
      });
    }
    if (state.walletSession?.status === "EXPIRED") {
      await notify(
        state,
        `[Agentic Stock Bot] WALLET SESSION RECOVERED\n时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`
      );
    }
    state.walletSession = {
      status: "CONNECTED",
      checkedAt: new Date().toISOString()
    };
    await checkSessionExpiry(config, state);

    if (state.pendingOrder) {
      await finalizePendingOrder(config, state, statePath);
    } else if (state.approvalRequest) {
      await processTradeApproval(config, state, statePath, emergencyStopPath);
    } else if (state.position) {
      await evaluateExit(config, state, statePath, emergencyStopPath);
    } else {
      const strategyControl = await readStrategyControl(
        resolve(projectRoot, config.strategyControlFile),
        config.defaultStrategyId
      );
      config.activeStrategyId = strategyControl.strategyId;
      await evaluateEntry(config, state, statePath, emergencyStopPath);
    }
    state.updatedAt = new Date().toISOString();
    state.lastError = null;
    state.lastFailureFingerprint = null;
    await saveJson(statePath, state);
    await traceAction("state_saved", "succeeded", {
      hasPosition: Boolean(state.position),
      hasPendingOrder: Boolean(state.pendingOrder),
      realizedPnlUsdt: state.realizedPnlUsdt
    }, currentCycleId);
    await traceAction("cycle", "succeeded", {}, currentCycleId);
  } catch (error) {
    await traceAction("cycle", "failed", { error: error.message }, currentCycleId);
    throw error;
  } finally {
    currentCycleId = null;
  }
}

async function runMockTrade(config, runId) {
  currentCycleId = randomUUID();
  const startedAt = new Date().toISOString();
  const symbol = config.symbols.includes("NVDA") ? "NVDA" : config.symbols[0];
  const amountUsdt = Math.min(50, config.maxTradeUsdt);
  const buyPrice = 100;
  const sellPrice = 110;
  const orderId = `mock-${Date.now()}`;
  const resultPath = resolve(projectRoot, "state", "mock-trades", `${runId}.json`);
  const notificationState = freshState();

  await traceAction("mock_trade", "started", {
    symbol,
    amountUsdt,
    walletAccess: false,
    onchainBroadcast: false
  }, currentCycleId);

  try {
    const asset = (await resolveAssets([symbol])).get(symbol);
    const simulation = simulateRoundTrip({ amountUsdt, buyPrice, sellPrice });

    await traceAction("buy_submission", "simulated", {
      symbol,
      address: asset.contractAddress,
      amountUsdt,
      buyPrice,
      quantity: simulation.quantity,
      orderId
    }, currentCycleId);
    await traceAction("position_change", "simulated", {
      symbol,
      from: "FLAT",
      to: "LONG",
      quantity: simulation.quantity
    }, currentCycleId);
    await traceAction("exit_decision", "triggered", {
      symbol,
      reason: "TAKE_PROFIT",
      returnPct: simulation.returnPct
    }, currentCycleId);
    await traceAction("sell_submission", "simulated", {
      symbol,
      address: asset.contractAddress,
      quantity: simulation.quantity,
      sellPrice,
      proceedsUsdt: simulation.proceedsUsdt,
      orderId
    }, currentCycleId);
    await traceAction("position_change", "simulated", {
      symbol,
      from: "LONG",
      to: "FLAT",
      realizedPnlUsdt: simulation.realizedPnlUsdt
    }, currentCycleId);

    const notificationSent = await notify(
      notificationState,
      [
        "[Agentic Stock Bot] MOCK ROUND TRIP COMPLETED",
        `标的: ${symbol} ${asset.contractAddress}`,
        `模拟买入: ${amountUsdt.toFixed(2)} USDT @ ${buyPrice.toFixed(2)}`,
        `模拟卖出: ${simulation.proceedsUsdt.toFixed(2)} USDT @ ${sellPrice.toFixed(2)}`,
        `模拟已实现盈亏: +${simulation.realizedPnlUsdt.toFixed(2)} USDT (${simulation.returnPct.toFixed(2)}%)`,
        `退出原因: TAKE_PROFIT`,
        `模拟订单: ${orderId}`,
        "未访问钱包，未广播链上交易"
      ].join("\n")
    );
    const record = {
      runId,
      cycleId: currentCycleId,
      startedAt,
      completedAt: new Date().toISOString(),
      mode: "mock",
      symbol,
      address: asset.contractAddress,
      amountUsdt,
      buyPrice,
      sellPrice,
      orderId,
      exitReason: "TAKE_PROFIT",
      notificationSent,
      walletAccess: false,
      onchainBroadcast: false,
      ...simulation
    };
    await saveJson(resultPath, record);
    await traceAction("mock_result_saved", "succeeded", {
      resultPath: resultPath.replace(`${projectRoot}/`, ""),
      notificationSent
    }, currentCycleId);
    await traceAction("mock_trade", "succeeded", {
      symbol,
      realizedPnlUsdt: simulation.realizedPnlUsdt,
      returnPct: simulation.returnPct
    }, currentCycleId);
    log("Mock round trip completed", {
      symbol,
      realizedPnlUsdt: simulation.realizedPnlUsdt,
      resultPath
    });
    return record;
  } catch (error) {
    await traceAction("mock_trade", "failed", { error: error.message }, currentCycleId);
    throw error;
  } finally {
    currentCycleId = null;
  }
}

async function waitForNextCycle(milliseconds) {
  if (shutdownRequested) return;
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      wakeLoop = null;
      resolvePromise();
    }, milliseconds);
    wakeLoop = () => {
      clearTimeout(timer);
      wakeLoop = null;
      resolvePromise();
    };
  });
}

async function main() {
  if (testFeishu) {
    if (!feishuConfigured()) throw new Error("Feishu credentials are required");
    await sendFeishu(
      `[Agentic Stock Bot] TEST OK\n时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n模式: 通知测试，不访问钱包，不执行交易`
    );
    log("Feishu test message sent");
    return;
  }

  const config = await loadJson(configPath);
  config.symbols = uniqueSymbols(config.symbols);
  validateConfig(config);
  const statePath = resolve(projectRoot, config.stateFile);
  const tracePath = resolve(projectRoot, config.traceFile);
  const marketDataDirectory = resolve(projectRoot, config.marketDataDirectory);
  const emergencyStopPath = resolve(projectRoot, config.emergencyStopFile);
  const processLockPath = resolve(projectRoot, config.processLockFile);
  const runId = randomUUID();
  traceAction = createTracer(tracePath, { runId });
  recordMarketData = createMarketDataRecorder(marketDataDirectory, { runId });
  const state = await loadState(statePath);

  if (config.mode === "live" && process.env.BOT_LIVE !== "1") {
    throw new Error("Live mode requires BOT_LIVE=1");
  }
  if (config.mode === "live" && !feishuConfigured()) {
    throw new Error("Live mode requires Feishu credentials");
  }
  if (mockTrade) {
    await traceAction("startup", "succeeded", {
      mode: "mock",
      configuredMode: config.mode,
      walletAccess: false,
      onchainBroadcast: false
    });
    await runMockTrade(config, runId);
    return;
  }
  const processLock = await acquireProcessLock(processLockPath);
  const requestShutdown = () => {
    shutdownRequested = true;
    if (wakeLoop) wakeLoop();
  };
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);

  try {
    await ensureNotEmergencyStopped(emergencyStopPath, state);
    if (config.mode === "live") {
      await sendFeishu(
        `[Agentic Stock Bot] LIVE STARTED\n单笔上限: ${config.maxTradeUsdt} USDT\n日亏损上限: ${config.dailyLossLimitUsdt} USDT`
      );
    }

    log("Bot started", {
      mode: config.mode,
      symbols: config.symbols,
      maxTradeUsdt: config.maxTradeUsdt,
      dailyLossLimitUsdt: config.dailyLossLimitUsdt
    });
    await traceAction("startup", "succeeded", {
      mode: config.mode,
      symbols: config.symbols,
      maxTradeUsdt: config.maxTradeUsdt,
      dailyLossLimitUsdt: config.dailyLossLimitUsdt,
      maxRoundTripCostPct: config.maxRoundTripCostPct,
      executionBufferPct: config.executionBufferPct,
      estimatedRoundTripGasUsdt: config.estimatedRoundTripGasUsdt,
      minNetEdgePct: config.minNetEdgePct,
      regularOnlyEntries: config.regularOnlyEntries,
      nysePlan: nyseSessionPlan(Date.now()),
      atrPeriod: config.atrPeriod,
      entryAtrMultiplier: config.entryAtrMultiplier,
      atrStopMultiplier: config.atrStopMultiplier,
      minInitialStopPct: config.minInitialStopPct,
      maxInitialStopPct: config.maxInitialStopPct,
      profitProtectionR: config.profitProtectionR,
      trailingAtrMultiplier: config.trailingAtrMultiplier,
      finalTakeProfitR: config.finalTakeProfitR,
      signalReviewHours: config.signalReviewHours,
      signalReviewMinR: config.signalReviewMinR,
      disasterStopLossPct: config.disasterStopLossPct,
      allowUnsupportedAuditForOfficialRwa: config.allowUnsupportedAuditForOfficialRwa
    });

    do {
      try {
        await cycle(config, state, statePath, emergencyStopPath);
      } catch (error) {
        log("Cycle failed closed", { error: error.message, code: error.code });
        const failure = runtimeFailureUpdate(state, error);
        Object.assign(state, failure.patch);
        if (error.code === "EMERGENCY_STOP") {
          state.emergencyStop = await readEmergencyStop(emergencyStopPath);
          shutdownRequested = true;
        }
        if (failure.shouldNotify) {
          await notify(state, `[Agentic Stock Bot] ERROR\n${error.message}`);
        }
        await saveJson(statePath, state);
      }
      if (once || shutdownRequested) break;
      await waitForNextCycle(config.pollSeconds * 1000);
    } while (!shutdownRequested);

    await traceAction("shutdown", "succeeded", {
      reason: state.emergencyStop?.active ? "emergency_stop" : shutdownRequested ? "signal" : "once"
    });
  } catch (error) {
    if (error.code === "EMERGENCY_STOP") {
      state.emergencyStop = await readEmergencyStop(emergencyStopPath);
      state.updatedAt = new Date().toISOString();
      state.lastError = error.message;
      await saveJson(statePath, state);
      await traceAction("startup", "halted", { reason: error.message });
      log("Bot halted before startup", { error: error.message });
      return;
    }
    throw error;
  } finally {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
    await processLock.release();
  }
}

await main();
