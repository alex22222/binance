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
