export function uniqueSymbols(symbols) {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))];
}

export function validateConfig(config) {
  const errors = [];
  if (!["shadow", "live"].includes(config.mode)) errors.push("mode must be shadow or live");
  if (!Array.isArray(config.symbols) || config.symbols.length === 0) errors.push("symbols must not be empty");
  if (!(config.maxTradeUsdt > 0 && config.maxTradeUsdt <= 50)) errors.push("maxTradeUsdt must be between 0 and 50");
  if (!(config.dailyLossLimitUsdt > 0 && config.dailyLossLimitUsdt <= 10)) errors.push("dailyLossLimitUsdt must be between 0 and 10");
  if (config.maxOpenPositions !== 1) errors.push("maxOpenPositions must be 1");
  if (!(config.stopLossPct > 0)) errors.push("stopLossPct must be positive");
  if (!(config.takeProfitPct > 0)) errors.push("takeProfitPct must be positive");
  if (typeof config.allowUnsupportedAuditForOfficialRwa !== "boolean") {
    errors.push("allowUnsupportedAuditForOfficialRwa must be boolean");
  }
  if (typeof config.traceFile !== "string" || !config.traceFile.trim()) {
    errors.push("traceFile must not be empty");
  }
  if (errors.length) throw new Error(errors.join("; "));
}

export function auditDecision({
  hasResult,
  isSupported,
  riskLevel,
  riskLevelEnum,
  hits = [],
  buyTax = 0,
  sellTax = 0,
  isOfficialRwa = false,
  allowUnsupportedOfficialRwa = false
}) {
  if (!hasResult || !isSupported) {
    if (isOfficialRwa && allowUnsupportedOfficialRwa) {
      return {
        allowed: true,
        status: "OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED"
      };
    }
    throw new Error("Token audit data is unavailable");
  }
  if (riskLevel > 1 || hits.length || buyTax > 5 || sellTax > 5) {
    throw new Error(`Token audit blocked trade: risk=${riskLevelEnum}, hits=${hits.length}, buyTax=${buyTax}, sellTax=${sellTax}`);
  }
  return {
    allowed: true,
    status: "SUPPORTED_LOW_RISK",
    riskLevel: riskLevelEnum,
    buyTax,
    sellTax
  };
}

export function dailyLossReached(realizedPnlUsdt, limitUsdt) {
  return realizedPnlUsdt <= -Math.abs(limitUsdt);
}

export function exitReason({ proceedsUsdt, costBasisUsdt, stopLossPct, takeProfitPct }) {
  if (!(costBasisUsdt > 0)) return null;
  const returnPct = ((proceedsUsdt / costBasisUsdt) - 1) * 100;
  const epsilon = 1e-9;
  if (returnPct <= -Math.abs(stopLossPct) + epsilon) return { type: "STOP_LOSS", returnPct };
  if (returnPct >= Math.abs(takeProfitPct) - epsilon) return { type: "TAKE_PROFIT", returnPct };
  return null;
}

export function analyzeCandles(candles, nowMs = Date.now()) {
  const closed = candles.filter((candle) => Number(candle[6]) < nowMs);
  const recent = closed.slice(-16);
  if (recent.length < 16) return null;

  const closes = recent.map((candle) => Number(candle[4]));
  const changes = closes.slice(1).map((value, index) => value - closes[index]);
  const upMinutes = changes.filter((change) => change > 0).length;
  const downMinutes = changes.filter((change) => change < 0).length;
  const trend15mPct = ((closes.at(-1) / closes[0]) - 1) * 100;

  return {
    trend15mPct,
    upMinutes,
    downMinutes,
    lastPrice: closes.at(-1),
    lastCandleTime: Number(recent.at(-1)[0])
  };
}

export function roundTripCostPct(spendUsdt, quotedProceedsUsdt) {
  return (1 - (quotedProceedsUsdt / spendUsdt)) * 100;
}

export function pendingOrderAction(status) {
  if (!status || status === "PENDING") return "WAIT";
  if (status === "FAILED") return "FAIL";
  if (status === "FINISHED") return "FINISH";
  return "WAIT";
}

export function rankCandidates(candidates, config) {
  return candidates
    .filter((candidate) => candidate.openState && candidate.reasonCode === "TRADING")
    .filter((candidate) => candidate.trend15mPct >= config.minTrend15mPct)
    .filter((candidate) => candidate.upMinutes >= config.minDirectionalMinutes)
    .filter((candidate) => candidate.roundTripCostPct <= config.maxRoundTripCostPct)
    .sort((left, right) => {
      const leftScore = left.trend15mPct - left.roundTripCostPct;
      const rightScore = right.trend15mPct - right.roundTripCostPct;
      return rightScore - leftScore;
    });
}
