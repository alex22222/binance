const NASDAQ_COMPOSITE_URL = "https://api.nasdaq.com/api/quote/COMP/info?assetclass=index";

function numericText(value) {
  const number = Number(String(value ?? "").replace(/[,%+]/g, ""));
  return Number.isFinite(number) ? number : null;
}

export function parseNasdaqComposite(payload, checkedAt = new Date().toISOString()) {
  const data = payload?.data;
  const primary = data?.primaryData;
  const value = numericText(primary?.lastSalePrice);
  const change = numericText(primary?.netChange);
  const changePct = numericText(primary?.percentageChange);
  if (data?.symbol !== "COMP" || value == null || changePct == null) {
    throw new Error("Invalid Nasdaq composite response");
  }
  return {
    symbol: data.symbol,
    name: data.companyName || "NASDAQ Composite Index",
    value,
    change,
    changePct,
    direction: primary.deltaIndicator || (changePct >= 0 ? "up" : "down"),
    marketStatus: data.marketStatus || null,
    providerTimestamp: primary.lastTradeTimestamp || null,
    isRealTime: primary.isRealTime === true,
    source: "NASDAQ_OFFICIAL",
    checkedAt: new Date(checkedAt).toISOString(),
    stale: false
  };
}

export function createNasdaqCompositeLoader({ fetchImpl = globalThis.fetch, cacheTtlMs = 60_000 } = {}) {
  let cached = null;
  let expiresAt = 0;
  let pending = null;
  return async function loadNasdaqCompositeIndex({ nowMs = Date.now() } = {}) {
    if (nowMs < expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetchImpl(NASDAQ_COMPOSITE_URL, {
          headers: {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; AgenticDashboard/1.0)"
          },
          signal: AbortSignal.timeout(5_000)
        });
        if (!response.ok) throw new Error(`Nasdaq quote HTTP ${response.status}`);
        cached = parseNasdaqComposite(await response.json(), new Date(nowMs).toISOString());
      } catch (error) {
        if (!cached) return null;
        cached = { ...cached, stale: true };
      } finally {
        expiresAt = nowMs + cacheTtlMs;
      }
      return cached;
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}

export const loadNasdaqCompositeIndex = createNasdaqCompositeLoader();
