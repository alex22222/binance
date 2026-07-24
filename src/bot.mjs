import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  analyzeCandles,
  auditDecision,
  dailyLossReached,
  exitReason,
  pendingOrderAction,
  rankCandidates,
  roundTripCostPct,
  uniqueSymbols,
  validateConfig
} from "./strategy.mjs";
import { createTracer } from "./trace.mjs";

const execFileAsync = promisify(execFile);
const BSC_CHAIN_ID = "56";
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const API_BASE = "https://www.binance.com/bapi/defi";
const AUDIT_URL = "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit";
const once = process.argv.includes("--once");
const testFeishu = process.argv.includes("--test-feishu");
const projectRoot = resolve(import.meta.dirname, "..");
const configPath = resolve(projectRoot, process.env.BOT_CONFIG || "config.json");
let feishuTokenCache = null;
let traceAction = async () => {};
let currentCycleId = null;

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
    cooldownUntil: {},
    lastEntryDecisionAt: 0,
    pendingNotifications: []
  };
}

async function loadState(path) {
  try {
    const state = await loadJson(path);
    if (state.date === shanghaiDate()) return state;
    return {
      ...freshState(),
      position: state.position,
      pendingOrder: state.pendingOrder
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
    const response = await fetch(url, {
      ...options,
      headers: {
        "Accept-Encoding": "identity",
        "User-Agent": "binance-web3-stock-bot/1.0",
        ...options.headers
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${endpoint}`);
    const body = await response.json();
    if (body.success !== true) throw new Error(body.message || body.messageDetail || `API error ${body.code}`);
    await traceAction("external_api_call", "succeeded", { endpoint, method: options.method || "GET" }, currentCycleId);
    return body.data;
  } catch (error) {
    await traceAction("external_api_call", "failed", { endpoint, method: options.method || "GET", error: error.message }, currentCycleId);
    throw error;
  }
}

async function baw(args) {
  const operation = args.slice(0, 2).join(" ");
  await traceAction("wallet_cli", "started", { operation }, currentCycleId);
  const nodeOptions = process.env.NODE_OPTIONS?.includes("--use-env-proxy")
    ? process.env.NODE_OPTIONS
    : [process.env.NODE_OPTIONS, "--use-env-proxy"].filter(Boolean).join(" ");
  try {
    const { stdout } = await execFileAsync("baw", [...args, "--json"], {
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      maxBuffer: 1024 * 1024
    });
    const result = JSON.parse(stdout);
    if (!result.success) throw new Error(`${result.error?.name || "BAW_ERROR"}: ${result.error?.message || "Command failed"}`);
    await traceAction("wallet_cli", "succeeded", { operation }, currentCycleId);
    return result.data;
  } catch (error) {
    await traceAction("wallet_cli", "failed", { operation, error: error.message }, currentCycleId);
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

async function feishuTenantToken() {
  if (feishuTokenCache?.expiresAt > Date.now() + 60_000) return feishuTokenCache.token;
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET
    })
  });
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
  await traceAction("feishu_notification", "started", { messageLength: text.length }, currentCycleId);
  if (process.env.FEISHU_WEBHOOK_URL) {
    const response = await fetch(process.env.FEISHU_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } })
    });
    if (!response.ok) throw new Error(`Feishu webhook failed: HTTP ${response.status}`);
    await traceAction("feishu_notification", "succeeded", { channel: "webhook", messageLength: text.length }, currentCycleId);
    return;
  }

  const receiveId = process.env.FEISHU_RECEIVE_ID;
  const receiveIdType = feishuReceiveIdType(receiveId);
  const token = await feishuTenantToken();
  const response = await fetch(
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
        content: JSON.stringify({ text })
      })
    }
  );
  const body = await response.json();
  if (!response.ok || body.code !== 0) {
    throw new Error(`Feishu message failed: ${body.code ?? response.status} ${body.msg || ""}`.trim());
  }
  await traceAction("feishu_notification", "succeeded", { channel: "app", messageLength: text.length }, currentCycleId);
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
    await traceAction("feishu_notification", "failed", { error: error.message, messageLength: text.length }, currentCycleId);
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

async function candles(address) {
  const data = await fetchJson(`${API_BASE}/v1/public/wallet-direct/buw/wallet/dex/market/token/kline/ai?chainId=${BSC_CHAIN_ID}&contractAddress=${address}&interval=1m&limit=31`);
  return data.klineInfos || [];
}

async function quote(fromTokenQty, fromToken, toToken) {
  return baw([
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
    "0.5"
  ]);
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
  ]);
}

async function marketOrder(orderId) {
  const data = await baw(["market-order", "list", "--orderId", String(orderId)]);
  return data.list?.[0] || null;
}

async function finalizePendingOrder(config, state) {
  const pending = state.pendingOrder;
  if (!pending) return false;
  const order = await marketOrder(pending.orderId);
  const action = pendingOrderAction(order?.status);
  if (action === "WAIT") {
    await traceAction("pending_order", "waiting", { orderId: pending.orderId, side: pending.side }, currentCycleId);
    log("Order is still pending", { orderId: pending.orderId, side: pending.side });
    return true;
  }

  if (action === "FAIL") {
    await traceAction("pending_order", "failed", { orderId: pending.orderId, side: pending.side }, currentCycleId);
    state.pendingOrder = null;
    await notify(
      state,
      `[Agentic Stock Bot] ORDER FAILED\n${pending.side} ${pending.symbol}\n订单: ${pending.orderId}`
    );
    return true;
  }

  if (pending.side === "BUY") {
    const quantity = await tokenBalance(pending.address);
    if (!(quantity > 0)) throw new Error(`Finished BUY has no token balance for ${pending.symbol}`);
    state.position = {
      symbol: pending.symbol,
      address: pending.address,
      quantity,
      costBasisUsdt: pending.costBasisUsdt,
      openedAt: pending.createdAt,
      orderId: pending.orderId,
      shadow: false
    };
    state.pendingOrder = null;
    await traceAction("pending_order", "finished", {
      orderId: pending.orderId,
      side: pending.side,
      symbol: pending.symbol,
      quantity
    }, currentCycleId);
    await notify(
      state,
      [
        "[Agentic Stock Bot] BUY FINISHED",
        `${pending.symbol} ${pending.address}`,
        `实际持仓: ${quantity}`,
        `投入: ${pending.costBasisUsdt} USDT`,
        `订单: ${pending.orderId}`
      ].join("\n")
    );
    return true;
  }

  const usdtAfter = await tokenBalance(USDT_ADDRESS);
  const proceedsUsdt = Math.max(0, usdtAfter - pending.usdtBefore);
  const realizedPnlUsdt = proceedsUsdt - pending.costBasisUsdt;
  state.realizedPnlUsdt += realizedPnlUsdt;
  state.cooldownUntil[pending.symbol] = Date.now() + config.reentryCooldownMinutes * 60_000;
  state.position = null;
  state.pendingOrder = null;
  await traceAction("pending_order", "finished", {
    orderId: pending.orderId,
    side: pending.side,
    symbol: pending.symbol,
    proceedsUsdt,
    realizedPnlUsdt
  }, currentCycleId);
  await notify(
    state,
    [
      `[Agentic Stock Bot] SELL FINISHED ${pending.reason}`,
      `${pending.symbol} ${pending.address}`,
      `实际回收: ${proceedsUsdt.toFixed(4)} USDT`,
      `本笔盈亏: ${realizedPnlUsdt.toFixed(4)} USDT`,
      `当日累计已实现盈亏: ${state.realizedPnlUsdt.toFixed(4)} USDT`,
      `订单: ${pending.orderId}`
    ].join("\n")
  );
  return true;
}

async function buildCandidate(symbol, asset, config) {
  const [status, kline] = await Promise.all([assetStatus(asset.contractAddress), candles(asset.contractAddress)]);
  const signal = analyzeCandles(kline);
  if (!signal) {
    await traceAction("candidate_rejected", "skipped", { symbol, reason: "insufficient_closed_candles" }, currentCycleId);
    return null;
  }

  const candidate = { symbol, address: asset.contractAddress, asset, ...status, ...signal };
  if (
    !candidate.openState ||
    candidate.reasonCode !== "TRADING" ||
    candidate.trend15mPct < config.minTrend15mPct ||
    candidate.upMinutes < config.minDirectionalMinutes
  ) {
    await traceAction("candidate_rejected", "skipped", {
      symbol,
      reason: "market_or_trend_gate",
      openState: candidate.openState,
      reasonCode: candidate.reasonCode,
      trend15mPct: candidate.trend15mPct,
      upMinutes: candidate.upMinutes
    }, currentCycleId);
    return { ...candidate, roundTripCostPct: Infinity };
  }

  const buyQuote = await quote(config.maxTradeUsdt, USDT_ADDRESS, candidate.address);
  const sellQuote = await quote(buyQuote.toCoinAmount, candidate.address, USDT_ADDRESS);
  const completed = {
    ...candidate,
    buyQuantity: buyQuote.toCoinAmount,
    roundTripCostPct: roundTripCostPct(config.maxTradeUsdt, Number(sellQuote.toCoinAmount))
  };
  await traceAction("candidate_evaluated", "succeeded", {
    symbol,
    trend15mPct: completed.trend15mPct,
    upMinutes: completed.upMinutes,
    roundTripCostPct: completed.roundTripCostPct
  }, currentCycleId);
  return completed;
}

async function evaluateEntry(config, state, assets) {
  if (dailyLossReached(state.realizedPnlUsdt, config.dailyLossLimitUsdt)) {
    await traceAction("entry_decision", "skipped", { reason: "daily_loss_limit" }, currentCycleId);
    return;
  }
  const now = Date.now();
  if (now - state.lastEntryDecisionAt < config.entryIntervalMinutes * 60_000) {
    await traceAction("entry_decision", "skipped", { reason: "entry_interval" }, currentCycleId);
    return;
  }
  state.lastEntryDecisionAt = now;

  const candidates = (await Promise.all(
    config.symbols.map(async (symbol) => {
      if ((state.cooldownUntil[symbol] || 0) > now) {
        await traceAction("candidate_rejected", "skipped", { symbol, reason: "cooldown" }, currentCycleId);
        return null;
      }
      try {
        return await buildCandidate(symbol, assets.get(symbol), config);
      } catch (error) {
        await traceAction("candidate_evaluation", "failed", { symbol, error: error.message }, currentCycleId);
        log("Candidate evaluation failed", { symbol, error: error.message });
        return null;
      }
    })
  )).filter(Boolean);

  const selected = rankCandidates(candidates, config)[0];
  if (!selected) {
    await traceAction("entry_decision", "skipped", { reason: "no_candidate_passed" }, currentCycleId);
    log("No entry candidate passed all gates");
    return;
  }

  await traceAction("candidate_selected", "succeeded", {
    symbol: selected.symbol,
    trend15mPct: selected.trend15mPct,
    roundTripCostPct: selected.roundTripCostPct
  }, currentCycleId);
  const auditResult = await audit(selected.asset, config);
  if (config.mode === "live" && !feishuConfigured()) {
    throw new Error("Feishu credentials are required in live mode");
  }

  const usdtBefore = await tokenBalance(USDT_ADDRESS);
  if (usdtBefore < config.maxTradeUsdt) throw new Error(`Insufficient USDT: ${usdtBefore}`);
  const result = await swap(config, config.maxTradeUsdt, USDT_ADDRESS, selected.address);
  if (result.shadow) {
    state.position = {
      symbol: selected.symbol,
      address: selected.address,
      quantity: selected.buyQuantity,
      costBasisUsdt: config.maxTradeUsdt,
      openedAt: new Date().toISOString(),
      orderId: result.orderId,
      shadow: true
    };
  } else {
    state.pendingOrder = {
      side: "BUY",
      symbol: selected.symbol,
      address: selected.address,
      costBasisUsdt: config.maxTradeUsdt,
      createdAt: new Date().toISOString(),
      orderId: result.orderId
    };
  }
  await traceAction("buy_submission", result.shadow ? "simulated" : "submitted", {
    symbol: selected.symbol,
    address: selected.address,
    amountUsdt: config.maxTradeUsdt,
    orderId: result.orderId
  }, currentCycleId);
  await notify(
    state,
    [
      `[Agentic Stock Bot] BUY SUBMITTED ${config.mode.toUpperCase()}`,
      `${selected.symbol} ${selected.address}`,
      `投入: ${config.maxTradeUsdt} USDT`,
      `15分钟趋势: ${selected.trend15mPct.toFixed(3)}%`,
      `估算往返成本: ${selected.roundTripCostPct.toFixed(3)}%`,
      `审计: ${auditResult.riskLevel || auditResult.status}`,
      `订单: ${result.orderId}`
    ].join("\n")
  );
}

async function evaluateExit(config, state) {
  const position = state.position;
  if (!position) return;

  const quantity = position.shadow ? Number(position.quantity) : await tokenBalance(position.address);
  if (!(quantity > 0)) throw new Error(`Position balance missing for ${position.symbol}`);
  const sellQuote = await quote(quantity, position.address, USDT_ADDRESS);
  const proceedsUsdt = Number(sellQuote.toCoinAmount);
  const reason = exitReason({
    proceedsUsdt,
    costBasisUsdt: position.costBasisUsdt,
    stopLossPct: config.stopLossPct,
    takeProfitPct: config.takeProfitPct
  });
  if (!reason) {
    await traceAction("exit_decision", "skipped", {
      symbol: position.symbol,
      reason: "within_stop_and_take_profit",
      proceedsUsdt,
      returnPct: ((proceedsUsdt / position.costBasisUsdt) - 1) * 100
    }, currentCycleId);
    log("Position monitored", { symbol: position.symbol, returnPct: ((proceedsUsdt / position.costBasisUsdt) - 1) * 100 });
    return;
  }

  const usdtBefore = config.mode === "live" ? await tokenBalance(USDT_ADDRESS) : null;
  const result = await swap(config, quantity, position.address, USDT_ADDRESS);
  if (result.shadow) {
    const realizedPnlUsdt = proceedsUsdt - position.costBasisUsdt;
    state.realizedPnlUsdt += realizedPnlUsdt;
    state.cooldownUntil[position.symbol] = Date.now() + config.reentryCooldownMinutes * 60_000;
    state.position = null;
  } else {
    state.pendingOrder = {
      side: "SELL",
      symbol: position.symbol,
      address: position.address,
      quantity,
      costBasisUsdt: position.costBasisUsdt,
      usdtBefore,
      reason: reason.type,
      createdAt: new Date().toISOString(),
      orderId: result.orderId
    };
  }
  await traceAction("sell_submission", result.shadow ? "simulated" : "submitted", {
    symbol: position.symbol,
    address: position.address,
    reason: reason.type,
    expectedProceedsUsdt: proceedsUsdt,
    orderId: result.orderId
  }, currentCycleId);
  await notify(
    state,
    [
      `[Agentic Stock Bot] SELL SUBMITTED ${config.mode.toUpperCase()} ${reason.type}`,
      `${position.symbol} ${position.address}`,
      `预计回收: ${proceedsUsdt.toFixed(4)} USDT`,
      `预计盈亏: ${(proceedsUsdt - position.costBasisUsdt).toFixed(4)} USDT (${reason.returnPct.toFixed(3)}%)`,
      `订单: ${result.orderId}`
    ].join("\n")
  );
}

async function cycle(config, state, statePath) {
  currentCycleId = randomUUID();
  await traceAction("cycle", "started", {
    hasPosition: Boolean(state.position),
    hasPendingOrder: Boolean(state.pendingOrder)
  }, currentCycleId);
  try {
    await flushNotifications(state);
    const wallet = await baw(["wallet", "status"]);
    if (wallet.status !== "CONNECTED") throw new Error(`Wallet status is ${wallet.status}`);

    if (state.pendingOrder) {
      await finalizePendingOrder(config, state);
    } else if (state.position) {
      await evaluateExit(config, state);
    } else {
      const assets = await resolveAssets(config.symbols);
      await evaluateEntry(config, state, assets);
    }
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
  const runId = randomUUID();
  traceAction = createTracer(tracePath, { runId });
  const state = await loadState(statePath);

  if (config.mode === "live" && process.env.BOT_LIVE !== "1") {
    throw new Error("Live mode requires BOT_LIVE=1");
  }
  if (config.mode === "live" && !feishuConfigured()) {
    throw new Error("Live mode requires Feishu credentials");
  }
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
    allowUnsupportedAuditForOfficialRwa: config.allowUnsupportedAuditForOfficialRwa
  });

  do {
    try {
      await cycle(config, state, statePath);
    } catch (error) {
      log("Cycle failed closed", { error: error.message });
      await notify(state, `[Agentic Stock Bot] ERROR\n${error.message}`);
      await saveJson(statePath, state);
    }
    if (!once) await new Promise((resolvePromise) => setTimeout(resolvePromise, config.pollSeconds * 1000));
  } while (!once);
}

await main();
