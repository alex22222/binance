function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value) {
  return Number.isFinite(value) ? Number(value.toFixed(12)) : null;
}

function sameAmount(left, right) {
  const leftNumber = positiveNumber(left);
  const rightNumber = positiveNumber(right);
  if (leftNumber == null || rightNumber == null) return false;
  return Math.abs(leftNumber - rightNumber) <= Math.max(leftNumber, rightNumber) * 1e-9;
}

function quoteAgeMs(quotedAt, observedAt) {
  const age = Date.parse(observedAt) - Date.parse(quotedAt || "");
  return Number.isFinite(age) ? age : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function buildExecutableBasisObservation({
  theoreticalPrice,
  tradeUsdt,
  buyQuote,
  sellQuote,
  estimatedRoundTripGasUsdt = 0,
  executionBufferPct = 0,
  observedAt = new Date().toISOString(),
  quoteMaxAgeMs = 10_000
}) {
  const observedAtIso = new Date(observedAt).toISOString();
  const fairPrice = positiveNumber(theoreticalPrice?.theoreticalTokenPrice);
  const inputUsdt = positiveNumber(tradeUsdt);
  const buyOutputToken = positiveNumber(buyQuote?.outputToken);
  const sellInputToken = positiveNumber(sellQuote?.requestedInputToken);
  const sellOutputUsdt = positiveNumber(sellQuote?.outputUsdt);
  const buyAgeMs = quoteAgeMs(buyQuote?.quotedAt, observedAtIso);
  const sellAgeMs = quoteAgeMs(sellQuote?.quotedAt, observedAtIso);
  const vetoReasons = [...(theoreticalPrice?.vetoReasons || [])];

  if (fairPrice == null) vetoReasons.push("INVALID_THEORETICAL_PRICE");
  if (!sameAmount(buyQuote?.requestedInputUsdt, inputUsdt)) {
    vetoReasons.push("BUY_QUOTE_AMOUNT_MISMATCH");
  }
  if (buyOutputToken == null) vetoReasons.push("INVALID_BUY_QUOTE_DEPTH");
  if (!sameAmount(sellInputToken, buyOutputToken)) {
    vetoReasons.push("SELL_QUOTE_AMOUNT_MISMATCH");
  }
  if (sellOutputUsdt == null) vetoReasons.push("INVALID_SELL_QUOTE_DEPTH");
  if (buyAgeMs == null || buyAgeMs < 0) vetoReasons.push("BUY_QUOTE_TIME_INVALID");
  else if (buyAgeMs > quoteMaxAgeMs) vetoReasons.push("BUY_QUOTE_STALE");
  if (sellAgeMs == null || sellAgeMs < 0) vetoReasons.push("SELL_QUOTE_TIME_INVALID");
  else if (sellAgeMs > quoteMaxAgeMs) vetoReasons.push("SELL_QUOTE_STALE");

  const executableBuyPrice = inputUsdt && buyOutputToken
    ? inputUsdt / buyOutputToken
    : null;
  const executableSellPrice = sellInputToken && sellOutputUsdt
    ? sellOutputUsdt / sellInputToken
    : null;
  const buyBasisPct = fairPrice && executableBuyPrice
    ? (executableBuyPrice / fairPrice - 1) * 100
    : null;
  const sellBasisPct = fairPrice && executableSellPrice
    ? (executableSellPrice / fairPrice - 1) * 100
    : null;
  const roundTripCostPct = inputUsdt && sellOutputUsdt
    ? (inputUsdt - sellOutputUsdt) / inputUsdt * 100
    : null;
  const gasUsdt = finiteNumber(estimatedRoundTripGasUsdt);
  const bufferPct = finiteNumber(executionBufferPct);
  const gasCostPct = inputUsdt && gasUsdt != null && gasUsdt >= 0
    ? gasUsdt / inputUsdt * 100
    : null;
  const allInCostPct = roundTripCostPct != null && gasCostPct != null && bufferPct != null && bufferPct >= 0
    ? roundTripCostPct + gasCostPct + bufferPct
    : null;
  const grossDiscountPct = buyBasisPct == null ? null : -buyBasisPct;
  const netEntryEdgePct = grossDiscountPct != null && allInCostPct != null
    ? grossDiscountPct - allInCostPct
    : null;

  if (
    fairPrice != null && executableBuyPrice != null && executableSellPrice != null &&
    vetoReasons.length === 0 && !(netEntryEdgePct > 0)
  ) {
    vetoReasons.push("NET_EXECUTABLE_EDGE_NOT_POSITIVE");
  }
  const reasons = unique(vetoReasons);

  return {
    schemaVersion: 1,
    observationType: "EXECUTABLE_BASIS",
    observedAt: observedAtIso,
    instrument: theoreticalPrice?.instrument || null,
    theoreticalPrice: fairPrice,
    theoreticalObservedAt: theoreticalPrice?.observedAt || null,
    execution: {
      buy: {
        inputUsdt,
        outputToken: buyOutputToken,
        unitPriceUsdt: rounded(executableBuyPrice),
        quotedAt: buyQuote?.quotedAt || null,
        ageMs: buyAgeMs,
        source: "AGENTIC_WALLET_AMOUNT_QUOTE"
      },
      sell: {
        inputToken: sellInputToken,
        outputUsdt: sellOutputUsdt,
        unitPriceUsdt: rounded(executableSellPrice),
        quotedAt: sellQuote?.quotedAt || null,
        ageMs: sellAgeMs,
        source: "AGENTIC_WALLET_AMOUNT_QUOTE"
      }
    },
    buyBasisPct: rounded(buyBasisPct),
    sellBasisPct: rounded(sellBasisPct),
    grossDiscountPct: rounded(grossDiscountPct),
    roundTripCostPct: rounded(roundTripCostPct),
    gasCostPct: rounded(gasCostPct),
    executionBufferPct: rounded(bufferPct),
    allInCostPct: rounded(allInCostPct),
    netEntryEdgePct: rounded(netEntryEdgePct),
    vetoReasons: reasons,
    eligibleForShadowSignal: reasons.length === 0
  };
}
