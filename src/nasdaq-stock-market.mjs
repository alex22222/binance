function dailyChange(quote) {
  const changePct = Number(quote?.changePct);
  return Number.isFinite(changePct)
    ? {
        changePct,
        marketStatus: quote.marketStatus || null,
        providerTimestamp: quote.providerTimestamp || null,
        isRealTime: quote.isRealTime === true,
        source: quote.source || "NASDAQ_OFFICIAL",
        stale: false
      }
    : null;
}

export function createNasdaqStockMarketLoader({ fetchQuote, cacheTtlMs = 60_000 } = {}) {
  if (typeof fetchQuote !== "function") throw new Error("Nasdaq stock quote loader is required");
  let cached = {};
  let expiresAt = 0;
  let pending = null;
  return async function loadNasdaqStockMarketChanges(symbols, { nowMs = Date.now() } = {}) {
    if (nowMs < expiresAt) return cached;
    if (pending) return pending;
    const uniqueSymbols = [...new Set((symbols || []).map((symbol) => String(symbol || "").trim().toUpperCase()).filter(Boolean))];
    pending = Promise.all(uniqueSymbols.map(async (symbol) => {
      try {
        return [symbol, dailyChange(await fetchQuote(symbol))];
      } catch {
        const previous = cached[symbol];
        return [symbol, previous ? { ...previous, stale: true } : null];
      }
    })).then((entries) => {
      cached = Object.fromEntries(entries);
      expiresAt = nowMs + cacheTtlMs;
      return cached;
    });
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}
