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
  entrySymbolPolicyDecision,
  entryStatusCheckDecision,
  executionCostEstimate,
  fomcEntryBlackoutDecision,
  initialRiskDecision,
  initialStopPolicyUpdate,
  isStopLossExit,
  mergeShadowContextCandidates,
  nyseSessionPlan,
  pendingOrderAction,
  positionSignalRefreshDecision,
  rankCandidates,
  roundTripCostPct,
  shadowAtrPositionSizeDecision,
  shadowConcentrationDecision,
  shadowCorrelatedExposureDecision,
  shadowDowntrendVetoDecision,
  shadowEntryFailureDecision,
  shadowMarketRegimeDecision,
  shadowNetEdgeMarginDecision,
  shadowRegimeRelativePullbackDecision,
  shadowTrendPullbackDecision,
  shadowTrendQualityDecision,
  shadowWeakReboundVetoDecision,
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
  entryExecutionDecision,
  executableBasisDecision,
  readStrategyControl,
  STRATEGIES
} from "./strategy-lab.mjs";
import {
  summarizeWalletBalances,
  upsertWalletBalanceSnapshot
} from "./wallet-balance.mjs";
import {
  exactTokenBalance,
  isPositiveTokenAmount,
  sameTokenAmount
} from "./token-amount.mjs";
import {
  effectiveRoundTripGasEstimate,
  gasCostFromReceipt,
  noLossExitDecision,
  realizedTradePnl,
  tradeExcursionMetrics,
  updateReturnExcursion
} from "./execution-accounting.mjs";
import {
  addOpenPosition,
  entryCapacityDecision,
  findOpenPosition,
  heldPositionSymbols,
  migratePositionState,
  openPositions,
  removeOpenPosition
} from "./position-state.mjs";
import {
  buildBstocksUniverse,
  compareBstocksUniverses,
  resolveLiveAllowedAssets
} from "./bstocks-universe.mjs";
import {
  buildTheoreticalPriceObservation,
  fetchNasdaqStockQuote
} from "./theoretical-price.mjs";
import { buildExecutableBasisObservation } from "./executable-basis.mjs";
import { evaluateBstocksEligibility } from "./entry-eligibility.mjs";
import { loadNasdaqCorporateActions } from "./corporate-actions.mjs";
import { buildShadowBasisDecision } from "./shadow-basis-signal.mjs";
import { createShadowBasisTracker } from "./shadow-basis-tracker.mjs";
import { newYorkDate } from "./strategy-data.mjs";
import { rolloverRiskDay } from "./risk-day.mjs";

const execFileAsync = promisify(execFile);
const BSC_CHAIN_ID = "56";
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const API_BASE = "https://www.binance.com/bapi/defi";
const AUDIT_URL = "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit";
const BSC_RPC_URL = "https://bsc-dataseed.binance.org/";
const BNB_PRICE_URL = "https://data-api.binance.vision/api/v3/ticker/price?symbol=BNBUSDT";
const WALLET_BALANCE_REFRESH_MS = 5 * 60 * 1000;
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
let previousBstocksUniverse = null;
let previousBstocksUniverseLoaded = false;
let latestBstocksUniverseChanges = null;
let trackShadowBasisDecision = async () => false;
let latestShadowContextCandidates = [];

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

function completedEntriesToday(state, symbol, nowMs = Date.now()) {
  const date = newYorkDate(nowMs);
  return (state.shadowEntryHistory || []).filter(
    (entry) => entry.date === date && entry.symbol === symbol
  ).length;
}

function recordShadowEntry(state, symbol, nowMs = Date.now()) {
  state.shadowEntryHistory = [
    ...(state.shadowEntryHistory || []),
    {
      symbol,
      date: newYorkDate(nowMs),
      completedAt: new Date(nowMs).toISOString()
    }
  ].slice(-100);
}

function freshState(nowMs = Date.now()) {
  return {
    date: newYorkDate(nowMs),
    realizedPnlUsdt: 0,
    realizedGrossPnlUsdt: 0,
    gasCostUsdt: 0,
    roundTripGasHistoryUsdt: [],
    positions: [],
    pendingOrder: null,
    approvalRequest: null,
    cooldownUntil: {},
    initialStopHistory: [],
    quarantineUntilBySymbol: {},
    lastEntryDecisionAt: 0,
    lastSignalRefreshAt: 0,
    lastMarketStatusCheckAt: 0,
    lastMarketSession: null,
    pendingNotifications: [],
    updatedAt: null,
    lastError: null,
    lastSettingsCheckAt: 0,
    sessionWarningFor: null,
    walletBalance: null,
    shadowEntryHistory: []
  };
}

async function loadState(path) {
  try {
    return migratePositionState(await loadJson(path));
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

async function fetchPublicJson(url, options = {}) {
  return retry(async () => {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Accept-Encoding": "identity",
        "Content-Type": "application/json",
        "User-Agent": "binance-web3-stock-bot/1.0",
        ...options.headers
      }
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }, {
    attempts: 3,
    delayMs: 500,
    shouldRetry: isTransientNetworkError
  });
}

async function actualGasCostForOrder(order, fallbackGasUsdt) {
  const txHash = order?.txHash || null;
  if (!txHash) {
    return {
      txHash: null,
      gasBnb: null,
      gasUsdt: fallbackGasUsdt,
      bnbUsdtPrice: null,
      source: "ESTIMATED_FALLBACK",
      reason: "ORDER_TX_HASH_UNAVAILABLE"
    };
  }
  try {
    const [receiptResponse, priceResponse] = await Promise.all([
      fetchPublicJson(BSC_RPC_URL, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getTransactionReceipt",
          params: [txHash],
          id: 1
        })
      }),
      fetchPublicJson(BNB_PRICE_URL)
    ]);
    if (receiptResponse.error) throw new Error(receiptResponse.error.message || "BSC receipt lookup failed");
    if (!receiptResponse.result) throw new Error("BSC transaction receipt is not available");
    const bnbUsdtPrice = Number(priceResponse.price);
    if (!(bnbUsdtPrice > 0)) throw new Error("BNB/USDT price is unavailable");
    return {
      ...gasCostFromReceipt({
        receipt: receiptResponse.result,
        bnbUsdtPrice
      }),
      bnbUsdtPrice,
      source: "ACTUAL_RECEIPT",
      reason: null
    };
  } catch (error) {
    await traceAction("gas_accounting", "fallback", {
      txHash,
      fallbackGasUsdt,
      error: error.message
    }, currentCycleId);
    return {
      txHash,
      gasBnb: null,
      gasUsdt: fallbackGasUsdt,
      bnbUsdtPrice: null,
      source: "ESTIMATED_FALLBACK",
      reason: error.message
    };
  }
}

