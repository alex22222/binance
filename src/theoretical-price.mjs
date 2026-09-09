const NEW_YORK = "America/New_York";
const MONTHS = new Map([
  ["Jan", 1], ["Feb", 2], ["Mar", 3], ["Apr", 4],
  ["May", 5], ["Jun", 6], ["Jul", 7], ["Aug", 8],
  ["Sep", 9], ["Oct", 10], ["Nov", 11], ["Dec", 12]
]);

function numericText(value) {
  const number = Number(String(value ?? "").replace(/[$,%+,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function zonedParts(timestamp, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
}

function newYorkTimestamp(value) {
  const match = String(value || "").match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM) ET$/
  );
  if (!match) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, period] = match;
  let hour = Number(hourText) % 12;
  if (period === "PM") hour += 12;
  const target = Date.UTC(
    Number(yearText),
    MONTHS.get(monthName) - 1,
    Number(dayText),
    hour,
    Number(minuteText)
  );
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(candidate, NEW_YORK);
    const displayed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    candidate += target - displayed;
  }
  return new Date(candidate).toISOString();
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function parseNasdaqStockQuote(payload, retrievedAt = new Date().toISOString()) {
  const data = payload?.data;
  const primary = data?.primaryData;
  const symbol = String(data?.symbol || "").trim().toUpperCase();
  const price = positiveNumber(numericText(primary?.lastSalePrice));
  const effectiveAt = newYorkTimestamp(primary?.lastTradeTimestamp);
  const retrievedAtIso = new Date(retrievedAt).toISOString();
  if (!symbol || data?.assetClass !== "STOCKS" || price == null || !effectiveAt) {
    throw new Error("Invalid Nasdaq stock response");
  }

  return {
    symbol,
    companyName: data.companyName || null,
    assetClass: data.assetClass,
    price,
    changePct: primary?.percentageChange == null || String(primary.percentageChange).trim() === ""
      ? null
      : numericText(primary.percentageChange),
    bidPrice: positiveNumber(numericText(primary?.bidPrice)),
    askPrice: positiveNumber(numericText(primary?.askPrice)),
    bidSize: positiveNumber(numericText(primary?.bidSize)),
    askSize: positiveNumber(numericText(primary?.askSize)),
    currency: "USD",
    marketStatus: String(data.marketStatus || "UNKNOWN").trim().toUpperCase(),
    effectiveAt,
    providerTimestamp: primary.lastTradeTimestamp,
    retrievedAt: retrievedAtIso,
    ageMs: Date.parse(retrievedAtIso) - Date.parse(effectiveAt),
    isRealTime: primary.isRealTime === true,
    source: "NASDAQ_OFFICIAL"
  };
}

export async function fetchNasdaqStockQuote(symbol, {
  fetchImpl = globalThis.fetch,
  retrievedAt = new Date().toISOString()
} = {}) {
  const requestedSymbol = String(symbol || "").trim().toUpperCase();
  if (!requestedSymbol) throw new Error("Nasdaq stock symbol is required");
  const response = await fetchImpl(
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(requestedSymbol)}/info?assetclass=stocks`,
    {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0"
      },
      signal: AbortSignal.timeout(10_000)
    }
  );
  if (!response.ok) throw new Error(`Nasdaq stock quote HTTP ${response.status}`);
  const quote = parseNasdaqStockQuote(await response.json(), retrievedAt);
  if (quote.symbol !== requestedSymbol) {
    throw new Error(`Nasdaq stock identity mismatch: requested ${requestedSymbol}, received ${quote.symbol}`);
  }
  return quote;
}

export function buildTheoreticalPriceObservation({
  instrument,
  underlying,
  rwaDynamic,
  dynamicRetrievedAt,
  observedAt = new Date().toISOString(),
  maxUnderlyingAgeMs = 120_000,
  maxMultiplierAgeMs = 120_000,
  maxReferenceConflictPct = 0.5
}) {
  const observedAtIso = new Date(observedAt).toISOString();
  const dynamicRetrievedAtIso = new Date(dynamicRetrievedAt).toISOString();
  const multiplierValue = positiveNumber(rwaDynamic?.tokenInfo?.sharesMultiplier);
  const multiplierEffectiveAt = rwaDynamic?.tokenInfo?.sharesMultiplierEffectiveAt || null;
  const binanceReferencePrice = positiveNumber(rwaDynamic?.stockInfo?.price);
  const underlyingPrice = positiveNumber(underlying?.price);
  const underlyingAgeMs = Date.parse(observedAtIso) - Date.parse(underlying?.effectiveAt || "");
  const multiplierAgeMs = Date.parse(observedAtIso) - Date.parse(dynamicRetrievedAtIso);
  const referenceConflictPct = underlyingPrice && binanceReferencePrice
    ? Math.abs(binanceReferencePrice - underlyingPrice) / underlyingPrice * 100
    : null;
  const vetoReasons = [];
  const warnings = [];

  if (!instrument?.instrumentId || instrument?.underlyingSymbol !== underlying?.symbol) {
    vetoReasons.push("INSTRUMENT_IDENTITY_MISMATCH");
  }
  if (!underlying?.isRealTime) vetoReasons.push("UNDERLYING_NOT_REAL_TIME");
  if (!Number.isFinite(underlyingAgeMs) || underlyingAgeMs < 0 || underlyingAgeMs > maxUnderlyingAgeMs) {
    vetoReasons.push("UNDERLYING_STALE");
  }
  if (underlying?.marketStatus !== "OPEN") vetoReasons.push("REFERENCE_MARKET_NOT_OPEN");
  if (multiplierValue == null) vetoReasons.push("INVALID_SHARES_MULTIPLIER");
  if (!Number.isFinite(multiplierAgeMs) || multiplierAgeMs < 0 || multiplierAgeMs > maxMultiplierAgeMs) {
    vetoReasons.push("MULTIPLIER_STALE");
  }
  if (referenceConflictPct != null && referenceConflictPct > maxReferenceConflictPct) {
    vetoReasons.push("REFERENCE_PRICE_CONFLICT");
  }
  if (!multiplierEffectiveAt) warnings.push("MULTIPLIER_EFFECTIVE_TIME_UNAVAILABLE");

  const theoreticalTokenPrice = underlyingPrice && multiplierValue
    ? underlyingPrice * multiplierValue
    : null;
  const reasons = unique(vetoReasons);
  const provenanceComplete = Boolean(
    underlying?.effectiveAt && underlying?.retrievedAt && multiplierEffectiveAt
  );

  return {
    schemaVersion: 1,
    observationType: "THEORETICAL_TOKEN_PRICE",
    observedAt: observedAtIso,
    instrument: {
      instrumentId: instrument?.instrumentId || null,
      underlyingSymbol: instrument?.underlyingSymbol || null,
      chainId: instrument?.chainId || null,
      contractAddress: instrument?.contractAddress || null
    },
    underlying: {
      price: underlyingPrice,
      currency: underlying?.currency || null,
      marketStatus: underlying?.marketStatus || null,
      effectiveAt: underlying?.effectiveAt || null,
      retrievedAt: underlying?.retrievedAt || null,
      ageMs: Number.isFinite(underlyingAgeMs) ? underlyingAgeMs : null,
      isRealTime: underlying?.isRealTime === true,
      source: underlying?.source || null
    },
    multiplier: {
      value: multiplierValue,
      basis: "UNDERLYING_SHARES_PER_TOKEN",
      effectiveAt: multiplierEffectiveAt,
      retrievedAt: dynamicRetrievedAtIso,
      ageMs: Number.isFinite(multiplierAgeMs) ? multiplierAgeMs : null,
      source: "BINANCE_WEB3_RWA_DYNAMIC"
    },
    binanceReference: {
      price: binanceReferencePrice,
      retrievedAt: dynamicRetrievedAtIso,
      source: "BINANCE_WEB3_RWA_DYNAMIC"
    },
    theoreticalTokenPrice,
    referenceConflictPct,
    vetoReasons: reasons,
    warnings: unique(warnings),
    dataQuality: {
      provenanceComplete,
      sourceAgreement: referenceConflictPct != null && referenceConflictPct <= maxReferenceConflictPct,
      underlyingFresh: Number.isFinite(underlyingAgeMs) && underlyingAgeMs >= 0 && underlyingAgeMs <= maxUnderlyingAgeMs,
      multiplierFresh: Number.isFinite(multiplierAgeMs) && multiplierAgeMs >= 0 && multiplierAgeMs <= maxMultiplierAgeMs
    },
    eligibleForLive: reasons.length === 0 && provenanceComplete
  };
}
