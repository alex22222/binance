// Add a comparable hypothetical-exit view; never rewrite legacy fills or NAV.
const number = value => value != null && Number.isFinite(Number(value)) ? Number(value) : null;

export function paperExitValuation(state) {
  const p = state.position;
  const basis = "HYPOTHETICAL_EXIT_AFTER_MODEL_COSTS";
  if (!p) return { valuationBasis: basis, hypotheticalExitNetPnlUsdt: null,
    estimatedExitCostUsdt: 0, liquidationEquityUsdt: number(state.equityUsdt),
    liquidationReturnPct: number(state.totalReturnPct), costModel: null };
  const value = number(p.quantity) != null && number(p.markPrice) != null ? Number(p.quantity) * Number(p.markPrice) : null;
  const capital = number(p.entryCapitalUsdt ?? p.notionalUsdt);
  if (value == null || capital == null || capital <= 0) return { valuationBasis: basis,
    hypotheticalExitNetPnlUsdt: null, estimatedExitCostUsdt: null, liquidationEquityUsdt: null, liquidationReturnPct: null, costModel: "UNKNOWN" };
  const weekly = number(p.entryCapitalUsdt) != null;
  const ratePct = weekly ? number(state.roundTripCostPct) ?? (number(p.entryCostUsdt) != null ? Number(p.entryCostUsdt) / capital * 200 : null)
    : number(p.grossReturnPct) != null && number(p.netReturnPct) != null ? Number(p.grossReturnPct) - Number(p.netReturnPct) : null;
  if (ratePct == null || ratePct < 0 || ratePct >= 100) return { valuationBasis: basis,
    hypotheticalExitNetPnlUsdt: null, estimatedExitCostUsdt: null, liquidationEquityUsdt: null, liquidationReturnPct: null, costModel: "UNKNOWN" };
  const exitCost = weekly ? value * ratePct / 200 : capital * ratePct / 200;
  const netPnl = weekly ? value - exitCost - capital : value - capital - capital * ratePct / 100;
  const equity = number(state.equityUsdt);
  const liquidationEquity = weekly && equity != null ? equity - exitCost : null;
  return { valuationBasis: basis, hypotheticalExitNetPnlUsdt: netPnl, estimatedExitCostUsdt: exitCost,
    liquidationEquityUsdt: liquidationEquity,
    liquidationReturnPct: liquidationEquity != null && number(state.initialCapitalUsdt) > 0 ? (liquidationEquity / Number(state.initialCapitalUsdt) - 1) * 100 : null,
    costModel: weekly ? "BUY_BUDGET_SELL_PROCEEDS_PERCENT" : "LEGACY_FLAT_NOTIONAL_ROUND_TRIP", roundTripCostPct: ratePct };
}
