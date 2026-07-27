import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readEmergencyStop } from "./reliability.mjs";
import { buildStrategyComparison, DEFAULT_STRATEGY_ID } from "./strategy-lab.mjs";
import { buildAssetTrend } from "./wallet-balance.mjs";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function latestSignals(traceRecords) {
  const signals = {};
  for (const record of traceRecords) {
    if (!["candidate_rejected", "candidate_evaluated", "candidate_selected"].includes(record.event)) continue;
    const symbol = record.details?.symbol;
    if (!symbol) continue;
    const timestampMs = Date.parse(record.timestamp || "");
    const previousTimestampMs = Date.parse(signals[symbol]?.timestamp || "");
    if (
      Number.isFinite(previousTimestampMs) &&
      (!Number.isFinite(timestampMs) || previousTimestampMs > timestampMs)
    ) continue;
    signals[symbol] = {
      event: record.event,
      status: record.status,
      timestamp: record.timestamp,
      source: record.details.signalSource === "local-history" ? "local-history" : "server-live",
      trend15mPct: finiteNumber(record.details.trend15mPct, null),
      upMinutes: finiteNumber(record.details.upMinutes, null),
      roundTripCostPct: finiteNumber(record.details.roundTripCostPct, null),
      allInCostPct: finiteNumber(record.details.allInCostPct, null),
      netEdgeProxyPct: finiteNumber(record.details.netEdgeProxyPct, null),
      costCoverageAllowed: record.details.costCoverageAllowed ?? null,
      costCoverageReason: record.details.costCoverageReason || null,
      atr15Pct: finiteNumber(record.details.atr15Pct, null),
      initialRiskPct: finiteNumber(record.details.initialRiskPct, null),
      finalTakeProfitPct: finiteNumber(record.details.finalTakeProfitPct, null),
      reason: record.details.reason || null
    };
  }
  return signals;
}

