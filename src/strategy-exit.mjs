export function dynamicExitDecision({
  returnPct,
  initialRiskPct,
  atr15Pct,
  peakReturnPct = 0,
  profitProtectionActive = false,
  openedAtMs,
  nowMs = Date.now(),
  signalValid,
  disasterStopLossPct,
  profitProtectionR,
  trailingAtrMultiplier,
  finalTakeProfitR,
  signalReviewHours,
  signalReviewMinR,
  profitFloorPct = 0
}) {
  const updatedPeakReturnPct = Math.max(Number.isFinite(peakReturnPct) ? peakReturnPct : 0, returnPct);
  const protectionThresholdPct = initialRiskPct * profitProtectionR;
  const protectionActive = profitProtectionActive || updatedPeakReturnPct >= protectionThresholdPct;
  const trailingStopPct = protectionActive
    ? Math.max(profitFloorPct, updatedPeakReturnPct - atr15Pct * trailingAtrMultiplier)
    : null;
  const common = {
    returnPct,
    peakReturnPct: updatedPeakReturnPct,
    profitProtectionActive: protectionActive,
    trailingStopPct,
    protectionThresholdPct,
    finalTakeProfitPct: initialRiskPct * finalTakeProfitR
  };
  const epsilon = 1e-9;

  if (returnPct <= -Math.abs(disasterStopLossPct) + epsilon) {
    return { type: "DISASTER_STOP", ...common };
  }
  if (returnPct <= -Math.abs(initialRiskPct) + epsilon) {
    return { type: "INITIAL_STOP", ...common };
  }
  if (returnPct >= common.finalTakeProfitPct - epsilon) {
    return { type: "TAKE_PROFIT_2R", ...common };
  }
  if (protectionActive && returnPct <= trailingStopPct + epsilon) {
    return { type: "TRAILING_STOP", ...common };
  }

  const heldMs = Math.max(0, nowMs - openedAtMs);
  const reviewAfterMs = signalReviewHours * 60 * 60_000;
  const minimumProgressPct = initialRiskPct * signalReviewMinR;
  if (heldMs >= reviewAfterMs && signalValid === false && returnPct < minimumProgressPct) {
    return {
      type: "SIGNAL_TIMEOUT",
      ...common,
      heldMs,
      minimumProgressPct
    };
  }
  return {
    type: null,
    ...common,
    heldMs,
    minimumProgressPct
  };
}
