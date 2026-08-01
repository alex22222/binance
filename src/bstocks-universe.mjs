export const BSTOCKS_UNIVERSE_SOURCE =
  "binance_web3_rwa_stock_detail_list";

function normalizedSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizedChainId(value) {
  return String(value || "").trim();
}

function normalizedAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function addressesBySymbol(universe) {
  const result = new Map();
  for (const asset of universe?.assets || []) {
    const addresses = result.get(asset.underlyingSymbol) || [];
    addresses.push(asset.contractAddress);
    result.set(asset.underlyingSymbol, addresses);
  }
  return result;
}

export function buildBstocksUniverse(items, {
  chainId = "56",
  liveAllowlist = [],
  discoveredAt = new Date().toISOString(),
  source = BSTOCKS_UNIVERSE_SOURCE
} = {}) {
  const selectedChainId = normalizedChainId(chainId);
  const allowedSymbols = new Set(liveAllowlist.map(normalizedSymbol).filter(Boolean));
  const assets = [];
  const rejected = [];
  let ignoredOtherChainCount = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const itemChainId = normalizedChainId(item?.chainId);
    const symbol = normalizedSymbol(item?.ticker);
    const contractAddress = String(item?.contractAddress || "").trim();
    const addressKey = normalizedAddress(contractAddress);

    if (itemChainId !== selectedChainId) {
      ignoredOtherChainCount += 1;
      continue;
    }
    if (!symbol || !addressKey) {
      rejected.push({
        ticker: symbol || null,
        chainId: itemChainId || null,
        contractAddress: contractAddress || null,
        reason: "INVALID_IDENTITY"
      });
      continue;
    }

    assets.push({
      ...item,
      ticker: symbol,
      underlyingSymbol: symbol,
      chainId: itemChainId,
      contractAddress,
      instrumentId: `binance-web3-rwa:bsc:${addressKey}`,
      productType: "BSC_WEB3_RWA",
      provider: "BINANCE_WEB3",
      isOfficialRwa: true,
      discoveryStatus: allowedSymbols.has(symbol) ? "LIVE_ALLOWED" : "RESEARCH_ONLY",
      discovery: {
        source,
        discoveredAt
      }
    });
  }

  assets.sort((left, right) => (
    left.underlyingSymbol.localeCompare(right.underlyingSymbol) ||
    left.instrumentId.localeCompare(right.instrumentId)
  ));

  return {
    schemaVersion: 1,
    source,
    discoveredAt,
    chainId: selectedChainId,
    liveAllowlist: [...allowedSymbols].sort(),
    liveAllowedSymbols: [...new Set(
      assets
        .filter((asset) => asset.discoveryStatus === "LIVE_ALLOWED")
        .map((asset) => asset.underlyingSymbol)
    )].sort(),
    researchOnlySymbols: [...new Set(
      assets
        .filter((asset) => asset.discoveryStatus === "RESEARCH_ONLY")
        .map((asset) => asset.underlyingSymbol)
    )].sort(),
    ignoredOtherChainCount,
    assets,
    rejected
  };
}

export function resolveLiveAllowedAssets(universe, requestedSymbols) {
  const requested = [...new Set(requestedSymbols.map(normalizedSymbol).filter(Boolean))];
  const allowed = new Set(universe.liveAllowlist || []);
  const bySymbol = addressesBySymbol(universe);
  const missing = [];
  const ambiguous = [];
  const result = new Map();

  for (const symbol of requested) {
    if (!allowed.has(symbol)) {
      throw new Error(`Symbol is not in the configured Live allowlist: ${symbol}`);
    }
    const matches = (universe.assets || []).filter(
      (asset) => asset.underlyingSymbol === symbol && asset.discoveryStatus === "LIVE_ALLOWED"
    );
    if (matches.length === 0) missing.push(symbol);
    else if (matches.length > 1 || (bySymbol.get(symbol) || []).length > 1) ambiguous.push(symbol);
    else result.set(symbol, matches[0]);
  }

  if (ambiguous.length) throw new Error(`Ambiguous BSC contracts for ${ambiguous.join(", ")}`);
  if (missing.length) throw new Error(`BSC contracts not found: ${missing.join(", ")}`);
  return result;
}

export function compareBstocksUniverses(previous, current) {
  const previousIds = new Set((previous?.assets || []).map((asset) => asset.instrumentId));
  const currentIds = new Set((current?.assets || []).map((asset) => asset.instrumentId));
  const previousById = new Map((previous?.assets || []).map((asset) => [asset.instrumentId, asset]));
  const currentById = new Map((current?.assets || []).map((asset) => [asset.instrumentId, asset]));
  const previousBySymbol = addressesBySymbol(previous);
  const currentBySymbol = addressesBySymbol(current);
  const contractChanges = [];
  const multiplierChanges = [];

  for (const symbol of [...previousBySymbol.keys()].filter((value) => currentBySymbol.has(value)).sort()) {
    const previousContractAddresses = [...previousBySymbol.get(symbol)].sort();
    const currentContractAddresses = [...currentBySymbol.get(symbol)].sort();
    if (JSON.stringify(previousContractAddresses) !== JSON.stringify(currentContractAddresses)) {
      contractChanges.push({ symbol, previousContractAddresses, currentContractAddresses });
    }
  }

  for (const instrumentId of [...previousIds].filter((id) => currentIds.has(id)).sort()) {
    const previousAsset = previousById.get(instrumentId);
    const currentAsset = currentById.get(instrumentId);
    const previousNumber = Number(previousAsset.multiplier);
    const currentNumber = Number(currentAsset.multiplier);
    const previousMultiplier = Number.isFinite(previousNumber) ? previousNumber : null;
    const currentMultiplier = Number.isFinite(currentNumber) ? currentNumber : null;
    if (previousMultiplier !== currentMultiplier) {
      multiplierChanges.push({
        instrumentId,
        symbol: currentAsset.underlyingSymbol,
        previousMultiplier,
        currentMultiplier
      });
    }
  }

  return {
    addedInstrumentIds: [...currentIds].filter((id) => !previousIds.has(id)).sort(),
    removedInstrumentIds: [...previousIds].filter((id) => !currentIds.has(id)).sort(),
    contractChanges,
    multiplierChanges
  };
}
