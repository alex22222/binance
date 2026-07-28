import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readEmergencyStop } from "./reliability.mjs";
import { buildStrategyComparison, DEFAULT_STRATEGY_ID } from "./strategy-lab.mjs";
import { buildAssetTrend } from "./wallet-balance.mjs";
import { effectiveRoundTripGasEstimate } from "./execution-accounting.mjs";
import { openPositions } from "./position-state.mjs";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function buildPositionSnapshot(position, gasEstimate) {
  const costBasisUsdt = finiteNumber(position.costBasisUsdt);
  const initialRiskPct = finiteNumber(position.initialRiskPct, null);
  const worstReturnPct = position.worstReturnPct == null
    ? null
    : finiteNumber(position.worstReturnPct, null);
  const peakReturnPct = finiteNumber(position.peakReturnPct, 0);
  const riskUsdt = initialRiskPct > 0 ? costBasisUsdt * initialRiskPct / 100 : null;
  return {
    ...position,
    quantity: finiteNumber(position.quantity),
    costBasisUsdt,
    initialRiskPct,
    profitFloorPct: finiteNumber(position.profitFloorPct, null),
    entryAtr15Pct: finiteNumber(position.entryAtr15Pct, null),
    currentAtr15Pct: finiteNumber(position.currentAtr15Pct, null),
    peakReturnPct,
    worstReturnPct,
    riskUsdt,
    maeR: initialRiskPct > 0 && worstReturnPct != null ? worstReturnPct / initialRiskPct : null,
    mfeR: initialRiskPct > 0 ? peakReturnPct / initialRiskPct : null,
    trailingStopPct: finiteNumber(position.trailingStopPct, null),
    lastQuoteProceedsUsdt: finiteNumber(position.lastQuoteProceedsUsdt, null),
    entryGasUsdt: finiteNumber(position.entryGasUsdt, gasEstimate.gasUsdt / 2),
    estimatedExitGasUsdt: gasEstimate.gasUsdt / 2,
    grossUnrealizedPnlUsdt: position.lastQuoteProceedsUsdt == null
      ? null
      : finiteNumber(position.lastQuoteProceedsUsdt) - finiteNumber(position.costBasisUsdt),
    unrealizedPnlUsdt: position.lastQuoteProceedsUsdt == null
      ? null
      : finiteNumber(position.lastQuoteProceedsUsdt) -
        finiteNumber(position.costBasisUsdt) -
        finiteNumber(position.entryGasUsdt, gasEstimate.gasUsdt / 2) -
        gasEstimate.gasUsdt / 2,
    returnPct: position.lastQuoteProceedsUsdt == null || !(finiteNumber(position.costBasisUsdt) > 0)
      ? null
      : (
          (
            finiteNumber(position.lastQuoteProceedsUsdt) -
            finiteNumber(position.entryGasUsdt, gasEstimate.gasUsdt / 2) -
            gasEstimate.gasUsdt / 2
          ) /
          finiteNumber(position.costBasisUsdt) -
          1
        ) * 100
  };
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
      dataFetchedAt: record.details.dataFetchedAt || record.timestamp,
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
      shadowConcentrationDecision: record.details.shadowConcentrationDecision || null,
      shadowCompletedEntriesToday: finiteNumber(record.details.shadowCompletedEntriesToday, null),
      shadowTrendQualityDecision: record.details.shadowTrendQualityDecision || null,
      shadowTrendEfficiency: finiteNumber(record.details.shadowTrendEfficiency, null),
      shadowPositionSizeDecision: record.details.shadowPositionSizeDecision || null,
      shadowSuggestedTradeUsdt: finiteNumber(record.details.shadowSuggestedTradeUsdt, null),
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
  const gasEstimate = effectiveRoundTripGasEstimate({
    configuredGasUsdt: config.estimatedRoundTripGasUsdt,
    observations: state.roundTripGasHistoryUsdt || []
  });
  const positions = openPositions(state).map((position) => (
    buildPositionSnapshot(position, gasEstimate)
  ));
  const openRiskUsdt = positions.reduce(
    (sum, current) => sum + (Number.isFinite(current.riskUsdt) ? current.riskUsdt : 0),
    0
  );
  const dailyLossLimitUsdt = finiteNumber(config.dailyLossLimitUsdt);
  const dailyLossUsedUsdt = Math.max(0, -realizedPnlUsdt);
  const position = positions[0] || null;
  const approvalExpiresAtMs = Date.parse(state.approvalRequest?.expiresAt || "");
  const approvalIsFresh = (
    state.approvalRequest?.status === "PENDING_CONFIRMATION" &&
    Number.isFinite(approvalExpiresAtMs) &&
    nowMs <= approvalExpiresAtMs
  );
  const automaticallyApproved = approvalIsFresh && approvalControl?.enabled === true;
  const orderReviewRequired = state.pendingOrder?.status === "REVIEW_REQUIRED";
  const orderReviewError = orderReviewRequired
    ? state.pendingOrder.lastError || `Order review required: ${state.pendingOrder.reviewReason || "unknown reason"}`
    : null;
  const approvalRequest = state.approvalRequest
    ? {
        ...state.approvalRequest,
        automaticallyApproved,
        canDecide: approvalIsFresh && !automaticallyApproved,
        displayStatus: nowMs > approvalExpiresAtMs
          ? "EXPIRED"
          : automaticallyApproved
            ? "AUTO_APPROVED_REVALIDATING"
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
        : orderReviewRequired
          ? "HALTED"
        : heartbeatAgeMs == null
          ? "WAITING"
          : heartbeatAgeMs > staleAfterMs
            ? "STALE"
            : state.lastError
              ? "DEGRADED"
              : "RUNNING",
      updatedAt: state.updatedAt || null,
      heartbeatAgeMs,
      lastError: orderReviewError || state.lastError || null,
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
      dailyLossLimitUsdt,
      realizedPnlUsdt,
      realizedGrossPnlUsdt: finiteNumber(state.realizedGrossPnlUsdt),
      gasCostUsdt: finiteNumber(state.gasCostUsdt),
      dailyLossRemainingUsdt: Math.max(0, dailyLossLimitUsdt + realizedPnlUsdt),
      dailyLossUsedUsdt,
      dailyLossUsedPct: dailyLossLimitUsdt > 0 ? dailyLossUsedUsdt / dailyLossLimitUsdt * 100 : null,
      openRiskUsdt,
      openRiskToDailyLimitPct: dailyLossLimitUsdt > 0 ? openRiskUsdt / dailyLossLimitUsdt * 100 : null,
      maxOpenPositions: config.maxOpenPositions,
      openPositionCount: positions.length,
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
      effectiveRoundTripGasUsdt: gasEstimate.gasUsdt,
      gasEstimateSource: gasEstimate.source,
      actualGasSampleCount: gasEstimate.sampleCount,
      minNetEdgePct: config.minNetEdgePct,
      atrPeriod: config.atrPeriod,
      atrStopMultiplier: config.atrStopMultiplier,
      trailingAtrMultiplier: config.trailingAtrMultiplier,
      signalReviewHours: config.signalReviewHours,
      signalReviewMinR: config.signalReviewMinR
    },
    strategies: buildStrategyComparison(activeStrategyId, traceRecords),
    positions,
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
