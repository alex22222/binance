import { approvalDecisionStatus, loadApprovalDecision } from "./approvals.mjs";
import { assertStrategyGate } from "./strategy-governance.mjs";
import { openPositions } from "./position-state.mjs";
import {
  createOrderIntent,
  matchingOrdersForIntent,
  recoveryActionForPending
} from "./reliability.mjs";

// Order submission, ambiguous-order recovery and approval consumption.
// Every external effect is injected so the state transitions can be exercised
// in tests without a wallet, a clock or the bot's module-level globals.
export function createOrderExecution({
  baw,
  saveJson,
  trace,
  readEmergencyStop,
  authorizeEntry = async () => ({ allowed: false, reasons: ["GATE_NOT_CONFIGURED"] }),
  isShutdownRequested = () => false,
  now = () => Date.now(),
  chainId = "56"
}) {
  const isoNow = () => new Date(now()).toISOString();

  async function ensureNotEmergencyStopped(emergencyStopPath, state) {
    if (isShutdownRequested()) {
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

  async function swap(config, fromTokenQty, fromToken, toToken) {
    if (config.mode !== "live") {
      const result = { shadow: true, orderId: `shadow-${now()}` };
      await trace("market_order", "simulated", {
        mode: config.mode,
        fromToken,
        toToken,
        fromTokenQty,
        orderId: result.orderId
      });
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
      chainId,
      "--slippage",
      String(config.slippagePct),
      "--mev",
      "true",
      "--gasLevel",
      "HIGH"
    ], { stateChanging: true });
  }

  async function submitOrder(config, state, statePath, emergencyStopPath, details) {
    if (config.mode !== "live") {
      return swap(config, details.fromTokenQty, details.fromToken, details.toToken);
    }

    await ensureNotEmergencyStopped(emergencyStopPath, state);
    async function revalidateEntry() {
      if (details.side === "SELL") return;
      if (details.side !== "BUY") throw new Error("Invalid order side");
      let gate = await authorizeEntry(config, details);
      if (gate.authorizationType === "EXPERIMENTAL_EXCEPTION") {
        const amount = Number(details.fromTokenQty), limits = gate.limits;
        if (!limits || !Number.isFinite(amount) || amount <= 0 || amount > limits.maxTradeUsdt ||
            String(details.fromToken).toLowerCase() !== "0x55d398326f99059ff775485246999027b3197955" ||
            openPositions(state).length >= limits.maxOpenPositions ||
            !Number.isFinite(state.realizedPnlUsdt) || state.realizedPnlUsdt <= -limits.dailyLossLimitUsdt) {
          gate = { ...gate, allowed: false, reasons: [...(gate.reasons || []), "EXPERIMENT_EXECUTION_LIMIT"] };
        }
      }
      if (details.strategyGovernance && (
        details.strategyGovernance.authorizationId !== gate.authorizationId ||
        details.strategyGovernance.identity?.identityHash !== gate.identity?.identityHash
      )) gate = { ...gate, allowed: false, reasons: [...(gate.reasons || []), "APPROVED_EVIDENCE_CHANGED"] };
      await trace("strategy_promotion", gate.allowed ? "allowed" : "blocked", {
        side: details.side, symbol: details.symbol, strategyId: details.strategyId,
        approvalId: details.approvalId || null, ...gate
      });
      assertStrategyGate(gate);
      details.strategyGovernance = gate;
    }
    await revalidateEntry();
    const intent = createOrderIntent(details);
    state.pendingOrder = intent;
    await saveJson(statePath, state);
    await trace("order_intent", "persisted", {
      intentId: intent.intentId,
      side: intent.side,
      symbol: intent.symbol,
      address: intent.address,
      strategyId: intent.strategyId,
      strategyGovernance: intent.strategyGovernance || null,
      approvalId: intent.approvalId || null
    });

    try {
      await ensureNotEmergencyStopped(emergencyStopPath, state);
      await revalidateEntry();
    } catch (error) {
      // The swap was never invoked, so the intent is known not to exist on
      // chain. Clearing it avoids a false REVIEW_REQUIRED halt after resume.
      state.pendingOrder = null;
      await saveJson(statePath, state);
      await trace("order_intent", "cancelled", {
        intentId: intent.intentId,
        side: intent.side,
        symbol: intent.symbol,
        reason: error.code || error.message
      });
      throw error;
    }

    try {
      const result = await swap(config, details.fromTokenQty, details.fromToken, details.toToken);
      state.pendingOrder = {
        ...intent,
        status: "SUBMITTED",
        orderId: result.orderId,
        submittedAt: isoNow()
      };
      await saveJson(statePath, state);
      return result;
    } catch (error) {
      state.pendingOrder = {
        ...intent,
        status: "AMBIGUOUS",
        ambiguousAt: isoNow(),
        lastError: error.message
      };
      await saveJson(statePath, state);
      await trace("order_submission", "ambiguous", {
        intentId: intent.intentId,
        side: intent.side,
        symbol: intent.symbol,
        error: error.message
      });
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
      String(now()),
      "--pageSize",
      "100",
      "--binanceChainId",
      chainId
    ]);
    const matches = matchingOrdersForIntent(data.list || [], pending);
    if (matches.length === 1) {
      state.pendingOrder = {
        ...pending,
        status: "SUBMITTED",
        orderId: matches[0].orderId,
        reconciledAt: isoNow()
      };
      await saveJson(statePath, state);
      await trace("order_recovery", "reconciled", {
        intentId: pending.intentId,
        orderId: matches[0].orderId
      });
      return "RECONCILED";
    }

    state.pendingOrder = {
      ...pending,
      status: "REVIEW_REQUIRED",
      reviewReason: matches.length === 0 ? "NO_MATCHING_ORDER" : "MULTIPLE_MATCHING_ORDERS",
      reviewedAt: isoNow()
    };
    await saveJson(statePath, state);
    await trace("order_recovery", "halted", {
      intentId: pending.intentId,
      matchCount: matches.length,
      reason: state.pendingOrder.reviewReason
    });
    return "REVIEW_REQUIRED";
  }

  // Returns NONE, REVIEW_REQUIRED, HALTED or POLL. Only POLL may continue to
  // read the order status; every other outcome ends the cycle's order work.
  async function recoverPendingOrder(state, statePath) {
    const pending = state.pendingOrder;
    const action = recoveryActionForPending(pending);
    if (action === "RECONCILE") {
      const result = await reconcilePendingOrder(state, statePath);
      return result === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "POLL";
    }
    if (action === "HALT") {
      await trace("pending_order", "halted", {
        intentId: pending.intentId,
        reason: pending.reviewReason || "review_required"
      });
      return "HALTED";
    }
    return action;
  }

  // Consumes the recorded decision for state.approvalRequest. WAITING leaves
  // the request in place; every other status clears it exactly once.
  async function resolveApprovalRequest(state, statePath, decisionDirectory) {
    const request = state.approvalRequest;
    const decision = await loadApprovalDecision(decisionDirectory, request.approvalId);
    const outcome = approvalDecisionStatus(request, decision, now());
    if (outcome.status === "WAITING") {
      await trace("trade_approval", "waiting", {
        approvalId: request.approvalId,
        side: request.side,
        symbol: request.symbol,
        expiresAt: request.expiresAt
      });
      return outcome;
    }

    state.approvalRequest = null;
    state.lastApprovalDecision = {
      approvalId: request.approvalId,
      side: request.side,
      symbol: request.symbol,
      status: outcome.status,
      decidedAt: decision?.decidedAt || isoNow()
    };
    await saveJson(statePath, state);
    await trace("trade_approval", outcome.status === "APPROVED" ? "approved" : "closed", {
      approvalId: request.approvalId,
      side: request.side,
      symbol: request.symbol,
      outcome: outcome.status
    });
    return outcome;
  }

  return {
    ensureNotEmergencyStopped,
    submitOrder,
    reconcilePendingOrder,
    recoverPendingOrder,
    resolveApprovalRequest
  };
}