export function buildDashboardSnapshot({
  config,
  state,
  traceRecords,
  signalHistoryRecords = [],
  walletBalanceHistory = [],
  approvalControl = null,
  strategyControl = null,
  nowMs = Date.now()
}) {
  const updatedAtMs = Date.parse(state.updatedAt || "");
  const staleAfterMs = Math.max(15_000, finiteNumber(config.pollSeconds, 60) * 3_000);
  const heartbeatAgeMs = Number.isFinite(updatedAtMs) ? Math.max(0, nowMs - updatedAtMs) : null;
  const realizedPnlUsdt = finiteNumber(state.realizedPnlUsdt);
  const position = state.position
    ? {
        ...state.position,
        quantity: finiteNumber(state.position.quantity),
        costBasisUsdt: finiteNumber(state.position.costBasisUsdt),
        initialRiskPct: finiteNumber(state.position.initialRiskPct, null),
        profitFloorPct: finiteNumber(state.position.profitFloorPct, null),
        entryAtr15Pct: finiteNumber(state.position.entryAtr15Pct, null),
        currentAtr15Pct: finiteNumber(state.position.currentAtr15Pct, null),
        peakReturnPct: finiteNumber(state.position.peakReturnPct, 0),
        trailingStopPct: finiteNumber(state.position.trailingStopPct, null),
        lastQuoteProceedsUsdt: finiteNumber(state.position.lastQuoteProceedsUsdt, null),
        unrealizedPnlUsdt: state.position.lastQuoteProceedsUsdt == null
          ? null
          : finiteNumber(state.position.lastQuoteProceedsUsdt) - finiteNumber(state.position.costBasisUsdt),
        returnPct: state.position.lastQuoteProceedsUsdt == null || !(finiteNumber(state.position.costBasisUsdt) > 0)
          ? null
          : ((finiteNumber(state.position.lastQuoteProceedsUsdt) / finiteNumber(state.position.costBasisUsdt)) - 1) * 100
      }
    : null;
  const approvalRequest = state.approvalRequest
    ? {
        ...state.approvalRequest,
        canDecide: (
          state.approvalRequest.status === "PENDING_CONFIRMATION" &&
          Number.isFinite(Date.parse(state.approvalRequest.expiresAt || "")) &&
          nowMs <= Date.parse(state.approvalRequest.expiresAt)
        ),
        displayStatus: nowMs > Date.parse(state.approvalRequest.expiresAt || "")
          ? "EXPIRED"
          : state.approvalRequest.status
      }
    : null;

  const activeStrategyId = strategyControl?.strategyId || config.defaultStrategyId || DEFAULT_STRATEGY_ID;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    mode: config.mode,
    executionPolicy: approvalControl?.enabled
      ? "AUTOMATIC_APPROVAL_WITH_REVALIDATION"
      : "PER_TRADE_CONFIRMATION_REQUIRED",
    autoApproval: approvalControl || { enabled: false, updatedAt: null, updatedBy: "default" },
    marketSession: state.lastMarketSession || null,
    health: {
      status: state.emergencyStop?.active
        ? "HALTED"
        : state.walletSession?.status === "EXPIRED"
          ? "AUTH_REQUIRED"
        : heartbeatAgeMs == null
          ? "WAITING"
          : heartbeatAgeMs > staleAfterMs
            ? "STALE"
            : state.lastError
              ? "DEGRADED"
              : "RUNNING",
      updatedAt: state.updatedAt || null,
      heartbeatAgeMs,
      lastError: state.lastError || null,
      walletSession: state.walletSession || null,
      emergencyStop: state.emergencyStop || null
    },
    walletBalance: state.walletBalance
      ? {
          totalUsd: state.walletBalance.totalUsd == null
            ? null
            : finiteNumber(state.walletBalance.totalUsd, null),
          assetCount: finiteNumber(state.walletBalance.assetCount),
          checkedAt: state.walletBalance.checkedAt || null,
          lastCheckFailedAt: state.walletBalance.lastCheckFailedAt || null
        }
      : null,
    assetTrend: buildAssetTrend(walletBalanceHistory, state.walletBalance, 30),
    risk: {
      maxTradeUsdt: finiteNumber(config.maxTradeUsdt),
      dailyLossLimitUsdt: finiteNumber(config.dailyLossLimitUsdt),
      realizedPnlUsdt,
      dailyLossRemainingUsdt: Math.max(0, finiteNumber(config.dailyLossLimitUsdt) + realizedPnlUsdt),
      maxOpenPositions: config.maxOpenPositions,
      disasterStopLossPct: finiteNumber(config.disasterStopLossPct),
      minInitialStopPct: finiteNumber(config.minInitialStopPct),
      maxInitialStopPct: finiteNumber(config.maxInitialStopPct),
      profitProtectionR: finiteNumber(config.profitProtectionR),
      finalTakeProfitR: finiteNumber(config.finalTakeProfitR)
    },
    strategy: {
      activeStrategyId,
      controlUpdatedAt: strategyControl?.updatedAt || null,
      symbols: config.symbols,
      entryIntervalMinutes: config.entryIntervalMinutes,
      regularOnlyEntries: config.regularOnlyEntries,
      entryAtrMultiplier: config.entryAtrMultiplier,
      minDirectionalMinutes: config.minDirectionalMinutes,
      maxRoundTripCostPct: config.maxRoundTripCostPct,
      slippagePct: config.slippagePct,
      executionBufferPct: config.executionBufferPct,
      estimatedRoundTripGasUsdt: config.estimatedRoundTripGasUsdt,
      minNetEdgePct: config.minNetEdgePct,
      atrPeriod: config.atrPeriod,
      atrStopMultiplier: config.atrStopMultiplier,
      trailingAtrMultiplier: config.trailingAtrMultiplier,
      signalReviewHours: config.signalReviewHours,
      signalReviewMinR: config.signalReviewMinR
    },
    strategies: buildStrategyComparison(activeStrategyId, traceRecords),
    position,
    approvalRequest,
    pendingOrder: state.pendingOrder || null,
    signals: latestSignals([...signalHistoryRecords, ...traceRecords]),
    recentActions: traceRecords.slice(-80).reverse()
  };
}

export async function loadDashboardSnapshot({
  configPath,
  statePath,
  tracePath,
  signalHistoryPath = null,
  approvalControlPath = null,
  emergencyStopPath,
  strategyControlPath,
  nowMs = Date.now()
}) {
  const [configText, stateText, traceText, signalHistoryText, walletBalanceHistoryText, approvalControl, emergencyStop, strategyControl] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(statePath, "utf8").catch((error) => error.code === "ENOENT" ? "{}" : Promise.reject(error)),
    readFile(tracePath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error)),
    signalHistoryPath
      ? readFile(signalHistoryPath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error))
      : "",
    readFile(resolve(dirname(statePath), "wallet-balance-history.json"), "utf8")
      .catch((error) => error.code === "ENOENT" ? "[]" : Promise.reject(error)),
    approvalControlPath
      ? readFile(approvalControlPath, "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error))
      : null,
    emergencyStopPath ? readEmergencyStop(emergencyStopPath) : null,
    strategyControlPath
      ? readFile(strategyControlPath, "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error))
      : null
  ]);
  const traceRecords = traceText
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const signalHistoryRecords = signalHistoryText
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const walletBalanceHistory = JSON.parse(walletBalanceHistoryText);
  return buildDashboardSnapshot({
    config: JSON.parse(configText),
    state: {
      ...JSON.parse(stateText),
      emergencyStop
    },
    traceRecords,
    signalHistoryRecords,
    walletBalanceHistory,
    approvalControl,
    strategyControl,
    nowMs
  });
}
