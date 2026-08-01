function ageMs(retrievedAt, observedAt) {
  const age = Date.parse(observedAt) - Date.parse(retrievedAt || "");
  return Number.isFinite(age) ? age : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function evaluateBstocksEligibility({
  instrument,
  universeChanges,
  assetStatus,
  statusRetrievedAt,
  companyAction,
  theoreticalPrice,
  executableBasis,
  observedAt = new Date().toISOString(),
  maxStatusAgeMs = 10_000,
  maxCompanyActionAgeMs = 86_400_000,
  maxRoundTripCostPct = 0.7
}) {
  const evaluatedAt = new Date(observedAt).toISOString();
  const categories = {
    identity: [],
    market: [],
    companyAction: [],
    referenceData: [],
    liquidity: [],
    freshness: []
  };

  if (!instrument?.instrumentId) categories.identity.push("INSTRUMENT_UNVERIFIED");
  else if (instrument.discoveryStatus !== "LIVE_ALLOWED") categories.identity.push("NOT_LIVE_ALLOWED");
  if ((universeChanges?.contractChanges || []).some(
    (change) => change.symbol === instrument?.underlyingSymbol
  )) {
    categories.identity.push("IDENTITY_CHANGED");
  }
  if ((universeChanges?.multiplierChanges || []).some(
    (change) => change.instrumentId === instrument?.instrumentId
  )) {
    categories.identity.push("MULTIPLIER_CHANGED");
  }

  if (assetStatus?.openState !== true) categories.market.push("ASSET_NOT_OPEN");
  if (assetStatus?.reasonCode !== "TRADING") categories.market.push("ASSET_NOT_TRADING");
  if (assetStatus?.marketStatus !== "regular") categories.market.push("MARKET_NOT_REGULAR");
  const statusAgeMs = ageMs(statusRetrievedAt, evaluatedAt);
  if (statusAgeMs == null || statusAgeMs < 0 || statusAgeMs > maxStatusAgeMs) {
    categories.freshness.push("MARKET_STATUS_STALE");
  }

  if (companyAction?.status === "BLOCKED" && companyAction?.source) {
    categories.companyAction.push(...(
      companyAction.vetoReasons?.length
        ? companyAction.vetoReasons
        : ["CORPORATE_ACTION_BLACKOUT"]
    ));
  } else if (companyAction?.status !== "CLEAR" || !companyAction?.source) {
    categories.companyAction.push("CORPORATE_ACTION_UNRESOLVED");
  }
  const companyActionAgeMs = ageMs(companyAction?.checkedAt, evaluatedAt);
  if (
    companyActionAgeMs == null || companyActionAgeMs < 0 ||
    companyActionAgeMs > maxCompanyActionAgeMs
  ) {
    categories.freshness.push("COMPANY_ACTION_STATUS_STALE");
  }

  if (!theoreticalPrice) {
    categories.referenceData.push("THEORETICAL_PRICE_UNAVAILABLE");
  } else {
    categories.referenceData.push(...(theoreticalPrice.vetoReasons || []));
    if (
      !theoreticalPrice.multiplier?.effectiveAt &&
      universeChanges?.baselineAvailable !== true
    ) {
      categories.referenceData.push("MULTIPLIER_BASELINE_UNAVAILABLE");
    }
  }

  if (!executableBasis) {
    categories.liquidity.push("EXECUTABLE_BASIS_UNAVAILABLE");
  } else {
    categories.liquidity.push(...(executableBasis.vetoReasons || []));
    if (
      !Number.isFinite(Number(executableBasis.roundTripCostPct)) ||
      Number(executableBasis.roundTripCostPct) > maxRoundTripCostPct
    ) {
      categories.liquidity.push("LIQUIDITY_COST_TOO_HIGH");
    }
  }

  for (const key of Object.keys(categories)) categories[key] = unique(categories[key]);
  const vetoReasons = unique([
    ...categories.identity,
    ...categories.market,
    ...categories.freshness.filter((reason) => reason === "MARKET_STATUS_STALE"),
    ...categories.companyAction,
    ...categories.freshness.filter((reason) => reason === "COMPANY_ACTION_STATUS_STALE"),
    ...categories.referenceData,
    ...categories.liquidity
  ]);

  return {
    schemaVersion: 1,
    evaluatedAt,
    entryAllowed: vetoReasons.length === 0,
    protectiveExitAllowed: true,
    vetoReasons,
    checks: {
      identity: categories.identity.length === 0,
      market: categories.market.length === 0,
      companyAction: categories.companyAction.length === 0,
      referenceData: categories.referenceData.length === 0,
      liquidity: categories.liquidity.length === 0,
      freshness: categories.freshness.length === 0
    }
  };
}
