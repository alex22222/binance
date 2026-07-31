function finiteValues(values) {
  return values.map(Number).filter(Number.isFinite);
}

function sum(values) {
  return Number(values.reduce((total, value) => total + value, 0).toFixed(12));
}

function average(values) {
  return values.length ? sum(values) / values.length : null;
}

export function performanceMetrics(trades, notionalUsdt) {
  const pnl = finiteValues(trades.map(({ pnlUsdt }) => pnlUsdt));
  const returns = finiteValues(trades.map(({ returnPct }) => returnPct));
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  const mae = finiteValues(trades.map(({ maePct }) => maePct));
  const mfe = finiteValues(trades.map(({ mfePct }) => mfePct));
  const realizedR = finiteValues(trades.map(({ realizedR: value }) => value));
  const turnover = trades.flatMap((trade) => {
    const entry = Number(trade.entryValueUsdt);
    const exit = Number(trade.exitValueUsdt);
    if (Number.isFinite(entry) && Number.isFinite(exit)) return [entry, exit];
    return [notionalUsdt, notionalUsdt];
  });
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsdt = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
  }
  const pnlUsdt = sum(pnl);
  const grossProfitUsdt = sum(wins);
  const grossLossUsdt = Math.abs(sum(losses));
  const turnoverUsdt = sum(turnover);
  return {
    trades: pnl.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: pnl.length ? wins.length / pnl.length * 100 : null,
    pnlUsdt,
    returnPct: pnlUsdt / notionalUsdt * 100,
    returnOnTurnoverPct: pnl.length ? pnlUsdt / (notionalUsdt * pnl.length) * 100 : null,
    turnoverUsdt,
    returnOnExecutedTurnoverPct: turnoverUsdt ? pnlUsdt / turnoverUsdt * 100 : null,
    profitFactor: grossLossUsdt > 0 ? grossProfitUsdt / grossLossUsdt : null,
    grossProfitUsdt,
    grossLossUsdt,
    averageWinUsdt: average(wins),
    averageLossUsdt: average(losses),
    payoffRatio: wins.length && losses.length
      ? average(wins) / Math.abs(average(losses))
      : null,
    averageTradeUsdt: average(pnl),
    averageReturnPct: average(returns),
    gasCostUsdt: sum(finiteValues(trades.map(({ gasCostUsdt }) => gasCostUsdt))),
    totalCostUsdt: sum(finiteValues(trades.map(({ totalCostUsdt }) => totalCostUsdt))),
    maxDrawdownUsdt,
    maxDrawdownPct: maxDrawdownUsdt / notionalUsdt * 100,
    averageMaePct: average(mae),
    worstMaePct: mae.length ? Math.min(...mae) : null,
    averageMfePct: average(mfe),
    bestMfePct: mfe.length ? Math.max(...mfe) : null,
    averageRealizedR: average(realizedR),
    worstRealizedR: realizedR.length ? Math.min(...realizedR) : null,
    bestRealizedR: realizedR.length ? Math.max(...realizedR) : null
  };
}

export function executionMetrics(replay, trades) {
  const eventCounts = replay?.eventCounts || {};
  const orderIntents = Number(eventCounts.ORDER_INTENT || 0);
  const evidenceCounts = trades.reduce((counts, trade) => {
    const evidence = trade.executionEvidenceLevel || "UNLABELED";
    counts[evidence] = (counts[evidence] || 0) + 1;
    return counts;
  }, {});
  const sortedEvidenceCounts = Object.fromEntries(
    Object.entries(evidenceCounts).sort(([left], [right]) => left.localeCompare(right))
  );
  const labeledTrades = trades.length - (evidenceCounts.UNLABELED || 0);
  return {
    orderIntents,
    orderFills: Number(eventCounts.ORDER_FILLED || 0),
    orderRejections: Number(eventCounts.ORDER_REJECTED || 0),
    orderFailures: Number(eventCounts.ORDER_FAILED || 0),
    executionRatePct: orderIntents
      ? Number(eventCounts.ORDER_FILLED || 0) / orderIntents * 100
      : null,
    completedTrades: trades.length,
    labeledTrades,
    evidenceCoveragePct: trades.length ? labeledTrades / trades.length * 100 : null,
    evidenceCounts: sortedEvidenceCounts
  };
}
