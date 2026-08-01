export const SHADOW_BASIS_HORIZONS_MS = [3_000, 10_000, 30_000, 60_000];

export function buildShadowBasisDecision({
  signalId,
  eligibility,
  executableBasis,
  decidedAt = new Date().toISOString()
}) {
  const reasons = [...new Set([
    ...(eligibility?.vetoReasons || []),
    ...(!(Number(executableBasis?.netEntryEdgePct) > 0)
      ? ["NET_EXECUTABLE_EDGE_NOT_POSITIVE"]
      : [])
  ])];
  const allowed = eligibility?.entryAllowed === true && reasons.length === 0;

  return {
    schemaVersion: 1,
    signalId,
    decidedAt: new Date(decidedAt).toISOString(),
    decision: allowed ? "SHADOW_SIGNAL" : "BLOCKED",
    enforcedForLive: false,
    reasons,
    eligibility: eligibility || null,
    checkpointHorizonsMs: allowed ? [...SHADOW_BASIS_HORIZONS_MS] : null,
    baseline: {
      observedAt: executableBasis?.observedAt || null,
      instrument: executableBasis?.instrument || null,
      theoreticalPrice: executableBasis?.theoreticalPrice ?? null,
      buyBasisPct: executableBasis?.buyBasisPct ?? null,
      sellBasisPct: executableBasis?.sellBasisPct ?? null,
      grossDiscountPct: executableBasis?.grossDiscountPct ?? null,
      roundTripCostPct: executableBasis?.roundTripCostPct ?? null,
      gasCostPct: executableBasis?.gasCostPct ?? null,
      executionBufferPct: executableBasis?.executionBufferPct ?? null,
      allInCostPct: executableBasis?.allInCostPct ?? null,
      netEntryEdgePct: executableBasis?.netEntryEdgePct ?? null,
      execution: executableBasis?.execution || null
    },
    protectiveExitAllowed: eligibility?.protectiveExitAllowed === true
  };
}
