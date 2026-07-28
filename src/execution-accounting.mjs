const WEI_PER_BNB = 10n ** 18n;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function gasCostFromReceipt({ receipt, bnbUsdtPrice }) {
  const gasUsed = BigInt(receipt?.gasUsed || 0);
  const gasPrice = BigInt(receipt?.effectiveGasPrice || 0);
  const gasWei = gasUsed * gasPrice;
  const gasBnb = Number(gasWei) / Number(WEI_PER_BNB);
  return {
    txHash: receipt?.transactionHash || null,
    gasBnb,
    gasUsdt: gasBnb * finiteNonNegative(bnbUsdtPrice)
  };
}

export function realizedTradePnl({
  proceedsUsdt,
  costBasisUsdt,
  entryGasUsdt = 0,
  exitGasUsdt = 0
}) {
  const grossPnlUsdt = Number(proceedsUsdt) - Number(costBasisUsdt);
  const gasCostUsdt = finiteNonNegative(entryGasUsdt) + finiteNonNegative(exitGasUsdt);
  return {
    grossPnlUsdt,
    gasCostUsdt,
    netPnlUsdt: grossPnlUsdt - gasCostUsdt
  };
}

export function updateReturnExcursion(position, returnPct) {
  const currentReturnPct = Number(returnPct);
  const previousWorst = Number(position?.worstReturnPct);
  const previousPeak = Number(position?.peakReturnPct);
  return {
    worstReturnPct: Number.isFinite(currentReturnPct)
      ? Math.min(Number.isFinite(previousWorst) ? previousWorst : 0, currentReturnPct)
      : Number.isFinite(previousWorst) ? previousWorst : 0,
    peakReturnPct: Number.isFinite(currentReturnPct)
      ? Math.max(Number.isFinite(previousPeak) ? previousPeak : 0, currentReturnPct)
      : Number.isFinite(previousPeak) ? previousPeak : 0
  };
}

export function tradeExcursionMetrics({
  costBasisUsdt,
  initialRiskPct,
  worstReturnPct,
  peakReturnPct,
  netPnlUsdt
}) {
  const costBasis = Number(costBasisUsdt);
  const riskPct = Number(initialRiskPct);
  const riskUsdt = costBasis > 0 && riskPct > 0 ? costBasis * riskPct / 100 : null;
  const maePct = Number.isFinite(Number(worstReturnPct)) ? Number(worstReturnPct) : null;
  const mfePct = Number.isFinite(Number(peakReturnPct)) ? Number(peakReturnPct) : null;
  return {
    riskUsdt,
    maePct,
    mfePct,
    maeR: riskPct > 0 && maePct != null ? maePct / riskPct : null,
    mfeR: riskPct > 0 && mfePct != null ? mfePct / riskPct : null,
    realizedR: riskUsdt > 0 && Number.isFinite(Number(netPnlUsdt))
      ? Number(netPnlUsdt) / riskUsdt
      : null
  };
}

export function noLossExitDecision({
  proceedsUsdt,
  costBasisUsdt,
  entryGasUsdt = 0,
  exitGasUsdt = 0,
  slippagePct = 0
}) {
  const slippage = Math.min(100, finiteNonNegative(slippagePct));
  const worstCaseProceedsUsdt = Number(proceedsUsdt) * (1 - slippage / 100);
  const { netPnlUsdt } = realizedTradePnl({
    proceedsUsdt: worstCaseProceedsUsdt,
    costBasisUsdt,
    entryGasUsdt,
    exitGasUsdt
  });
  return {
    allowed: Number.isFinite(netPnlUsdt) && netPnlUsdt >= 0,
    worstCaseProceedsUsdt,
    netPnlUsdt
  };
}

export function effectiveRoundTripGasEstimate({
  configuredGasUsdt,
  observations = [],
  minimumSamples = 10
}) {
  const values = observations
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (values.length < minimumSamples) {
    return {
      gasUsdt: finiteNonNegative(configuredGasUsdt),
      source: "CONFIGURED",
      sampleCount: values.length
    };
  }
  const index = Math.max(0, Math.ceil(values.length * 0.9) - 1);
  return {
    gasUsdt: values[index],
    source: "ACTUAL_P90",
    sampleCount: values.length
  };
}
