import { createHash } from "node:crypto";
import { normalizeTokenAmount, sameTokenAmount } from "./token-amount.mjs";
import { openPositions } from "./position-state.mjs";

export const ALLOCATION_STRATEGY_ID = "weekly-etf-dual-momentum-defense";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export function allocationConfigErrors(config) {
  const p = config.weeklyEtfAllocation;
  if (p == null) return [];
  return config.defaultStrategyId === ALLOCATION_STRATEGY_ID && config.maxOpenPositions === 1 &&
    p.allocationPct === 50 && p.cashReservePct === 50 && p.maxSingleLossUsdt === 20 &&
    config.disasterStopLossPct === 8 && config.maxTradeUsdt > 0 && config.maxTradeUsdt <= 250
    ? [] : ["weeklyEtfAllocation requires weekly ETF, 50% allocation, 50% reserve, 20U risk, 8% disaster stop, one position and <=250U cap"];
}

export function positionFingerprint(position) {
  return createHash("sha256").update(JSON.stringify({
    strategyId: position.strategyId, symbol: position.symbol, address: position.address.toLowerCase(),
    quantity: normalizeTokenAmount(position.quantity), costBasisUsdt: position.costBasisUsdt,
    openedAt: position.openedAt, orderId: position.orderId
  })).digest("hex");
}

export function topUpEligible(state, gate, position) {
  const request = gate.topUpRequest;
  return Boolean(position?.strategyId === ALLOCATION_STRATEGY_ID && request?.requestId &&
    request.positionHash === positionFingerprint(position) && !state.allocationTopUps?.[request.requestId]);
}

// A risk budget, not an execution guarantee. Include the entire existing cost,
// adverse quote/price buffers and all entry/exit Gas, not just the new ticket.
export function allocationPlan(config, position, snapshot, frozenAmount = null) {
  const p = config.weeklyEtfAllocation;
  const cash = Number(snapshot.cashUsdt);
  const value = snapshot.positionValueUsdt;
  const cost = position ? Number(position.costBasisUsdt) : 0;
  const entryGas = position ? Number(position.entryGasUsdt) : 0;
  const gas = snapshot.gasUsdt;
  const riskPct = config.disasterStopLossPct + config.maxRoundTripCostPct + config.executionBufferPct + config.slippagePct;
  if (!p || allocationConfigErrors(config).length ||
      ![cash, value, cost, entryGas, gas, snapshot.nativeGasValueUsdt, riskPct].every(Number.isFinite) ||
      cash < 0 || value < 0 || cost < 0 || entryGas < 0 || gas < 0 || riskPct <= 0 ||
      snapshot.nativeGasValueUsdt < Math.max(0.01, gas * 2)) return { allowed: false, reason: "INVALID_ALLOCATION_INPUT_OR_GAS" };
  const portfolioUsdt = cash + value;
  const cashReserveUsdt = portfolioUsdt * p.cashReservePct / 100;
  const targetValueUsdt = portfolioUsdt * p.allocationPct / 100;
  const budgetAmount = Math.min(targetValueUsdt - value, cash - cashReserveUsdt,
    (p.maxSingleLossUsdt - entryGas - gas) / (riskPct / 100) - cost, config.maxTradeUsdt - cost);
  const maxAmount = Math.floor(Math.max(0, budgetAmount) * 1e6) / 1e6;
  const amount = frozenAmount == null ? maxAmount : Number(frozenAmount);
  if (!Number.isFinite(amount) || amount < 1 || amount > maxAmount + 1e-9) {
    return { allowed: false, reason: "ALLOCATION_RESERVE_OR_RISK_LIMIT", maxAmountUsdt: maxAmount };
  }
  return {
    allowed: true, amountUsdt: normalizeTokenAmount(amount.toFixed(6)), portfolioUsdt, targetValueUsdt,
    positionValueUsdt: value, positionCostAfterUsdt: cost + amount,
    cashReserveUsdt, cashAfterUsdt: cash - amount,
    estimatedLossUsdt: (cost + amount) * riskPct / 100 + entryGas + gas,
    riskPct, positionHash: position ? positionFingerprint(position) : null,
    checkedAt: snapshot.checkedAt, positionQuotedAt: snapshot.positionQuotedAt
  };
}