function currentGasEstimate(config, state) {
  return effectiveRoundTripGasEstimate({
    configuredGasUsdt: config.estimatedRoundTripGasUsdt,
    observations: state.roundTripGasHistoryUsdt || []
  });
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

async function resolveAssets(symbols, liveAllowlist = symbols) {
  const list = await fetchJson(`${API_BASE}/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=1`);
  const universe = buildBstocksUniverse(list, {
    chainId: BSC_CHAIN_ID,
    liveAllowlist,
    discoveredAt: new Date().toISOString()
  });
  const latestUniversePath = resolve(projectRoot, "state/instruments/latest.json");
  if (!previousBstocksUniverseLoaded) {
    previousBstocksUniverseLoaded = true;
    try {
      previousBstocksUniverse = await loadJson(latestUniversePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        await recordMarketData("asset_universe_snapshot_error", {
          cycleId: currentCycleId,
          phase: "load_previous_snapshot",
          error: error.message
        });
      }
    }
  }
  const changes = previousBstocksUniverse
    ? {
        baselineAvailable: true,
        baselineDiscoveredAt: previousBstocksUniverse.discoveredAt || null,
        ...compareBstocksUniverses(previousBstocksUniverse, universe)
      }
    : {
        baselineAvailable: false,
        baselineDiscoveredAt: null,
        addedInstrumentIds: [],
        removedInstrumentIds: [],
        contractChanges: [],
        multiplierChanges: []
      };
  latestBstocksUniverseChanges = changes;
  await recordMarketData("asset_universe_snapshot", {
    cycleId: currentCycleId,
    universe,
    changes
  });
  await saveJson(latestUniversePath, universe);
  previousBstocksUniverse = universe;
  return resolveLiveAllowedAssets(universe, symbols);
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

async function sampleShadowBasisCheckpoint({ decision }, config, estimatedRoundTripGasUsdt) {
  const instrument = decision.baseline.instrument;
  const contractAddress = instrument.contractAddress;
  const tradeUsdt = Number(decision.baseline.execution.buy.inputUsdt);
  const baselineTokenQuantity = decision.baseline.execution.buy.outputToken;
  const [underlying, dynamic, companyAction, marketStatus] = await Promise.all([
    fetchNasdaqStockQuote(instrument.underlyingSymbol),
    rwaDynamic(contractAddress),
    loadNasdaqCorporateActions(instrument.underlyingSymbol),
    assetStatus(contractAddress)
  ]);
  const dynamicRetrievedAt = new Date().toISOString();
  const theoreticalPrice = buildTheoreticalPriceObservation({
    instrument,
    underlying,
    rwaDynamic: dynamic,
    dynamicRetrievedAt
  });
  const buyQuote = await quote(tradeUsdt, USDT_ADDRESS, contractAddress, config.slippagePct);
  const sellQuote = await quote(buyQuote.toCoinAmount, contractAddress, USDT_ADDRESS, config.slippagePct);
  const baselineExitQuote = await quote(
    baselineTokenQuantity,
    contractAddress,
    USDT_ADDRESS,
    config.slippagePct
  );
  const executableBasis = buildExecutableBasisObservation({
    theoreticalPrice,
    tradeUsdt,
    buyQuote: {
      requestedInputUsdt: tradeUsdt,
      outputToken: buyQuote.toCoinAmount,
      quotedAt: buyQuote.quotedAt
    },
    sellQuote: {
      requestedInputToken: buyQuote.toCoinAmount,
      outputUsdt: sellQuote.toCoinAmount,
      quotedAt: sellQuote.quotedAt
    },
    estimatedRoundTripGasUsdt,
    executionBufferPct: config.executionBufferPct
  });

  return {
    executableBasis,
    baselineExitQuote: {
      inputToken: baselineTokenQuantity,
      outputUsdt: baselineExitQuote.toCoinAmount,
      quotedAt: baselineExitQuote.quotedAt,
      source: "AGENTIC_WALLET_AMOUNT_QUOTE"
    },
    marketStatus,
    companyAction,
    dataQuality: {
      theoreticalVetoReasons: theoreticalPrice.vetoReasons,
      theoreticalWarnings: theoreticalPrice.warnings,
      executableVetoReasons: executableBasis.vetoReasons,
      companyActionStatus: companyAction.status
    }
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
  return exactTokenBalance(balances);
}

async function refreshWalletBalance(state, statePath) {
  const now = Date.now();
  const checkedAtMs = Date.parse(state.walletBalance?.checkedAt || "");
  if (Number.isFinite(checkedAtMs) && now - checkedAtMs < WALLET_BALANCE_REFRESH_MS) return;
  try {
    state.walletBalance = summarizeWalletBalances(
      await baw(["wallet", "balance"]),
      new Date(now).toISOString()
    );
    await upsertWalletBalanceSnapshot(
      resolve(dirname(statePath), "wallet-balance-history.json"),
      state.walletBalance
    );
  } catch (error) {
    state.walletBalance = {
      ...(state.walletBalance || { totalUsd: null, assetCount: 0, checkedAt: null }),
      lastCheckFailedAt: new Date(now).toISOString()
    };
    await traceAction("wallet_balance", "failed", { error: error.message }, currentCycleId);
  }
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
    sameTokenAmount(request.fromTokenQty, details.fromTokenQty)
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
    const roundTripGasUsdt = Number.isFinite(Number(submitted.estimatedRoundTripGasUsdt))
      ? Number(submitted.estimatedRoundTripGasUsdt)
      : currentGasEstimate(config, state).gasUsdt;
    const entryGas = await actualGasCostForOrder(order, roundTripGasUsdt / 2);
    const quantity = await tokenBalance(submitted.address);
    if (!isPositiveTokenAmount(quantity)) throw new Error(`Finished BUY has no token balance for ${submitted.symbol}`);
    addOpenPosition(state, {
      symbol: submitted.symbol,
      strategyId: submitted.strategyId || DEFAULT_STRATEGY_ID,
      address: submitted.address,
      quantity,
      costBasisUsdt: submitted.costBasisUsdt,
      entryCostCoverage: submitted.costCoverage,
      initialRiskPct: submitted.initialRiskPct,
      profitFloorPct: submitted.profitFloorPct,
      entryAtr15Pct: submitted.entryAtr15Pct,
      entryShadowRisk: submitted.shadowRisk || null,
      finalTakeProfitPct: submitted.finalTakeProfitPct,
      peakReturnPct: 0,
      worstReturnPct: 0,
      excursionTrackingStartedAt: submitted.createdAt,
      excursionPartial: false,
      profitProtectionActive: false,
      trailingStopPct: null,
      openedAt: submitted.createdAt,
      orderId: submitted.orderId,
      entryTxHash: entryGas.txHash,
      entryGasBnb: entryGas.gasBnb,
      entryGasUsdt: entryGas.gasUsdt,
      entryGasSource: entryGas.source,
      shadow: false
    }, config.maxOpenPositions);
    recordShadowEntry(state, submitted.symbol);
    state.pendingOrder = null;
    await traceAction("pending_order", "finished", {
      orderId: submitted.orderId,
      side: submitted.side,
      symbol: submitted.symbol,
      quantity,
      txHash: entryGas.txHash,
      gasBnb: entryGas.gasBnb,
      gasUsdt: entryGas.gasUsdt,
      gasSource: entryGas.source
    }, currentCycleId);
    await notify(
      state,
      [
        "[Agentic Stock Bot] BUY FINISHED",
        `${submitted.symbol} ${submitted.address}`,
        `实际持仓: ${quantity}`,
        `投入: ${submitted.costBasisUsdt} USDT`,
        `入场 Gas: ${entryGas.gasUsdt.toFixed(4)} USDT (${entryGas.source})`,
        `订单: ${submitted.orderId}`
      ].join("\n")
    );
    return true;
  }

  const usdtAfter = await tokenBalance(USDT_ADDRESS);
  const proceedsUsdt = Math.max(0, Number(usdtAfter) - Number(submitted.usdtBefore));
  const roundTripGasUsdt = Number.isFinite(Number(submitted.estimatedRoundTripGasUsdt))
    ? Number(submitted.estimatedRoundTripGasUsdt)
    : currentGasEstimate(config, state).gasUsdt;
  const exitGas = await actualGasCostForOrder(order, roundTripGasUsdt / 2);
  const pnl = realizedTradePnl({
    proceedsUsdt,
    costBasisUsdt: submitted.costBasisUsdt,
    entryGasUsdt: submitted.entryGasUsdt ?? roundTripGasUsdt / 2,
    exitGasUsdt: exitGas.gasUsdt
  });
  const excursion = tradeExcursionMetrics({
    costBasisUsdt: submitted.costBasisUsdt,
    initialRiskPct: submitted.initialRiskPct,
    worstReturnPct: submitted.worstReturnPct,
    peakReturnPct: submitted.peakReturnPct,
    netPnlUsdt: pnl.netPnlUsdt
  });
  state.realizedGrossPnlUsdt = Number(state.realizedGrossPnlUsdt || 0) + pnl.grossPnlUsdt;
  state.gasCostUsdt = Number(state.gasCostUsdt || 0) + pnl.gasCostUsdt;
  state.realizedPnlUsdt += pnl.netPnlUsdt;
  if (submitted.entryGasSource === "ACTUAL_RECEIPT" && exitGas.source === "ACTUAL_RECEIPT") {
    state.roundTripGasHistoryUsdt = [
      ...(state.roundTripGasHistoryUsdt || []),
      pnl.gasCostUsdt
    ].slice(-100);
  }
  const completedAtMs = Date.now();
  state.cooldownUntil[submitted.symbol] = completedAtMs + config.reentryCooldownMinutes * 60_000;
  if (submitted.reason === "INITIAL_STOP") {
    const policy = initialStopPolicyUpdate({
      symbol: submitted.symbol,
      initialStopHistory: state.initialStopHistory,
      quarantineUntilBySymbol: state.quarantineUntilBySymbol,
      nowMs: completedAtMs
    });
    state.initialStopHistory = policy.initialStopHistory;
    state.quarantineUntilBySymbol = policy.quarantineUntilBySymbol;
  }
  removeOpenPosition(state, submitted);
  state.pendingOrder = null;
  await traceAction("pending_order", "finished", {
    orderId: submitted.orderId,
    side: submitted.side,
    symbol: submitted.symbol,
    strategyId: submitted.strategyId || DEFAULT_STRATEGY_ID,
    proceedsUsdt,
    grossPnlUsdt: pnl.grossPnlUsdt,
    gasCostUsdt: pnl.gasCostUsdt,
    realizedPnlUsdt: pnl.netPnlUsdt,
    exitReason: submitted.reason,
    ...excursion,
    excursionPartial: submitted.excursionPartial === true,
    entryTxHash: submitted.entryTxHash || null,
    exitTxHash: exitGas.txHash,
    exitGasBnb: exitGas.gasBnb,
    exitGasUsdt: exitGas.gasUsdt,
    exitGasSource: exitGas.source
  }, currentCycleId);
  await notify(
    state,
    [
      `[Agentic Stock Bot] SELL FINISHED ${submitted.reason}`,
      `${submitted.symbol} ${submitted.address}`,
      `实际回收: ${proceedsUsdt.toFixed(4)} USDT`,
      `毛盈亏: ${pnl.grossPnlUsdt.toFixed(4)} USDT`,
      `Gas: -${pnl.gasCostUsdt.toFixed(4)} USDT`,
      `本笔净盈亏: ${pnl.netPnlUsdt.toFixed(4)} USDT`,
      `当日累计已实现盈亏: ${state.realizedPnlUsdt.toFixed(4)} USDT`,
      `订单: ${submitted.orderId}`
    ].join("\n")
  );
  return true;
}

async function buildCandidate(
  symbol,
  asset,
  config,
  knownStatus = null,
  estimatedRoundTripGasUsdt = config.estimatedRoundTripGasUsdt
) {
  const strategyId = config.activeStrategyId || DEFAULT_STRATEGY_ID;
  const scanId = randomUUID();
  const status = knownStatus || await assetStatus(asset.contractAddress);
  let dataFetchedAt = new Date().toISOString();
  const marketOpen = entryMarketAllowed(
    status,
    config.regularOnlyEntries,
    Date.now(),
    config.entryCutoffMinutes
  );
  if (!marketOpen) {
    await recordMarketData("market_scan", {
      cycleId: currentCycleId,
      scanId,
      dataFetchedAt,
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
      dataFetchedAt,
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
  dataFetchedAt = new Date().toISOString();
  const signal = analyzeCandles(minuteKline);
  const atr = calculateAtrPct(atrKline, config.atrPeriod);
  const shadowDowntrendVeto = shadowDowntrendVetoDecision(atrKline, atr?.atrPct);
  const shadowTrendPullback = shadowTrendPullbackDecision({
    minuteCandles: minuteKline,
    atrCandles: atrKline,
    atr15Pct: atr?.atrPct
  });
  const shadowTrendQuality = shadowTrendQualityDecision(atrKline, atr?.atrPct);
  const requiredTrend15mPct = atr ? atr.atrPct * config.entryAtrMultiplier : null;
  const trendPassed = signal && atr
    ? signal.trend15mPct + 1e-9 >= requiredTrend15mPct && signal.upMinutes >= config.minDirectionalMinutes
    : false;
  await recordMarketData("market_scan", {
    cycleId: currentCycleId,
    scanId,
    dataFetchedAt,
    symbol,
    contractAddress: asset.contractAddress,
    marketStatus: status,
    minuteCandles: normalizeCandles(minuteKline),
    atrCandles: normalizeCandles(atrKline),
    signal,
    atr,
    shadowDowntrendVeto,
    shadowTrendPullback,
    shadowTrendQuality,
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
  await traceAction("shadow_sub_strategy", "observed", {
    strategyId,
    symbol,
    subStrategyId: shadowDowntrendVeto.id,
    decision: shadowDowntrendVeto.decision,
    reason: shadowDowntrendVeto.reason,
    enforced: shadowDowntrendVeto.enforced,
    return60mPct: shadowDowntrendVeto.return60mPct,
    return120mPct: shadowDowntrendVeto.return120mPct,
    ema8SlopePct: shadowDowntrendVeto.ema8SlopePct,
    atr15Pct: shadowDowntrendVeto.atr15Pct
  }, currentCycleId);
  await traceAction("shadow_sub_strategy", "observed", {
    strategyId,
    symbol,
    subStrategyId: shadowTrendPullback.id,
    decision: shadowTrendPullback.decision,
    reason: shadowTrendPullback.reason,
    enforced: shadowTrendPullback.enforced,
    return60mPct: shadowTrendPullback.return60mPct,
    pullbackDepthPct: shadowTrendPullback.pullbackDepthPct,
    pullbackDepthAtr: shadowTrendPullback.pullbackDepthAtr,
    minuteRecapture: shadowTrendPullback.conditions?.minuteRecapture,
    atr15Pct: shadowTrendPullback.atr15Pct
  }, currentCycleId);
  await traceAction("shadow_sub_strategy", "observed", {
    strategyId,
    symbol,
    subStrategyId: shadowTrendQuality.id,
    decision: shadowTrendQuality.decision,
    reason: shadowTrendQuality.reason,
    enforced: shadowTrendQuality.enforced,
    trendEfficiency: shadowTrendQuality.trendEfficiency,
    highVolatility: shadowTrendQuality.highVolatility,
    atr15Pct: shadowTrendQuality.atr15Pct
  }, currentCycleId);
  if (!signal) {
    await traceAction("candidate_rejected", "skipped", {
      symbol,
      dataFetchedAt,
      reason: "insufficient_closed_candles"
    }, currentCycleId);
    return null;
  }
  if (!atr) {
    await traceAction("candidate_rejected", "skipped", {
      symbol,
      dataFetchedAt,
      reason: "insufficient_closed_atr_candles"
    }, currentCycleId);
    return null;
  }

  const candidate = {
    scanId,
    symbol,
    address: asset.contractAddress,
    asset,
    dataFetchedAt,
    ...status,
    ...signal,
    atr15Pct: atr.atrPct,
    shadowDowntrendVeto,
    shadowTrendPullback,
    shadowTrendQuality
  };
  const pullbackNeedsQuote = shadowTrendPullback.decision === "WOULD_ENTER";
  if (!marketOpen || (strategyId === DEFAULT_STRATEGY_ID && !trendPassed && !pullbackNeedsQuote)) {
    await traceAction("candidate_rejected", "skipped", {
      symbol,
      dataFetchedAt,
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
    estimatedRoundTripGasUsdt
  });
  let basis = null;
  let dynamic = null;
  let dynamicRetrievedAt = null;
  let grossEdgeProxyPct = candidate.trend15mPct;
  if (strategyId === "executable-basis-reversion") {
    dynamic = await rwaDynamic(candidate.address);
    dynamicRetrievedAt = new Date().toISOString();
    basis = executableBasisDecision({
      executableBuyPrice: config.maxTradeUsdt / Number(buyQuote.toCoinAmount),
      underlyingPrice: Number(dynamic.stockInfo?.price),
      sharesMultiplier: Number(dynamic.tokenInfo?.sharesMultiplier || asset.multiplier),
      allInCostPct: executionCost.allInCostPct,
      minNetEdgePct: config.minNetEdgePct
    });
    grossEdgeProxyPct = basis.grossEdgePct;
  }
  if (config.mode === "shadow") {
    try {
      const [underlying, shadowDynamic, companyAction] = await Promise.all([
        fetchNasdaqStockQuote(symbol),
        dynamic ? Promise.resolve(dynamic) : rwaDynamic(candidate.address),
        loadNasdaqCorporateActions(symbol)
      ]);
      dynamic = shadowDynamic;
      dynamicRetrievedAt ||= new Date().toISOString();
      const theoreticalPrice = buildTheoreticalPriceObservation({
        instrument: asset,
        underlying,
        rwaDynamic: dynamic,
        dynamicRetrievedAt
      });
      await recordMarketData("theoretical_price_observation", {
        cycleId: currentCycleId,
        scanId,
        symbol,
        theoreticalPrice
      });
      const executableBasisObservation = buildExecutableBasisObservation({
        theoreticalPrice,
        tradeUsdt: config.maxTradeUsdt,
        buyQuote: {
          requestedInputUsdt: config.maxTradeUsdt,
          outputToken: buyQuote.toCoinAmount,
          quotedAt: buyQuote.quotedAt
        },
        sellQuote: {
          requestedInputToken: buyQuote.toCoinAmount,
          outputUsdt: sellQuote.toCoinAmount,
          quotedAt: sellQuote.quotedAt
        },
        estimatedRoundTripGasUsdt,
        executionBufferPct: config.executionBufferPct
      });
      await recordMarketData("executable_basis_observation", {
        cycleId: currentCycleId,
        scanId,
        symbol,
        executableBasis: executableBasisObservation
      });
      await recordMarketData("company_action_observation", {
        cycleId: currentCycleId,
        scanId,
        symbol,
        companyAction
      });
      const eligibility = evaluateBstocksEligibility({
        instrument: asset,
        universeChanges: latestBstocksUniverseChanges,
        assetStatus: status,
        statusRetrievedAt: dataFetchedAt,
        companyAction,
        theoreticalPrice,
        executableBasis: executableBasisObservation,
        maxRoundTripCostPct: config.maxRoundTripCostPct
      });
      await recordMarketData("entry_eligibility_observation", {
        cycleId: currentCycleId,
        scanId,
        symbol,
        enforced: false,
        eligibility
      });
      const shadowBasisDecision = buildShadowBasisDecision({
        signalId: randomUUID(),
        eligibility,
        executableBasis: executableBasisObservation
      });
      await recordMarketData("shadow_basis_decision", {
        cycleId: currentCycleId,
        scanId,
        symbol,
        shadowBasisDecision
      });
      await trackShadowBasisDecision(shadowBasisDecision);
    } catch (error) {
      await recordMarketData("theoretical_price_error", {
        cycleId: currentCycleId,
        scanId,
        symbol,
        instrumentId: asset.instrumentId,
        error: error.message
      });
      await traceAction("theoretical_price_observation", "failed", {
        symbol,
        error: error.message,
        enforced: false
      }, currentCycleId);
    }
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
        estimatedRoundTripGasUsdt,
        minNetEdgePct: config.minNetEdgePct
      })
    : {
        allowed: false,
        reason: initialRisk.reason,
        ...executionCost
      };
  const shadowTrendPullbackCostCoverage = (
    shadowTrendPullback.decision === "WOULD_ENTER" && initialRisk.allowed
  )
    ? costCoverageDecision({
        tradeUsdt: config.maxTradeUsdt,
        grossEdgeProxyPct: finalTakeProfitPct,
        takeProfitPct: finalTakeProfitPct,
        quotedRoundTripCostPct,
        executionBufferPct: config.executionBufferPct,
        estimatedRoundTripGasUsdt,
        minNetEdgePct: config.minNetEdgePct
      })
    : {
        allowed: false,
        reason: shadowTrendPullback.decision === "WOULD_ENTER"
          ? initialRisk.reason
          : "SHADOW_SIGNAL_NOT_ENTER"
      };
  const completed = {
    ...candidate,
    buyQuantity: buyQuote.toCoinAmount,
    buyQuotedAt: buyQuote.quotedAt,
    roundTripCostPct: quotedRoundTripCostPct,
    costCoverage,
    shadowTrendPullbackCostCoverage,
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
    shadowTrendPullbackCostCoverage,
    finalTakeProfitPct
  });
  await traceAction("candidate_evaluated", "succeeded", {
    symbol,
    dataFetchedAt,
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
    executionBufferPct: costCoverage.executionBufferPct,
    shadowDowntrendDecision: completed.shadowDowntrendVeto.decision,
    shadowDowntrendEnforced: completed.shadowDowntrendVeto.enforced,
    shadowTrendPullbackDecision: completed.shadowTrendPullback.decision,
    shadowTrendPullbackCostAllowed: completed.shadowTrendPullbackCostCoverage.allowed,
    shadowPullbackDepthAtr: completed.shadowTrendPullback.pullbackDepthAtr,
    shadowTrendQualityDecision: completed.shadowTrendQuality.decision,
    shadowTrendEfficiency: completed.shadowTrendQuality.trendEfficiency
  }, currentCycleId);
  return completed;
}

async function evaluateEntry(
  config,
  state,
  statePath,
  emergencyStopPath,
  approvedRequest = null,
  { scanOnly = false } = {}
) {
  if (!scanOnly) {
    const capacity = entryCapacityDecision(state, config.maxOpenPositions);
    if (!capacity.allowed) {
      await traceAction("entry_decision", "skipped", {
        reason: "max_open_positions",
        openPositionCount: capacity.openPositionCount,
        maxOpenPositions: capacity.maxOpenPositions
      }, currentCycleId);
      return;
    }
  }
  if (!scanOnly && dailyLossReached(state.realizedPnlUsdt, config.dailyLossLimitUsdt)) {
    await traceAction("entry_decision", "skipped", { reason: "daily_loss_limit" }, currentCycleId);
    return;
  }
  const gasEstimate = currentGasEstimate(config, state);
  const now = Date.now();
  const fomcEntryDecision = fomcEntryBlackoutDecision({
    nowMs: now,
    dates: config.fomcEntryBlackoutDates
  });
  let schedule = null;
  if (scanOnly) {
    schedule = positionSignalRefreshDecision({
      nowMs: now,
      lastSignalRefreshAt: state.lastSignalRefreshAt,
      entryIntervalMinutes: config.entryIntervalMinutes
    });
    if (!schedule.due) {
      await traceAction("signal_refresh", "skipped", {
        reason: "signal_refresh_interval",
        intervalMs: schedule.intervalMs
      }, currentCycleId);
      return;
    }
    state.lastSignalRefreshAt = now;
  } else if (!approvedRequest) {
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
  const heldSymbols = heldPositionSymbols(state);
  const eligibleSymbols = [];
  for (const symbol of symbols) {
    const symbolPolicy = entrySymbolPolicyDecision({
      symbol,
      blockedSymbols: config.entryBlockedSymbols,
      initialStopHistory: state.initialStopHistory,
      quarantineUntilBySymbol: state.quarantineUntilBySymbol,
      nowMs: now
    });
    if (!scanOnly && heldSymbols.has(symbol)) {
      await traceAction("candidate_rejected", "skipped", { symbol, reason: "already_held" }, currentCycleId);
    } else if (!scanOnly && (state.cooldownUntil[symbol] || 0) > now) {
      await traceAction("candidate_rejected", "skipped", { symbol, reason: "cooldown" }, currentCycleId);
    } else if (!scanOnly && !symbolPolicy.allowed) {
      await traceAction("candidate_rejected", "skipped", {
        symbol,
        reason: symbolPolicy.reason,
        quarantineUntil: state.quarantineUntilBySymbol?.[symbol] || null
      }, currentCycleId);
    } else {
      eligibleSymbols.push(symbol);
    }
  }
  const symbolsToScan = approvedRequest ? eligibleSymbols : symbols;
  if (symbolsToScan.length === 0) {
    await traceAction(scanOnly ? "signal_refresh" : "entry_decision", "skipped", {
      reason: "no_eligible_symbol"
    }, currentCycleId);
    return;
  }

  const assets = await resolveAssets(symbolsToScan, config.symbols);
  const statusEntries = (await Promise.all(
    symbolsToScan.map(async (symbol) => {
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
  const sessionDecision = entrySessionDecision(
    statusEntries,
    config.regularOnlyEntries,
    now,
    config.entryCutoffMinutes
  );
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
    const reason = statusEntries.length === 0 && symbolsToScan.length > 0
      ? "market_status_unavailable"
      : "non_regular_session";
    await traceAction(scanOnly ? "signal_refresh" : "entry_decision", "skipped", {
      reason,
      regularOnlyEntries: config.regularOnlyEntries,
      entryCutoffMinutes: config.entryCutoffMinutes,
      statusCount: statusEntries.length,
      nysePlan
    }, currentCycleId);
    log("Heavy entry scan skipped", { reason });
    return;
  }
  if (!approvedRequest && !scanOnly) state.lastEntryDecisionAt = now;

  const statusBySymbol = new Map(statusEntries.map(({ symbol, status }) => [symbol, status]));
  const candidates = (await Promise.all(
    sessionDecision.symbols.map(async (symbol) => {
      try {
        return await buildCandidate(
          symbol,
          assets.get(symbol),
          config,
          statusBySymbol.get(symbol),
          gasEstimate.gasUsdt
        );
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

  const shadowDecisionCandidates = mergeShadowContextCandidates(
    candidates,
    latestShadowContextCandidates
  );
  if (!approvedRequest) latestShadowContextCandidates = shadowDecisionCandidates;
  const shadowMarketRegime = shadowMarketRegimeDecision(shadowDecisionCandidates);
  const shadowRegimeRelativePullback = shadowRegimeRelativePullbackDecision(
    shadowDecisionCandidates,
    shadowMarketRegime
  );
  const relativePullbackByScanId = new Map(
    shadowRegimeRelativePullback.candidates.map((candidate) => [candidate.scanId, candidate])
  );
  const longOnlyStrategyIds = STRATEGIES
    .filter(({ direction }) => direction === "LONG_ONLY")
    .map(({ id }) => id);
  await recordMarketData("shadow_market_regime", {
    cycleId: currentCycleId,
    decision: shadowMarketRegime.decision,
    reason: shadowMarketRegime.reason,
    enforced: shadowMarketRegime.enforced,
    appliesToStrategyIds: longOnlyStrategyIds,
    conditions: shadowMarketRegime.conditions,
    benchmarkStates: shadowMarketRegime.benchmarkStates
  });
  await traceAction("shadow_market_regime", "observed", {
    decision: shadowMarketRegime.decision,
    reason: shadowMarketRegime.reason,
    enforced: shadowMarketRegime.enforced,
    appliesToStrategyIds: longOnlyStrategyIds,
    conditions: shadowMarketRegime.conditions,
    benchmarkStates: shadowMarketRegime.benchmarkStates
  }, currentCycleId);
  await recordMarketData("shadow_regime_relative_pullback", {
    cycleId: currentCycleId,
    strategyId: shadowRegimeRelativePullback.id,
    decision: shadowRegimeRelativePullback.decision,
    reason: shadowRegimeRelativePullback.reason,
    enforced: false,
    benchmarkStates: shadowRegimeRelativePullback.benchmarkStates,
    benchmarkReturn60mPct: shadowRegimeRelativePullback.benchmarkReturn60mPct,
    stockUniverseSize: shadowRegimeRelativePullback.stockUniverseSize,
    topCount: shadowRegimeRelativePullback.topCount,
    signalCount: shadowRegimeRelativePullback.signalCount,
    candidates: shadowRegimeRelativePullback.candidates
  });
  await traceAction("shadow_strategy", "observed", {
    strategyId: shadowRegimeRelativePullback.id,
    decision: shadowRegimeRelativePullback.decision,
    reason: shadowRegimeRelativePullback.reason,
    enforced: false,
    benchmarkReturn60mPct: shadowRegimeRelativePullback.benchmarkReturn60mPct,
    stockUniverseSize: shadowRegimeRelativePullback.stockUniverseSize,
    topCount: shadowRegimeRelativePullback.topCount,
    signalCount: shadowRegimeRelativePullback.signalCount
  }, currentCycleId);
  const openSymbolsForShadow = [...heldPositionSymbols(state)];
  await Promise.all(candidates.map(async (candidate) => {
    candidate.shadowMarketRegime = shadowMarketRegime;
    const relativePullback = relativePullbackByScanId.get(candidate.scanId) || {
      decision: "INSUFFICIENT_DATA",
      reason: "CANDIDATE_NOT_RANKED"
    };
    const relativePullbackPositionSize = shadowAtrPositionSizeDecision({
      maxTradeUsdt: config.maxTradeUsdt,
      initialRiskPct: Number(candidate.initialRiskPct),
      targetRiskPct: config.minInitialStopPct
    });
    candidate.shadowRegimeRelativePullback = {
      ...relativePullback,
      strategyId: shadowRegimeRelativePullback.id,
      costAllowed: relativePullback.conditions?.costCovered === true,
      benchmarkStates: shadowRegimeRelativePullback.benchmarkStates,
      positionSize: relativePullbackPositionSize
    };
    candidate.shadowWeakReboundVeto = shadowWeakReboundVetoDecision({
      return60mPct: candidate.shadowDowntrendVeto?.return60mPct,
      ema8SlopePct: candidate.shadowDowntrendVeto?.ema8SlopePct,
      trendEfficiency: candidate.shadowTrendQuality?.trendEfficiency,
      relativeStrengthRank: relativePullback.relativeStrengthRank,
      stockUniverseSize: relativePullback.stockUniverseSize
    });
    candidate.shadowNetEdgeMargin = shadowNetEdgeMarginDecision({
      netEdgeProxyPct: candidate.costCoverage?.netEdgeProxyPct
    });
    candidate.shadowCorrelatedExposure = shadowCorrelatedExposureDecision({
      symbol: candidate.symbol,
      openSymbols: openSymbolsForShadow
    });
    await recordMarketData("shadow_candidate_comparison", {
      cycleId: currentCycleId,
      scanId: candidate.scanId,
      symbol: candidate.symbol,
      adaptiveMomentum: {
        decision: (
          candidate.trend15mPct + 1e-9 >= candidate.atr15Pct * config.entryAtrMultiplier &&
          candidate.upMinutes >= config.minDirectionalMinutes
        ) ? "SIGNAL" : "NO_SIGNAL",
        costAllowed: candidate.costCoverage?.allowed === true
      },
      trendPullbackConfirmation: {
        decision: candidate.shadowTrendPullback.decision,
        reason: candidate.shadowTrendPullback.reason,
        costAllowed: candidate.shadowTrendPullbackCostCoverage?.allowed === true
      },
      marketRegime: {
        decision: shadowMarketRegime.decision,
        reason: shadowMarketRegime.reason,
        enforced: false
      },
      regimeRelativePullbackMomentum: candidate.shadowRegimeRelativePullback,
      weakReboundVeto: candidate.shadowWeakReboundVeto,
      netEdgeMargin: candidate.shadowNetEdgeMargin,
      correlatedExposure: candidate.shadowCorrelatedExposure
    });
  }));

  if (scanOnly) {
    await traceAction("signal_refresh", "succeeded", {
      symbolCount: sessionDecision.symbols.length,
      candidateCount: candidates.length,
      tradingEnabled: false
    }, currentCycleId);
    log("Position-time signal refresh completed", {
      symbolCount: sessionDecision.symbols.length
    });
    return;
  }

  if (!fomcEntryDecision.allowed) {
    await traceAction("entry_decision", "skipped", {
      reason: fomcEntryDecision.reason,
      nyseDate: fomcEntryDecision.nyseDate,
      startTime: fomcEntryDecision.startTime,
      endTime: fomcEntryDecision.endTime,
      approvedRequestInvalidated: Boolean(approvedRequest)
    }, currentCycleId);
    if (approvedRequest) {
      await notify(
        state,
        `[Agentic Stock Bot] BUY APPROVAL INVALIDATED\n${approvedRequest.symbol} ${approvedRequest.address}\nFOMC 日 ${fomcEntryDecision.startTime}-${fomcEntryDecision.endTime} ET 禁止新开仓；现有持仓退出仍正常运行。`
      );
    }
    log("New entry blocked during FOMC decision window", {
      nyseDate: fomcEntryDecision.nyseDate,
      startTime: fomcEntryDecision.startTime,
      endTime: fomcEntryDecision.endTime
    });
    return;
  }

  const eligibleSymbolSet = new Set(eligibleSymbols);
  const entryCandidates = candidates.filter((candidate) => eligibleSymbolSet.has(candidate.symbol));
  const selected = config.activeStrategyId === "executable-basis-reversion"
    ? entryCandidates.filter((candidate) => candidate.costCoverage?.allowed)
      .sort((left, right) => right.costCoverage.netEdgeProxyPct - left.costCoverage.netEdgeProxyPct)[0]
    : rankCandidates(entryCandidates, config)[0];
  if (!selected) {
    await traceAction("entry_decision", "skipped", { reason: "no_candidate_passed" }, currentCycleId);
    log("No entry candidate passed all gates");
    return;
  }

  const shadowConcentration = shadowConcentrationDecision({
    symbol: selected.symbol,
    completedEntriesToday: completedEntriesToday(state, selected.symbol, now)
  });
  const shadowPositionSize = shadowAtrPositionSizeDecision({
    maxTradeUsdt: config.maxTradeUsdt,
    initialRiskPct: selected.initialRiskPct,
    targetRiskPct: config.minInitialStopPct
  });
  const shadowRisk = {
    mode: "SHADOW",
    enforced: false,
    concentration: shadowConcentration,
    trendQuality: selected.shadowTrendQuality,
    positionSize: shadowPositionSize,
    weakRebound: selected.shadowWeakReboundVeto,
    netEdgeMargin: selected.shadowNetEdgeMargin,
    correlatedExposure: selected.shadowCorrelatedExposure
  };
  await traceAction("shadow_risk_overlay", "observed", {
    symbol: selected.symbol,
    concentrationDecision: shadowConcentration.decision,
    completedEntriesToday: shadowConcentration.completedEntriesToday,
    trendQualityDecision: selected.shadowTrendQuality.decision,
    trendEfficiency: selected.shadowTrendQuality.trendEfficiency,
    positionSizeDecision: shadowPositionSize.decision,
    liveTradeUsdt: shadowPositionSize.liveTradeUsdt,
    suggestedTradeUsdt: shadowPositionSize.suggestedTradeUsdt,
    weakReboundDecision: selected.shadowWeakReboundVeto.decision,
    weakReboundMatchedConditions: selected.shadowWeakReboundVeto.matchedConditions,
    netEdgeMarginDecision: selected.shadowNetEdgeMargin.decision,
    correlatedExposureDecision: selected.shadowCorrelatedExposure.decision,
    correlatedOpenSymbols: selected.shadowCorrelatedExposure.correlatedOpenSymbols,
    enforced: false
  }, currentCycleId);
  await traceAction("candidate_selected", "succeeded", {
    symbol: selected.symbol,
    dataFetchedAt: selected.dataFetchedAt,
    trend15mPct: selected.trend15mPct,
    upMinutes: selected.upMinutes,
    roundTripCostPct: selected.roundTripCostPct,
    costCoverageAllowed: selected.costCoverage.allowed,
    costCoverageReason: selected.costCoverage.reason,
    allInCostPct: selected.costCoverage.allInCostPct,
    netEdgeProxyPct: selected.costCoverage.netEdgeProxyPct,
    atr15Pct: selected.atr15Pct,
    initialRiskPct: selected.initialRiskPct,
    finalTakeProfitPct: selected.finalTakeProfitPct,
    shadowConcentrationDecision: shadowConcentration.decision,
    shadowCompletedEntriesToday: shadowConcentration.completedEntriesToday,
    shadowTrendQualityDecision: selected.shadowTrendQuality.decision,
    shadowTrendEfficiency: selected.shadowTrendQuality.trendEfficiency,
    shadowPositionSizeDecision: shadowPositionSize.decision,
    shadowSuggestedTradeUsdt: shadowPositionSize.suggestedTradeUsdt,
    shadowWeakReboundDecision: selected.shadowWeakReboundVeto.decision,
    shadowNetEdgeMarginDecision: selected.shadowNetEdgeMargin.decision,
    shadowCorrelatedExposureDecision: selected.shadowCorrelatedExposure.decision
  }, currentCycleId);
  const auditResult = await audit(selected.asset, config);
  if (config.mode === "live" && !feishuConfigured()) {
    throw new Error("Feishu credentials are required in live mode");
  }

  const usdtBefore = await tokenBalance(USDT_ADDRESS);
  if (Number(usdtBefore) < config.maxTradeUsdt) throw new Error(`Insufficient USDT: ${usdtBefore}`);
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
    estimatedRoundTripGasUsdt: gasEstimate.gasUsdt
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
    estimatedRoundTripGasUsdt: gasEstimate.gasUsdt,
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
    estimatedRoundTripGasUsdt: gasEstimate.gasUsdt,
    gasEstimateSource: gasEstimate.source,
    gasEstimateSampleCount: gasEstimate.sampleCount,
    initialRiskPct: freshInitialRisk.initialRiskPct,
    profitFloorPct: freshProfitFloorPct,
    entryAtr15Pct: selected.atr15Pct,
    shadowRisk,
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
  const liveEntryControl = await readStrategyControl(
    resolve(projectRoot, config.strategyControlFile),
    config.defaultStrategyId
  );
  config.activeStrategyId = liveEntryControl.strategyId;
  const liveEntryDecision = entryExecutionDecision({
    entriesPaused: liveEntryControl.entriesPaused,
    side: "BUY"
  });
  if (!liveEntryDecision.allowed) {
    await traceAction("entry_decision", "skipped", {
      reason: "entries_paused",
      symbol: selected.symbol,
      approvedRequestInvalidated: Boolean(approvedRequest)
    }, currentCycleId);
    if (approvedRequest) {
      await notify(
        state,
        `[Agentic Stock Bot] BUY APPROVAL INVALIDATED\n${selected.symbol} ${selected.address}\n新开仓已暂停；现有持仓退出和 Shadow 监控继续运行。`
      );
    }
    return;
  }
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
    addOpenPosition(state, {
      symbol: selected.symbol,
      strategyId: selected.strategyId || DEFAULT_STRATEGY_ID,
      address: selected.address,
      quantity: freshBuyQuote.toCoinAmount,
      costBasisUsdt: config.maxTradeUsdt,
      entryCostCoverage: freshCostCoverage,
      initialRiskPct: freshInitialRisk.initialRiskPct,
      profitFloorPct: freshProfitFloorPct,
      entryAtr15Pct: selected.atr15Pct,
      entryShadowRisk: shadowRisk,
      finalTakeProfitPct: freshFinalTakeProfitPct,
      peakReturnPct: 0,
      worstReturnPct: 0,
      excursionTrackingStartedAt: createdAt,
      excursionPartial: false,
      profitProtectionActive: false,
      trailingStopPct: null,
      openedAt: createdAt,
      orderId: result.orderId,
      entryTxHash: null,
      entryGasBnb: null,
      entryGasUsdt: gasEstimate.gasUsdt / 2,
      entryGasSource: "ESTIMATED_SHADOW",
      shadow: true
    }, config.maxOpenPositions);
    recordShadowEntry(state, selected.symbol);
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
    gasEstimateUsdt: gasEstimate.gasUsdt,
    gasEstimateSource: gasEstimate.source,
    gasEstimateSampleCount: gasEstimate.sampleCount,
    shadowRegimeRelativePullbackDecision: selected.shadowRegimeRelativePullback?.decision || null,
    shadowRegimeRelativePullbackReason: selected.shadowRegimeRelativePullback?.reason || null,
    shadowRegimeRelativePullbackRank: selected.shadowRegimeRelativePullback?.relativeStrengthRank ?? null,
    shadowRegimeRelativePullbackReturn60mPct: (
      selected.shadowRegimeRelativePullback?.benchmarkRelativeReturn60mPct ?? null
    ),
    shadowRegimeRelativePullbackBenchmarkStates: (
      selected.shadowRegimeRelativePullback?.benchmarkStates || null
    ),
    shadowRisk,
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

async function evaluateExit(config, state, statePath, emergencyStopPath, position, approvedRequest = null) {
  if (!position) return;
  const gasEstimate = currentGasEstimate(config, state);

  const quantity = position.shadow ? String(position.quantity) : await tokenBalance(position.address);
  if (!isPositiveTokenAmount(quantity)) throw new Error(`Position balance missing for ${position.symbol}`);
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
  const excursion = updateReturnExcursion(position, returnPct);
  if (position.worstReturnPct == null) {
    position.excursionTrackingStartedAt = new Date().toISOString();
    position.excursionPartial = true;
  }
  position.worstReturnPct = excursion.worstReturnPct;
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
  const heldMs = Math.max(0, Date.now() - Date.parse(position.openedAt));
  const shadowEntryFailure = shadowEntryFailureDecision({
    heldMs,
    signalValid,
    peakReturnPct: excursion.peakReturnPct,
    returnPct,
    initialRiskPct: Number(position.initialRiskPct),
    priorConfirmationCount: position.shadowEntryFailure?.confirmationCount
  });
  const entryGasUsdt = Number.isFinite(Number(position.entryGasUsdt))
    ? Number(position.entryGasUsdt)
    : gasEstimate.gasUsdt / 2;
  const estimatedExitGasUsdt = gasEstimate.gasUsdt / 2;
  const estimatedNetPnlUsdt = proceedsUsdt - Number(position.costBasisUsdt) - entryGasUsdt - estimatedExitGasUsdt;
  const initialRiskUsdt = Number(position.costBasisUsdt) * Number(position.initialRiskPct) / 100;
  const previousShadowEntryFailure = position.shadowEntryFailure;
  if (
    ["WOULD_EXIT", "WOULD_HOLD"].includes(shadowEntryFailure.decision)
  ) {
    position.shadowEntryFailure = {
      ...shadowEntryFailure,
      observedAt: new Date().toISOString()
    };
    if (
      shadowEntryFailure.decision !== previousShadowEntryFailure?.decision ||
      shadowEntryFailure.reason !== previousShadowEntryFailure?.reason
    ) {
      await traceAction("shadow_exit_counterfactual", "observed", {
        symbol: position.symbol,
        strategyId: position.strategyId || DEFAULT_STRATEGY_ID,
        subStrategyId: shadowEntryFailure.id,
        decision: shadowEntryFailure.decision,
        reason: shadowEntryFailure.reason,
        enforced: false,
        heldMinutes: shadowEntryFailure.heldMinutes,
        returnPct,
        returnR: shadowEntryFailure.returnR,
        executableProceedsUsdt: proceedsUsdt,
        entryGasUsdt,
        estimatedExitGasUsdt,
        estimatedNetPnlUsdt,
        estimatedNetR: initialRiskUsdt > 0 ? estimatedNetPnlUsdt / initialRiskUsdt : null,
        quoteTimestamp: sellQuote.quotedAt,
        peakReturnPct: excursion.peakReturnPct,
        mfeR: shadowEntryFailure.mfeR,
        signalValid,
        confirmationCount: shadowEntryFailure.confirmationCount,
        conditions: shadowEntryFailure.conditions
      }, currentCycleId);
    }
  }
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
    executableSellPrice: proceedsUsdt / Number(quantity),
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
  position.worstReturnPct = updateReturnExcursion(position, confirmedReturnPct).worstReturnPct;
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
    executableSellPrice: confirmedProceedsUsdt / Number(quantity),
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
  const noLoss = noLossExitDecision({
    proceedsUsdt: confirmedProceedsUsdt,
    costBasisUsdt: position.costBasisUsdt,
    entryGasUsdt: position.entryGasUsdt ?? gasEstimate.gasUsdt / 2,
    exitGasUsdt: gasEstimate.gasUsdt,
    slippagePct: config.slippagePct
  });
  const stopLossExit = isStopLossExit(confirmedReason.type);
  if (!noLoss.allowed && !stopLossExit) {
    await traceAction("exit_decision", "skipped", {
      symbol: position.symbol,
      reason: "no_loss_floor",
      proceedsUsdt: confirmedProceedsUsdt,
      worstCaseProceedsUsdt: noLoss.worstCaseProceedsUsdt,
      estimatedNetPnlUsdt: noLoss.netPnlUsdt,
      slippagePct: config.slippagePct,
      entryGasUsdt: position.entryGasUsdt ?? gasEstimate.gasUsdt / 2,
      exitGasReserveUsdt: gasEstimate.gasUsdt
    }, currentCycleId);
    log("Exit blocked by no-loss floor", {
      symbol: position.symbol,
      proceedsUsdt: confirmedProceedsUsdt,
      estimatedNetPnlUsdt: noLoss.netPnlUsdt
    });
    return;
  }
  if (!noLoss.allowed) {
    await traceAction("exit_decision", "allowed", {
      symbol: position.symbol,
      reason: "stop_loss_override",
      exitType: confirmedReason.type,
      estimatedNetPnlUsdt: noLoss.netPnlUsdt
    }, currentCycleId);
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
    estimatedRoundTripGasUsdt: gasEstimate.gasUsdt,
    gasEstimateSource: gasEstimate.source,
    gasEstimateSampleCount: gasEstimate.sampleCount,
    entryTxHash: position.entryTxHash || null,
    entryGasBnb: position.entryGasBnb ?? null,
    entryGasUsdt: position.entryGasUsdt ?? gasEstimate.gasUsdt / 2,
    entryGasSource: position.entryGasSource || "ESTIMATED_FALLBACK",
    initialRiskPct: position.initialRiskPct,
    peakReturnPct: confirmedReason.peakReturnPct,
    worstReturnPct: position.worstReturnPct,
    excursionTrackingStartedAt: position.excursionTrackingStartedAt || null,
    excursionPartial: position.excursionPartial === true,
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
  let shadowExcursion = null;
  if (result.shadow) {
    const pnl = realizedTradePnl({
      proceedsUsdt: confirmedProceedsUsdt,
      costBasisUsdt: position.costBasisUsdt,
      entryGasUsdt: position.entryGasUsdt ?? gasEstimate.gasUsdt / 2,
      exitGasUsdt: gasEstimate.gasUsdt / 2
    });
    shadowExcursion = tradeExcursionMetrics({
      costBasisUsdt: position.costBasisUsdt,
      initialRiskPct: position.initialRiskPct,
      worstReturnPct: position.worstReturnPct,
      peakReturnPct: confirmedReason.peakReturnPct,
      netPnlUsdt: pnl.netPnlUsdt
    });
    state.realizedGrossPnlUsdt = Number(state.realizedGrossPnlUsdt || 0) + pnl.grossPnlUsdt;
    state.gasCostUsdt = Number(state.gasCostUsdt || 0) + pnl.gasCostUsdt;
    state.realizedPnlUsdt += pnl.netPnlUsdt;
    const completedAtMs = Date.now();
    state.cooldownUntil[position.symbol] = completedAtMs + config.reentryCooldownMinutes * 60_000;
    if (confirmedReason.type === "INITIAL_STOP") {
      const policy = initialStopPolicyUpdate({
        symbol: position.symbol,
        initialStopHistory: state.initialStopHistory,
        quarantineUntilBySymbol: state.quarantineUntilBySymbol,
        nowMs: completedAtMs
      });
      state.initialStopHistory = policy.initialStopHistory;
      state.quarantineUntilBySymbol = policy.quarantineUntilBySymbol;
    }
    removeOpenPosition(state, position);
  }
  await traceAction("sell_submission", result.shadow ? "simulated" : "submitted", {
    symbol: position.symbol,
    strategyId: position.strategyId || DEFAULT_STRATEGY_ID,
    address: position.address,
    reason: confirmedReason.type,
    expectedProceedsUsdt: confirmedProceedsUsdt,
    realizedPnlUsdt: result.shadow
      ? realizedTradePnl({
          proceedsUsdt: confirmedProceedsUsdt,
          costBasisUsdt: position.costBasisUsdt,
          entryGasUsdt: position.entryGasUsdt ?? gasEstimate.gasUsdt / 2,
          exitGasUsdt: gasEstimate.gasUsdt / 2
        }).netPnlUsdt
      : null,
    returnPct: confirmedReason.returnPct,
    initialRiskPct: position.initialRiskPct,
    atr15Pct: atr.atrPct,
    trailingStopPct: confirmedReason.trailingStopPct,
    profitFloorPct,
    ...(shadowExcursion || tradeExcursionMetrics({
      costBasisUsdt: position.costBasisUsdt,
      initialRiskPct: position.initialRiskPct,
      worstReturnPct: position.worstReturnPct,
      peakReturnPct: confirmedReason.peakReturnPct,
      netPnlUsdt: null
    })),
    excursionPartial: position.excursionPartial === true,
    orderId: result.orderId
  }, currentCycleId);
  await notify(
    state,
    [
      `[Agentic Stock Bot] SELL SUBMITTED ${config.mode.toUpperCase()} ${confirmedReason.type}`,
      `${position.symbol} ${position.address}`,
      `预计回收: ${confirmedProceedsUsdt.toFixed(4)} USDT`,
      `预计净盈亏: ${(confirmedProceedsUsdt - position.costBasisUsdt - gasEstimate.gasUsdt).toFixed(4)} USDT`,
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
  if (request.side === "BUY") {
    const strategyControl = await readStrategyControl(
      resolve(projectRoot, config.strategyControlFile),
      config.defaultStrategyId
    );
    config.activeStrategyId = strategyControl.strategyId;
    const entryDecision = entryExecutionDecision({
      entriesPaused: strategyControl.entriesPaused,
      side: request.side
    });
    if (!entryDecision.allowed) {
      state.approvalRequest = null;
      state.lastApprovalDecision = {
        approvalId: request.approvalId,
        side: request.side,
        symbol: request.symbol,
        status: entryDecision.reason,
        decidedAt: new Date().toISOString()
      };
      await saveJson(statePath, state);
      await traceAction("trade_approval", "closed", {
        approvalId: request.approvalId,
        side: request.side,
        symbol: request.symbol,
        outcome: entryDecision.reason
      }, currentCycleId);
      await notify(
        state,
        `[Agentic Stock Bot] BUY APPROVAL ENTRIES_PAUSED\n${request.symbol} ${request.address}\n未执行链上交易；现有持仓退出和 Shadow 监控继续运行。`
      );
      return true;
    }
  }
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
    const capacity = entryCapacityDecision(state, config.maxOpenPositions);
    if (!capacity.allowed) {
      throw new Error(`Approved BUY blocked because ${capacity.openPositionCount} positions are already open`);
    }
    if (findOpenPosition(state, { symbol: request.symbol })) {
      throw new Error(`Approved BUY blocked because ${request.symbol} is already held`);
    }
    await evaluateEntry(config, state, statePath, emergencyStopPath, request);
    return true;
  }
  const position = findOpenPosition(state, {
    symbol: request.symbol,
    address: request.address
  });
  if (!position) throw new Error("Approved SELL blocked because the position no longer exists");
  await evaluateExit(config, state, statePath, emergencyStopPath, position, request);
  return true;
}

async function cycle(config, state, statePath, emergencyStopPath) {
  currentCycleId = randomUUID();
  const riskDay = rolloverRiskDay(state);
  if (riskDay.changed) {
    state.updatedAt = new Date().toISOString();
    await saveJson(statePath, state);
    await traceAction("risk_day_rollover", "succeeded", {
      previousDate: riskDay.previousDate,
      currentDate: riskDay.currentDate,
      resetFields: ["realizedPnlUsdt", "realizedGrossPnlUsdt", "gasCostUsdt"],
      positionCount: openPositions(state).length,
      hasPendingOrder: Boolean(state.pendingOrder),
      hasApprovalRequest: Boolean(state.approvalRequest)
    }, currentCycleId);
  }
  const positionCount = openPositions(state).length;
  await traceAction("cycle", "started", {
    hasPosition: positionCount > 0,
    positionCount,
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
    await refreshWalletBalance(state, statePath);

    if (state.pendingOrder) {
      await finalizePendingOrder(config, state, statePath);
    } else if (state.approvalRequest) {
      await processTradeApproval(config, state, statePath, emergencyStopPath);
    } else {
      let monitoringError = null;
      for (const position of [...openPositions(state)]) {
        try {
          await evaluateExit(config, state, statePath, emergencyStopPath, position);
        } catch (error) {
          monitoringError ||= error;
          await traceAction("position_monitoring", "failed", {
            symbol: position.symbol,
            address: position.address,
            error: error.message
          }, currentCycleId);
        }
        if (state.pendingOrder || state.approvalRequest) break;
      }
      if (monitoringError) throw monitoringError;
      if (!state.pendingOrder && !state.approvalRequest) {
        const strategyControl = await readStrategyControl(
          resolve(projectRoot, config.strategyControlFile),
          config.defaultStrategyId
        );
        config.activeStrategyId = strategyControl.strategyId;
        const capacity = entryCapacityDecision(state, config.maxOpenPositions);
        const entryDecision = entryExecutionDecision({
          entriesPaused: strategyControl.entriesPaused,
          side: "BUY"
        });
        await evaluateEntry(
          config,
          state,
          statePath,
          emergencyStopPath,
          null,
          { scanOnly: !entryDecision.allowed || !capacity.allowed }
        );
      }
    }
    state.updatedAt = new Date().toISOString();
    state.lastError = null;
    state.lastFailureFingerprint = null;
    await saveJson(statePath, state);
    const savedPositionCount = openPositions(state).length;
    await traceAction("state_saved", "succeeded", {
      hasPosition: savedPositionCount > 0,
      positionCount: savedPositionCount,
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
    const asset = (await resolveAssets([symbol], config.symbols)).get(symbol);
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
  let shadowBasisTracker = null;

  try {
    if (config.mode === "shadow") {
      shadowBasisTracker = createShadowBasisTracker({
        statePath: resolve(dirname(statePath), "shadow-basis-tracker.json"),
        sample: ({ decision, horizonMs, dueAt }) => sampleShadowBasisCheckpoint(
          { decision, horizonMs, dueAt },
          config,
          currentGasEstimate(config, state).gasUsdt
        ),
        record: ({ recordType, ...checkpoint }) => recordMarketData(recordType, checkpoint)
      });
      await shadowBasisTracker.start();
      trackShadowBasisDecision = (decision) => shadowBasisTracker.track(decision);
    }
    await ensureNotEmergencyStopped(emergencyStopPath, state);
    if (config.mode === "live") {
      await sendFeishu(
        `[Agentic Stock Bot] LIVE STARTED\n单笔上限: ${config.maxTradeUsdt} USDT\n最大同时持仓: ${config.maxOpenPositions}\n日亏损上限: ${config.dailyLossLimitUsdt} USDT`
      );
    }

    log("Bot started", {
      mode: config.mode,
      symbols: config.symbols,
      maxTradeUsdt: config.maxTradeUsdt,
      maxOpenPositions: config.maxOpenPositions,
      dailyLossLimitUsdt: config.dailyLossLimitUsdt
    });
    await traceAction("startup", "succeeded", {
      mode: config.mode,
      symbols: config.symbols,
      maxTradeUsdt: config.maxTradeUsdt,
      maxOpenPositions: config.maxOpenPositions,
      dailyLossLimitUsdt: config.dailyLossLimitUsdt,
      maxRoundTripCostPct: config.maxRoundTripCostPct,
      executionBufferPct: config.executionBufferPct,
      estimatedRoundTripGasUsdt: config.estimatedRoundTripGasUsdt,
      minNetEdgePct: config.minNetEdgePct,
      regularOnlyEntries: config.regularOnlyEntries,
      entryCutoffMinutes: config.entryCutoffMinutes,
      entryBlockedSymbols: config.entryBlockedSymbols,
      fomcEntryBlackoutDates: config.fomcEntryBlackoutDates,
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
    trackShadowBasisDecision = async () => false;
    if (shadowBasisTracker) await shadowBasisTracker.stop();
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
    await processLock.release();
  }
}

await main();
