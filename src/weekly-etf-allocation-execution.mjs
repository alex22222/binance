import { openPositions } from "./position-state.mjs";
import { sameTokenAmount } from "./token-amount.mjs";
import { assertQuoteFresh, quoteDriftPct } from "./reliability.mjs";
import {
  dailyLossReached, entryMarketAllowed, entrySymbolPolicyDecision, fomcEntryBlackoutDecision,
  costCoverageDecision, nyseSessionPlan, roundTripCostPct
} from "./strategy.mjs";
import { weeklyEtfLiveDecisionWindow } from "./weekly-etf-live.mjs";
import {
  ALLOCATION_STRATEGY_ID, allocationExecutionAllowed, allocationPlan, topUpEligible
} from "./weekly-etf-allocation.mjs";

const USDT = "0x55d398326f99059fF775485246999027B3197955";

// Separate from the legacy fixed-ticket path; every wallet/network effect is
// injected. Paper ledgers and non-weekly strategies do not use this runner.
export function createWeeklyEtfAllocationExecution({
  loadDecision, loadGate, loadSnapshot, resolveAsset, assetStatus, buildCandidate,
  audit, quote, walletSettings, requestApproval, submitOrder, trace, now = () => Date.now()
}) {
  async function context(config, state, details = null) {
    if (config.mode !== "live" || config.activeStrategyId !== ALLOCATION_STRATEGY_ID ||
        !config.weeklyEtfAllocation || !nyseSessionPlan(now()).regularOpen ||
        !fomcEntryBlackoutDecision({ nowMs: now(), dates: config.fomcEntryBlackoutDates }).allowed ||
        !Number.isFinite(state.realizedPnlUsdt) || dailyLossReached(state.realizedPnlUsdt, config.dailyLossLimitUsdt)) return null;
    const decision = await loadDecision(state, now());
    const window = weeklyEtfLiveDecisionWindow(now(), state.weeklyEtfLive);
    if (!decision || decision.target === "CASH" || state.weeklyEtfLive?.skipEntryWeek === window.week) return null;
    const positions = openPositions(state);
    if (positions.length > 1 || (positions.length && positions[0].symbol !== decision.target)) return null;
    const position = positions[0] || null;
    const gate = await loadGate(config, { strategyId: ALLOCATION_STRATEGY_ID });
    if (!gate.allowed || !gate.limits?.weeklyEtfAllocation || (position && !topUpEligible(state, gate, position))) return null;
    const policy = entrySymbolPolicyDecision({ symbol: decision.target, blockedSymbols: config.entryBlockedSymbols,
      initialStopHistory: state.initialStopHistory, quarantineUntilBySymbol: state.quarantineUntilBySymbol, nowMs: now() });
    if (!policy.allowed || (!position && (state.cooldownUntil?.[decision.target] || 0) > now())) return null;
    if (details && (details.symbol !== decision.target || details.weeklyDecisionWeek !== window.week ||
        details.strategyGovernance?.authorizationId !== gate.authorizationId)) return null;
    const asset = await resolveAsset(decision.target, config);
    const status = await assetStatus(asset.contractAddress);
    if (!entryMarketAllowed(status, true, now(), config.entryCutoffMinutes) ||
        (position && position.address.toLowerCase() !== asset.contractAddress.toLowerCase()) ||
        (details && details.address.toLowerCase() !== asset.contractAddress.toLowerCase())) return null;
    return { decision, position, gate, asset, status, week: window.week };
  }

  async function revalidate(config, state, details, suppliedGate) {
    const ctx = await context(config, state, details);
    if (!ctx || ctx.gate.authorizationId !== suppliedGate.authorizationId) return false;
    const snapshot = await loadSnapshot(config, state, ctx.position, ctx.asset);
    if (!allocationExecutionAllowed(config, state, details, ctx.gate, snapshot, now())) return false;
    const settings = await walletSettings();
    if (!Number.isFinite(settings.quotaLeft) || settings.quotaLeft < Number(details.fromTokenQty) ||
        !(Date.parse(settings.sessionExpireTime) > now())) return false;
    const buy = await quote(details.fromTokenQty, USDT, details.address, config.slippagePct);
    const sell = await quote(buy.toCoinAmount, details.address, USDT, config.slippagePct);
    assertQuoteFresh({ quotedAt: buy.quotedAt, maxAgeMs: config.quoteMaxAgeSeconds * 1000, nowMs: now() });
    if (quoteDriftPct(details.expectedOutputQty, buy.toCoinAmount) > config.maxQuoteDriftPct ||
        roundTripCostPct(Number(details.fromTokenQty), Number(sell.toCoinAmount)) > config.maxRoundTripCostPct) return false;
    const costs = costCoverageDecision({ tradeUsdt: Number(details.fromTokenQty),
      grossEdgeProxyPct: details.grossEdgeProxyPct, takeProfitPct: details.finalTakeProfitPct,
      quotedRoundTripCostPct: roundTripCostPct(Number(details.fromTokenQty), Number(sell.toCoinAmount)),
      executionBufferPct: config.executionBufferPct, estimatedRoundTripGasUsdt: snapshot.gasUsdt,
      minNetEdgePct: config.minNetEdgePct });
    if (!costs.allowed) return false;
    const freshAudit = await audit(ctx.asset, config);
    const finalSnapshot = await loadSnapshot(config, state, ctx.position, ctx.asset);
    const finalGate = await loadGate(config, details);
    assertQuoteFresh({ quotedAt: buy.quotedAt, maxAgeMs: config.quoteMaxAgeSeconds * 1000, nowMs: now() });
    assertQuoteFresh({ quotedAt: sell.quotedAt, maxAgeMs: config.quoteMaxAgeSeconds * 1000, nowMs: now() });
    return freshAudit.allowed === true && freshAudit.status === details.audit?.status &&
      finalGate.allowed === true && finalGate.authorizationId === ctx.gate.authorizationId &&
      finalGate.identity?.identityHash === ctx.gate.identity?.identityHash &&
      Date.parse(settings.sessionExpireTime) > now() &&
      entryMarketAllowed(ctx.status, true, now(), config.entryCutoffMinutes) &&
      fomcEntryBlackoutDecision({ nowMs: now(), dates: config.fomcEntryBlackoutDates }).allowed &&
      allocationExecutionAllowed(config, state, details, finalGate, finalSnapshot, now());
  }

  async function run(config, state, statePath, emergencyStopPath, approved = null) {
    const ctx = await context(config, state, approved);
    if (!ctx) return;
    const snapshot = await loadSnapshot(config, state, ctx.position, ctx.asset);
    const plan = allocationPlan(config, ctx.position, snapshot, approved?.fromTokenQty ?? null);
    await trace("weekly_etf_allocation", plan.allowed ? "allowed" : "blocked", { symbol: ctx.decision.target, ...plan });
    state.weeklyEtfAllocation = { plan: { ...plan, symbol: ctx.decision.target, topUp: Boolean(ctx.position), checkedAt: new Date(now()).toISOString() } };
    if (!plan.allowed) return;
    const candidate = await buildCandidate(ctx.decision.target, ctx.asset,
      { ...config, maxTradeUsdt: Number(plan.amountUsdt) }, ctx.status, snapshot.gasUsdt);
    if (!candidate?.costCoverage?.allowed || candidate.roundTripCostPct > config.maxRoundTripCostPct) return;
    const audited = await audit(ctx.asset, config);
    if (!audited.allowed) return;
    const details = {
      side: "BUY", strategyId: ALLOCATION_STRATEGY_ID, symbol: ctx.decision.target, address: ctx.asset.contractAddress,
      fromToken: USDT, toToken: ctx.asset.contractAddress, fromTokenQty: plan.amountUsdt,
      costBasisUsdt: Number(plan.amountUsdt), entryType: ctx.position ? "TOP_UP" : "NEW_POSITION",
      parentOrderId: ctx.position?.orderId || null, topUpRequestId: ctx.position ? ctx.gate.topUpRequest.requestId : null,
      tokenBefore: snapshot.tokenBefore, allocation: plan, strategyGovernance: ctx.gate,
      weeklySignalDate: ctx.decision.signalDate, weeklyDecisionWeek: ctx.week, weeklyTarget: ctx.decision.target,
      expectedOutputQty: candidate.buyQuantity, quoteTimestamp: candidate.buyQuotedAt,
      grossEdgeProxyPct: candidate.grossEdgeProxyPct, initialRiskPct: config.disasterStopLossPct,
      finalTakeProfitPct: candidate.finalTakeProfitPct, entryAtr15Pct: candidate.atr15Pct,
      costCoverage: candidate.costCoverage, profitFloorPct: candidate.costCoverage.allInCostPct + config.minNetEdgePct,
      estimatedRoundTripGasUsdt: snapshot.gasUsdt, audit: audited, usdtBefore: snapshot.cashUsdt,
      createdAt: new Date(now()).toISOString()
    };
    if (!allocationExecutionAllowed(config, state, details, ctx.gate, snapshot, now())) return;
    if (!approved) {
      await requestApproval(config, state, statePath, details);
      return;
    }
    if (!sameTokenAmount(approved.fromTokenQty, details.fromTokenQty) ||
        approved.entryType !== details.entryType || approved.topUpRequestId !== details.topUpRequestId ||
        approved.allocation?.positionHash !== details.allocation.positionHash || approved.tokenBefore !== details.tokenBefore ||
        approved.audit?.status !== audited.status ||
        quoteDriftPct(approved.expectedOutputQty, candidate.buyQuantity) > config.maxQuoteDriftPct) {
      await trace("trade_approval", "invalidated", { approvalId: approved.approvalId, side: "BUY", symbol: details.symbol, reason: "allocation_or_quote_changed" });
      return;
    }
    details.approvalId = approved.approvalId;
    const result = await submitOrder(config, state, statePath, emergencyStopPath, details);
    await trace("buy_submission", "submitted", { symbol: details.symbol, address: details.address,
      strategyId: details.strategyId, entryType: details.entryType, parentOrderId: details.parentOrderId,
      amountUsdt: details.costBasisUsdt, allocation: details.allocation, orderId: result.orderId,
      initialRiskPct: details.initialRiskPct, allInCostPct: details.costCoverage.allInCostPct });
  }

  return { run, revalidate };
}