export function allocationExecutionAllowed(config, state, details, gate, snapshot, nowMs = Date.now()) {
  if (details.strategyId !== ALLOCATION_STRATEGY_ID || gate.allowed !== true ||
      !config.weeklyEtfAllocation || !sameAddress(details.fromToken, USDT) ||
      !sameAddress(details.toToken, details.address) || !["QQQ", "SPY", "SGOV"].includes(details.symbol) ||
      !Number.isFinite(state.realizedPnlUsdt) || state.realizedPnlUsdt <= -config.dailyLossLimitUsdt) return false;
  const policy = gate.limits?.weeklyEtfAllocation;
  if (!policy || !["allocationPct", "cashReservePct", "maxSingleLossUsdt"].every(key => policy[key] === config.weeklyEtfAllocation[key])) return false;
  const positions = openPositions(state);
  const position = positions[0] || null;
  if (positions.length > 1) return false;
  const age = nowMs - Date.parse(snapshot.checkedAt || "");
  const quoteAge = nowMs - Date.parse(snapshot.positionQuotedAt || "");
  if (!Number.isFinite(age) || age < 0 || age > config.quoteMaxAgeSeconds * 1000 ||
      (position && (!Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > config.quoteMaxAgeSeconds * 1000))) return false;
  if (position) {
    if (details.entryType !== "TOP_UP" || !topUpEligible(state, gate, position) ||
        details.topUpRequestId !== gate.topUpRequest.requestId || details.parentOrderId !== position.orderId ||
        details.symbol !== position.symbol || !sameAddress(details.address, position.address) ||
        details.allocation?.positionHash !== positionFingerprint(position) ||
        !sameTokenAmount(details.tokenBefore, position.quantity) ||
        !sameTokenAmount(snapshot.tokenBefore, position.quantity)) return false;
  } else if (details.entryType !== "NEW_POSITION" || details.topUpRequestId ||
      !sameTokenAmount(snapshot.tokenBefore, "0") || !sameTokenAmount(details.tokenBefore, "0")) return false;
  return sameTokenAmount(details.fromTokenQty, details.costBasisUsdt) &&
    allocationPlan(config, position, snapshot, details.fromTokenQty).allowed;
}

function tokenDelta(after, before) {
  const values = [after, before].map(normalizeTokenAmount);
  const decimals = Math.max(...values.map(value => (value.split(".")[1] || "").length));
  const integer = value => { const [whole, fraction = ""] = value.split("."); return BigInt(whole + fraction.padEnd(decimals, "0")); };
  const delta = integer(values[0]) - integer(values[1]);
  if (delta <= 0n) throw new Error("Allocation fill did not increase the token balance");
  const digits = delta.toString().padStart(decimals + 1, "0");
  return normalizeTokenAmount(decimals ? digits.slice(0, -decimals) + "." + digits.slice(-decimals) : digits);
}

export function mergeAllocationFill(state, pending, quantity, entryGas) {
  const position = openPositions(state)[0];
  if (pending.entryType !== "TOP_UP" || !position || openPositions(state).length !== 1 ||
      positionFingerprint(position) !== pending.allocation?.positionHash ||
      !sameTokenAmount(position.quantity, pending.tokenBefore) || state.allocationTopUps?.[pending.topUpRequestId]) {
    throw new Error("Top-up position changed or request already consumed");
  }
  if (![position.entryGasUsdt, entryGas.gasUsdt, pending.costBasisUsdt].every(value =>
    value != null && Number.isFinite(Number(value)) && Number(value) >= 0) || !(Number(pending.costBasisUsdt) > 0)) {
    throw new Error("Top-up cost or Gas is unavailable; reconciliation required");
  }
  const delta = tokenDelta(quantity, pending.tokenBefore);
  const addition = { orderId: pending.orderId, approvalId: pending.approvalId || null,
    requestId: pending.topUpRequestId, quantity: delta, costBasisUsdt: Number(pending.costBasisUsdt),
    entryGasUsdt: entryGas.gasUsdt, entryGasBnb: entryGas.gasBnb ?? null, entryGasSource: entryGas.source,
    txHash: entryGas.txHash || null, createdAt: pending.createdAt,
    strategyGovernance: pending.strategyGovernance || null };
  const merged = { ...position, quantity: normalizeTokenAmount(quantity),
    costBasisUsdt: Number(position.costBasisUsdt) + addition.costBasisUsdt,
    entryGasUsdt: Number(position.entryGasUsdt) + entryGas.gasUsdt,
    entryGasBnb: Number.isFinite(position.entryGasBnb) && Number.isFinite(entryGas.gasBnb)
      ? position.entryGasBnb + entryGas.gasBnb : null,
    entryGasSource: position.entryGasSource === "ACTUAL_RECEIPT" && entryGas.source === "ACTUAL_RECEIPT" ? "ACTUAL_RECEIPT" : "MIXED_OR_ESTIMATED",
    additions: [...(position.additions || []), addition], allocation: pending.allocation,
    excursionPartial: true, lastQuoteAt: null, lastQuoteProceedsUsdt: null,
    excursionBeforeTopUp: { peakReturnPct: position.peakReturnPct, worstReturnPct: position.worstReturnPct },
    peakReturnPct: 0, worstReturnPct: 0 };
  state.positions = [merged];
  state.allocationTopUps = { ...(state.allocationTopUps || {}),
    [pending.topUpRequestId]: { status: "FINISHED", orderId: pending.orderId, completedAt: new Date().toISOString() } };
  return merged;
}
