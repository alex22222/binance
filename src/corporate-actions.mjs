function normalizedSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function newYorkDate(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function calendarDate(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, month, day, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function calendarDayDistance(left, right) {
  return Math.round((Date.parse(`${left}T00:00:00.000Z`) - Date.parse(`${right}T00:00:00.000Z`)) / 86_400_000);
}

export function parseNasdaqCorporateActions({
  symbol,
  splitsPayload,
  dividendsPayload,
  checkedAt = new Date().toISOString(),
  blackoutCalendarDays = 1
}) {
  const normalized = normalizedSymbol(symbol);
  const splitData = splitsPayload?.data;
  const dividendCalendar = dividendsPayload?.data?.calendar;
  const splitRowsValue = splitData?.rows;
  const dividendRowsValue = dividendCalendar?.rows;
  if (
    !normalized || splitsPayload?.status?.rCode !== 200 ||
    dividendsPayload?.status?.rCode !== 200 ||
    !splitData || !Object.hasOwn(splitData, "rows") ||
    !dividendCalendar || !Object.hasOwn(dividendCalendar, "rows") ||
    !(splitRowsValue == null || Array.isArray(splitRowsValue)) ||
    !(dividendRowsValue == null || Array.isArray(dividendRowsValue))
  ) {
    throw new Error("Invalid Nasdaq corporate action response");
  }
  const splitRows = splitRowsValue || [];
  const dividendRows = dividendRowsValue || [];

  const checkedAtIso = new Date(checkedAt).toISOString();
  const coverageDate = newYorkDate(checkedAtIso);
  const nearby = (effectiveDate) => (
    effectiveDate && Math.abs(calendarDayDistance(effectiveDate, coverageDate)) <= blackoutCalendarDays
  );
  const events = [];

  for (const row of splitRows) {
    const effectiveDate = calendarDate(row.executionDate);
    if (normalizedSymbol(row.symbol) === normalized && nearby(effectiveDate)) {
      events.push({
        type: "SPLIT",
        symbol: normalized,
        effectiveDate,
        ratio: row.ratio || null,
        name: row.name || null,
        source: "NASDAQ_OFFICIAL_SPLIT_CALENDAR"
      });
    }
  }
  for (const row of dividendRows) {
    const effectiveDate = calendarDate(row.dividend_Ex_Date);
    if (normalizedSymbol(row.symbol) === normalized && nearby(effectiveDate)) {
      events.push({
        type: "EX_DIVIDEND",
        symbol: normalized,
        effectiveDate,
        amount: Number.isFinite(Number(row.dividend_Rate)) ? Number(row.dividend_Rate) : null,
        currency: "USD",
        recordDate: calendarDate(row.record_Date),
        paymentDate: calendarDate(row.payment_Date),
        announcementDate: calendarDate(row.announcement_Date),
        name: row.companyName || null,
        source: "NASDAQ_OFFICIAL_DIVIDEND_CALENDAR"
      });
    }
  }

  return {
    schemaVersion: 1,
    symbol: normalized,
    status: events.length ? "BLOCKED" : "CLEAR",
    checkedAt: checkedAtIso,
    coverageDate,
    blackoutCalendarDays,
    source: "NASDAQ_OFFICIAL_CALENDARS",
    events,
    vetoReasons: events.length ? ["CORPORATE_ACTION_BLACKOUT"] : []
  };
}

export function createNasdaqCorporateActionLoader({
  fetchImpl = globalThis.fetch,
  cacheTtlMs = 5 * 60_000
} = {}) {
  let cached = null;
  let cachedDate = null;
  let expiresAt = 0;
  let pending = null;

  return async function loadNasdaqCorporateActions(symbol, { nowMs = Date.now() } = {}) {
    const coverageDate = newYorkDate(nowMs);
    if (coverageDate !== cachedDate || nowMs >= expiresAt) {
      if (!pending) {
        pending = (async () => {
          const headers = {
            "Accept": "application/json, text/plain, */*",
            "User-Agent": "Mozilla/5.0"
          };
          const [splitsResponse, dividendsResponse] = await Promise.all([
            fetchImpl(`https://api.nasdaq.com/api/calendar/splits?date=${coverageDate}`, {
              headers,
              signal: AbortSignal.timeout(10_000)
            }),
            fetchImpl(`https://api.nasdaq.com/api/calendar/dividends?date=${coverageDate}`, {
              headers,
              signal: AbortSignal.timeout(10_000)
            })
          ]);
          if (!splitsResponse.ok || !dividendsResponse.ok) {
            throw new Error(`Nasdaq corporate action HTTP ${splitsResponse.status || dividendsResponse.status}`);
          }
          cached = {
            splitsPayload: await splitsResponse.json(),
            dividendsPayload: await dividendsResponse.json()
          };
          cachedDate = coverageDate;
          expiresAt = nowMs + cacheTtlMs;
        })();
      }
      try {
        await pending;
      } finally {
        pending = null;
      }
    }

    return parseNasdaqCorporateActions({
      symbol,
      ...cached,
      checkedAt: new Date(nowMs).toISOString()
    });
  };
}

export const loadNasdaqCorporateActions = createNasdaqCorporateActionLoader();
