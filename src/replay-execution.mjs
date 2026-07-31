function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function rejected({
  orderId,
  side,
  executedAtMs,
  evidenceLevel,
  reason,
  gasUsdt = 0,
  status = "REJECTED",
  quoteAgeMs = null,
  quoteDriftPct = null
}) {
  return {
    status,
    reason,
    evidenceLevel,
    orderId,
    side,
    executedAtMs,
    fillPrice: null,
    fillQuantity: 0,
    inputAmount: null,
    outputAmount: null,
    gasUsdt: finiteNonNegative(gasUsdt),
    quoteAgeMs,
    quoteDriftPct
  };
}

export function executeReplayOrder({
  model = "CANDLE_PROXY",
  orderId,
  side,
  executedAtMs,
  candlePrice,
  notionalUsdt,
  quantity,
  quote,
  expectedOutputAmount,
  maxQuoteAgeMs = 10_000,
  maxQuoteDriftPct = 0.3,
  gasUsdt = 0
}) {
  if (!["BUY", "SELL"].includes(side)) throw new Error("Replay order side must be BUY or SELL");
  if (!Number.isFinite(executedAtMs)) throw new Error("Replay execution time must be finite");

  if (model === "CANDLE_PROXY") {
    const fillPrice = finitePositive(candlePrice);
    const requestedInput = side === "BUY"
      ? finitePositive(notionalUsdt)
      : finitePositive(quantity);
    if (!(fillPrice && requestedInput)) {
      return rejected({
        orderId,
        side,
        executedAtMs,
        evidenceLevel: "CANDLE_PROXY",
        reason: "INVALID_CANDLE_PROXY_INPUT",
        gasUsdt
      });
    }
    const outputAmount = side === "BUY"
      ? requestedInput / fillPrice
      : requestedInput * fillPrice;
    return {
      status: "FILLED",
      reason: "CANDLE_PROXY_FILL",
      evidenceLevel: "CANDLE_PROXY",
      orderId,
      side,
      executedAtMs,
      fillPrice,
      fillQuantity: side === "BUY" ? outputAmount : requestedInput,
      inputAmount: requestedInput,
      outputAmount,
      gasUsdt: finiteNonNegative(gasUsdt),
      quoteAgeMs: null,
      quoteDriftPct: null
    };
  }

  if (model !== "QUOTE_REPLAY") throw new Error(`Unsupported replay execution model: ${model}`);
  if (!quote) {
    return rejected({
      orderId,
      side,
      executedAtMs,
      evidenceLevel: "QUOTE_REPLAY",
      reason: "MISSING_QUOTE",
      gasUsdt
    });
  }

  const quotedAtMs = Date.parse(quote.quotedAt || "");
  const inputAmount = finitePositive(quote.inputAmount);
  const outputAmount = finitePositive(quote.outputAmount);
  if (!(Number.isFinite(quotedAtMs) && inputAmount && outputAmount)) {
    return rejected({
      orderId,
      side,
      executedAtMs,
      evidenceLevel: "QUOTE_REPLAY",
      reason: "INVALID_QUOTE",
      gasUsdt
    });
  }
  const quoteAgeMs = executedAtMs - quotedAtMs;
  if (quotedAtMs > executedAtMs) {
    return rejected({
      orderId,
      side,
      executedAtMs,
      evidenceLevel: "QUOTE_REPLAY",
      reason: "FUTURE_QUOTE",
      gasUsdt,
      quoteAgeMs
    });
  }
  if (quoteAgeMs > maxQuoteAgeMs) {
    return rejected({
      orderId,
      side,
      executedAtMs,
      evidenceLevel: "QUOTE_REPLAY",
      reason: "STALE_QUOTE",
      gasUsdt,
      quoteAgeMs
    });
  }
  const requestedInput = side === "BUY"
    ? finitePositive(notionalUsdt)
    : finitePositive(quantity);
  if (!requestedInput) {
    return rejected({
      orderId,
      side,
      executedAtMs,
      evidenceLevel: "QUOTE_REPLAY",
      reason: "INVALID_ORDER_AMOUNT",
      gasUsdt,
      quoteAgeMs
    });
  }
  if (Math.abs(inputAmount / requestedInput - 1) > 1e-9) {
    return rejected({
      orderId,
      side,
      executedAtMs,
      evidenceLevel: "QUOTE_REPLAY",
      reason: "QUOTE_INPUT_MISMATCH",
      gasUsdt,
      quoteAgeMs
    });
  }
  const expectedOutput = finitePositive(expectedOutputAmount);
  const quoteDriftPct = expectedOutput
    ? Math.abs(outputAmount / expectedOutput - 1) * 100
    : null;
  if (quoteDriftPct != null && quoteDriftPct > maxQuoteDriftPct) {
    return rejected({
      orderId,
      side,
      executedAtMs,
      evidenceLevel: "QUOTE_REPLAY",
      reason: "QUOTE_DRIFT",
      gasUsdt,
      quoteAgeMs,
      quoteDriftPct
    });
  }
  if (quote.terminalStatus === "FAILED_ONCHAIN") {
    return rejected({
      orderId,
      side,
      executedAtMs,
      evidenceLevel: "QUOTE_REPLAY",
      reason: "FAILED_ONCHAIN",
      gasUsdt,
      status: "FAILED",
      quoteAgeMs,
      quoteDriftPct
    });
  }

  return {
    status: "FILLED",
    reason: "QUOTE_REPLAY_FILL",
    evidenceLevel: "QUOTE_REPLAY",
    orderId,
    side,
    executedAtMs,
    fillPrice: side === "BUY" ? inputAmount / outputAmount : outputAmount / inputAmount,
    fillQuantity: side === "BUY" ? outputAmount : inputAmount,
    inputAmount,
    outputAmount,
    gasUsdt: finiteNonNegative(gasUsdt),
    quoteAgeMs,
    quoteDriftPct
  };
}
