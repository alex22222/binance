import { createHmac } from "node:crypto";
import { BTC_TREND_DAYS } from "./btc-trend.mjs";
import { isTransientNetworkError } from "./reliability.mjs";
import { retry } from "./retry.mjs";
import { buildPercentileHistory, percentileInputsAt } from "./btc-radar-percentiles.mjs";

const OKX_BASE = "https://www.okx.com";
const POLYMARKET_BASE = "https://gamma-api.polymarket.com";
const TREASURY_BASE = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv";
const DCA_BASE = "/api/v5/tradingBot/dca";
export const BTC_RADAR_BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const BTC_RADAR_SOURCES = Object.freeze([
  ["Polymarket", "https://polymarket.com/crypto/bitcoin"],
  ["美国财政部收益率", "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve"],
  ["OKX 行情 / 持仓", "https://www.okx.com"],
  ["BTC现货ETF流量 (Farside)", "https://farside.co.uk/btc-all-data/"],
  ["美元稳定币供应 (DefiLlama)", "https://stablecoins.llama.fi/stablecoincharts/all"],
  ["Coinbase Exchange日线", "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles"],
  ["恐惧贪婪指数", "https://alternative.me/crypto/fear-and-greed-index/"]
]);
const FEAR_GREED_LABELS = Object.freeze({
  "Extreme Fear": "极度恐惧", Fear: "恐惧", Neutral: "中性", Greed: "贪婪", "Extreme Greed": "极度贪婪"
});

function finite(value, label) {
  const number = Number(value);
  if (value === null || value === "" || !Number.isFinite(number)) throw new Error(`${label} is not a finite number`);
  return number;
}

function probability(value, label) {
  const number = finite(value, label);
  if (number < 0 || number > 1) throw new Error(`${label} is outside 0-1`);
  return number;
}

// Polymarket and FOMC calendars are New York based.
export function newYorkMonth(nowMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "numeric"
  }).formatToParts(new Date(nowMs)).map(({ type, value }) => [type, value]));
  return { year: Number(parts.year), month: Number(parts.month) };
}

async function request(url, { fetchImpl, headers = {}, text = false }) {
  return retry(async () => {
    const response = await fetchImpl(url, {
      headers: { Accept: text ? "text/csv" : "application/json", ...(new URL(url).hostname.endsWith("okx.com") ? { "User-Agent": BTC_RADAR_BROWSER_UA } : {}), ...headers },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${new URL(url).hostname}${new URL(url).pathname}`);
      error.status = response.status;
      throw error;
    }
    return text ? response.text() : response.json();
  }, { attempts: 3, delayMs: 500, shouldRetry: isTransientNetworkError });
}

async function okxPublic(path, params, fetchImpl) {
  const url = new URL(path, OKX_BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const payload = await request(url, { fetchImpl });
  if (payload.code !== "0" || !Array.isArray(payload.data)) {
    throw new Error(`OKX ${path} failed: ${payload.code} ${payload.msg || ""}`.trim());
  }
  return payload.data;
}

const closes = (candles, label) => candles.map((row) => finite(row?.[4], `${label} close`));

export async function loadBtcMarket({ fetchImpl = fetch } = {}) {
  const [ticker, candles] = await Promise.all([
    okxPublic("/api/v5/market/ticker", { instId: "BTC-USDT" }, fetchImpl),
    okxPublic("/api/v5/market/candles", { instId: "BTC-USDT", bar: "1D", limit: "60" }, fetchImpl)
  ]);
  const price = finite(ticker[0]?.last, "BTC price");
  const btcCloses = closes(candles, "BTC");
  if (btcCloses.length < 50) throw new Error(`BTC daily history has ${btcCloses.length} closes; 50 required`);
  btcCloses[0] = price;
  return { price, btc_closes: btcCloses };
}

// Wilder's RSI over closes ordered oldest first.
export function wilderRsi(values, period = 14) {
  if (values.length <= period) throw new Error(`RSI(${period}) needs more than ${period} closes`);
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

// Reference only, not scored: daily RSI(14) on UTC candles, from completed
// candles and again including the candle still in progress.
export async function loadBtcDailyRsi({ fetchImpl = fetch } = {}) {
  const rows = [...await okxPublic("/api/v5/market/candles", { instId: "BTC-USDT", bar: "1Dutc", limit: "300" }, fetchImpl)].reverse();
  const completed = rows.filter((row) => row[8] === "1");
  if (completed.length < 30) throw new Error("BTC daily history is too short for RSI");
  const close = (row) => finite(row[4], "BTC close");
  return {
    closed: Number(wilderRsi(completed.map(close)).toFixed(1)),
    intraday: Number(wilderRsi(rows.map(close)).toFixed(1)),
    date: new Date(Number(completed.at(-1)[0])).toISOString().slice(0, 10)
  };
}

// Completed UTC daily closes, oldest first, for the 200-day trend state.
export async function loadBtcDailyCloses({ fetchImpl = fetch } = {}) {
  const rows = [...await okxPublic("/api/v5/market/candles", { instId: "BTC-USDT", bar: "1Dutc", limit: "300" }, fetchImpl)].reverse();
  const closes = rows.filter((row) => row[8] === "1").map((row) => ({
    date: new Date(Number(row[0])).toISOString().slice(0, 10),
    close: finite(row[4], "BTC close")
  }));
  if (closes.length < BTC_TREND_DAYS) throw new Error(`BTC daily history has ${closes.length} closes; ${BTC_TREND_DAYS} required`);
  return closes;
}

// Observation mode inputs (src/btc-observe.mjs), oldest first.
export async function loadFearGreedHistory({ fetchImpl = fetch } = {}) {
  const rows = (await request("https://api.alternative.me/fng/?limit=100", { fetchImpl }))?.data;
  if (!Array.isArray(rows) || rows.length < 7) throw new Error("Fear & Greed history is too short");
  return rows.map((row) => ({
    date: new Date(finite(row.timestamp, "Fear & Greed timestamp") * 1000).toISOString().slice(0, 10),
    value: finite(row.value, "Fear & Greed value")
  })).reverse();
}

// About 100 days of settled 8-hour funding, three pages of 100.
export async function loadFundingHistory({ fetchImpl = fetch } = {}) {
  const events = [];
  let after = null;
  for (let page = 0; page < 3; page += 1) {
    const rows = await okxPublic("/api/v5/public/funding-rate-history", {
      instId: "BTC-USDT-SWAP", limit: "100", ...(after ? { after } : {})
    }, fetchImpl);
    if (!rows.length) break;
    events.push(...rows.map((row) => ({
      ts: finite(row.fundingTime, "Funding time"),
      rate: finite(row.realizedRate || row.fundingRate, "Funding rate")
    })));
    after = rows.at(-1).fundingTime;
  }
  if (events.length < 90) throw new Error(`Funding history has ${events.length} rates; 90 required`);
  return events.sort((left, right) => left.ts - right.ts);
}

// FRED broad dollar index and 10-year real yield for the last eight months.
export async function loadMacroSeries({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const since = new Date(nowMs - 240 * 86_400_000).toISOString().slice(0, 10);
  const [dollar, realYield] = await Promise.all(["DTWEXBGS", "DFII10"].map(async (id) => {
    const csv = await request(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${since}`, { fetchImpl, text: true });
    return csv.trim().split(/\r?\n/).slice(1)
      .map((line) => line.split(","))
      .filter(([date, value]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && value && value !== ".")
      .map(([date, value]) => ({ date, value: finite(value, `${id} value`) }));
  }));
  if (dollar.length < 60 || realYield.length < 60) throw new Error("FRED history is too short");
  return { dollar, realYield };
}

// Reference only, not scored: alternative.me crypto Fear & Greed Index.
export async function loadFearGreed({ fetchImpl = fetch } = {}) {
  const latest = (await request("https://api.alternative.me/fng/?limit=1", { fetchImpl }))?.data?.[0];
  const value = finite(latest?.value, "Fear & Greed value");
  if (value < 0 || value > 100) throw new Error("Fear & Greed value is outside 0-100");
  return {
    value,
    label: FEAR_GREED_LABELS[latest.value_classification] || String(latest.value_classification || ""),
    date: new Date(finite(latest.timestamp, "Fear & Greed timestamp") * 1000).toISOString().slice(0, 10)
  };
}

export async function loadGoldCloses({ fetchImpl = fetch } = {}) {
  const goldCloses = closes(await okxPublic("/api/v5/market/candles", { instId: "XAUT-USDT", bar: "1D", limit: "15" }, fetchImpl), "XAUT");
  if (goldCloses.length < 2) throw new Error("XAUT daily history is too short");
  return goldCloses;
}

export async function loadFundingRates({ fetchImpl = fetch } = {}) {
  const rows = await okxPublic("/api/v5/public/funding-rate-history", { instId: "BTC-USDT-SWAP", limit: "9" }, fetchImpl);
  if (!rows.length) throw new Error("Funding rate history is empty");
  return rows.map((row) => finite(row.fundingRate, "Funding rate"));
}

export async function loadOpenInterestChange({ fetchImpl = fetch } = {}) {
  const rows = await okxPublic("/api/v5/rubik/stat/contracts/open-interest-history", {
    instId: "BTC-USDT-SWAP", period: "1D", limit: "8"
  }, fetchImpl);
  if (rows.length < 2) throw new Error("Open interest history is too short");
  return (finite(rows[0][2], "Latest open interest") / finite(rows.at(-1)[2], "Oldest open interest") - 1) * 100;
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function yesPrice(market) {
  const index = jsonArray(market?.outcomes).findIndex((outcome) => String(outcome).toLowerCase() === "yes");
  if (index < 0) return null;
  const value = Number(jsonArray(market.outcomePrices)[index]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

// Raw quotes only. Never mix a resolved past hit with a newly opened contract
// at the same price. Prefer the latest creation window; ambiguous duplicates
// are omitted rather than merged or interpolated.
export function priceLadder(markets, nowMs = Date.now()) {
  const ladder = { dips: {}, reaches: {} };
  const selected = new Map();
  for (const market of markets || []) {
    if (market.closed === true || market.active === false || market.acceptingOrders === false || market.umaResolutionStatus === "resolved") continue;
    if (market.endDate && !(Date.parse(market.endDate) > nowMs)) continue;
    const match = String(market.question || "").match(/\b(dip to|reach)\s+\$([\d,]+(?:\.\d+)?)/i);
    const yes = yesPrice(market);
    if (!match || yes === null) continue;
    const level = Number(match[2].replaceAll(",", ""));
    if (!(level > 0)) continue;
    const side = match[1].toLowerCase().startsWith("dip") ? "dips" : "reaches";
    const key = `${side}:${level}`;
    const created = Date.parse(market.createdAt);
    const before = selected.get(key);
    if (!before || created > before.created) selected.set(key, { side, level, yes, created });
    else if (!(created < before.created)) selected.set(key, { ...before, yes: null });
  }
  for (const { side, level, yes } of selected.values()) if (yes !== null) ladder[side][level] = yes;
  return ladder;
}

const WEEKLY_TITLE = new RegExp(
  `^What price will Bitcoin hit ((?:${MONTHS.join("|")}) \\d{1,2}\\s*[-–]\\s*(?:(?:${MONTHS.join("|")}) )?\\d{1,2})\\?$`
);

export function selectWeeklyEvent(events, nowMs) {
  const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
  return events
    .filter((event) => {
      const match = (event.title || "").match(WEEKLY_TITLE);
      if (!match || !(Date.parse(event.endDate) > nowMs)) return false;
      const first = match[1].match(/^([A-Za-z]+) (\d{1,2})/);
      const month = MONTHS.indexOf(first[1]) + 1;
      const end = newYorkMonth(Date.parse(event.endDate) - 1000);
      const year = end.year - (month > end.month ? 1 : 0);
      return `${year}-${String(month).padStart(2, "0")}-${first[2].padStart(2, "0")}` <= localDay;
    })
    .sort((left, right) => Date.parse(left.endDate) - Date.parse(right.endDate))[0] || null;
}

export async function loadPolymarketWeek({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const events = await request(
    `${POLYMARKET_BASE}/events?tag_slug=bitcoin&active=true&closed=false&limit=100&order=volume24hr&ascending=false`,
    { fetchImpl }
  );
  const event = selectWeeklyEvent(Array.isArray(events) ? events : [], nowMs);
  if (!event) throw new Error("Weekly Bitcoin price-hit event not found");
  return { label: event.title.match(WEEKLY_TITLE)[1], ...priceLadder(event.markets, nowMs) };
}

export async function loadPolymarketMonth({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const { year, month } = newYorkMonth(nowMs);
  const slug = `what-price-will-bitcoin-hit-in-${MONTHS[month - 1].toLowerCase()}-${year}`;
  const events = await request(`${POLYMARKET_BASE}/events?slug=${slug}`, { fetchImpl });
  const event = Array.isArray(events) ? events[0] : null;
  if (!event) throw new Error(`Monthly Bitcoin price-hit event not found: ${slug}`);
  return { label: `${month}月`, ...priceLadder(event.markets, nowMs) };
}

function meetingProbabilities(event, nowMs) {
  let hike = 0;
  let cut = 0;
  let unchanged = 0;
  const evidence = [];
  for (const market of event.markets || []) {
    if (market.closed === true || market.active === false || market.acceptingOrders === false || market.umaResolutionStatus === "resolved") continue;
    if (market.endDate && Date.parse(market.endDate) <= nowMs) continue;
    const yes = yesPrice(market);
    const label = String(market.groupItemTitle || market.question || "").toLowerCase();
    const question = String(market.question || "").toLowerCase();
    if (yes === null) continue;
    const kind = /\bincrease\b/.test(label) ? "hike" : /\bdecrease\b/.test(label) ? "cut" : /\bno change\b/.test(label) ? "hold" : null;
    if (!kind) continue;
    if ((kind === "hike" && /\bdecrease\b/.test(question)) || (kind === "cut" && /\bincrease\b/.test(question))) throw new Error("Fed mapping label/question conflict");
    if (kind === "hike") hike += yes;
    else if (kind === "cut") cut += yes;
    else unchanged += yes;
    evidence.push({ id: market.id || null, question: market.question, label: market.groupItemTitle || null, kind, yes,
      yesTokenOutcome: "Yes", yesTokenId: jsonArray(market.clobTokenIds)[jsonArray(market.outcomes).findIndex(o => String(o).toLowerCase() === "yes")] || null });
  }
  const sum = hike + cut + unchanged;
  if (!evidence.some(m => m.kind === "hold") || !evidence.some(m => m.kind === "hike") || !evidence.some(m => m.kind === "cut") || Math.abs(sum - 1) > 0.05)
    throw new Error("Incomplete Fed mapping or outcome probability sum");
  return { hike: Number(hike.toFixed(6)), cut: Number(cut.toFixed(6)), evidence, sum };
}

export function fedExpectations(events, nowMs) {
  const decision = /^Fed Decision in ([A-Z][a-z]+)\?$/;
  const meetings = events
    .filter((event) => decision.test(event.title || "") && event.closed !== true && event.active !== false && Date.parse(event.endDate) > nowMs)
    .sort((left, right) => Date.parse(left.endDate) - Date.parse(right.endDate));
  if (!meetings.length) throw new Error("Next Fed decision market not found");
  const next = meetingProbabilities(meetings[0], nowMs);
  const month = MONTHS.indexOf(meetings[0].title.match(decision)[1]) + 1;
  if (month < 1) throw new Error("Fed decision month is not recognized");
  const meetingYear = newYorkMonth(Date.parse(meetings[0].endDate)).year;
  for (const market of next.evidence) {
    const stated = String(market.question).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December) (20\d{2})\b/);
    if (stated && (MONTHS.indexOf(stated[1]) + 1 !== month || Number(stated[2]) !== meetingYear)) throw new Error("Fed contract year/month identity mismatch");
  }
  const { year } = newYorkMonth(nowMs);
  const liveAnnual = event => event.closed !== true && event.active !== false && Date.parse(event.endDate) > nowMs;
  const anotherHike = events.find((event) => event.title === `Another Fed rate hike in ${year}?` && liveAnnual(event));
  const liveMarket = market => market && market.closed !== true && market.active !== false && market.acceptingOrders !== false &&
    market.umaResolutionStatus !== "resolved" && (!market.endDate || Date.parse(market.endDate) > nowMs);
  const hikeYes = liveMarket(anotherHike?.markets?.[0]) ? yesPrice(anotherHike.markets[0]) : null;
  const cuts = events.find((event) => event.title === `How many Fed rate cuts in ${year}?` && liveAnnual(event));
  const noCut = cuts?.markets?.find((market) => /\bno fed rate cuts\b/i.test(market.question || ""));
  const noCutYes = liveMarket(noCut) ? yesPrice(noCut) : null;
  return {
    next_meeting: `${meetingYear}年${month}月议息`,
    p_hike_next: next.hike,
    p_cut_next: next.cut,
    year,
    p_hike_year_any: hikeYes,
    p_cut_year_any: noCutYes === null ? null : Number((1 - noCutYes).toFixed(6)),
    contract: { eventId: meetings[0].id || null, slug: meetings[0].slug || null, title: meetings[0].title,
      endDate: meetings[0].endDate, url: meetings[0].slug ? `https://polymarket.com/event/${meetings[0].slug}` : null,
      outcomeSum: Number(next.sum.toFixed(6)), markets: next.evidence,
      annualHikeEventId: anotherHike?.id || null, annualCutEventId: cuts?.id || null },
    note: "原始合约报价，非美联储官方概率；停止缩表与政策利率决策并非同一变量。不用下次/再下次议息概率替代年内概率。"
  };
}

export async function loadFedExpectations({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const events = await request(
    `${POLYMARKET_BASE}/events?tag_slug=fed-rates&active=true&closed=false&limit=100&order=volume24hr&ascending=false`,
    { fetchImpl }
  );
  return fedExpectations(Array.isArray(events) ? events : [], nowMs);
}

export function parseTreasuryCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const header = lines.shift()?.split(",").map((cell) => cell.replaceAll('"', "").trim()) || [];
  const [dateIndex, twoIndex, tenIndex] = ["Date", "2 Yr", "10 Yr"].map((name) => header.indexOf(name));
  if (dateIndex < 0 || twoIndex < 0 || tenIndex < 0) throw new Error("Treasury CSV columns are missing");
  return lines.map((line) => line.split(",")).map((cells) => {
    const [month, day, year] = cells[dateIndex].replaceAll('"', "").split("/");
    return {
      date: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
      y2: finite(cells[twoIndex], "2-year yield"),
      y10: finite(cells[tenIndex], "10-year yield")
    };
  }).sort((left, right) => right.date.localeCompare(left.date));
}

export async function loadTreasuryYields({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const { year } = newYorkMonth(nowMs);
  const yearRows = async (value) => parseTreasuryCsv(await request(
    `${TREASURY_BASE}/${value}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${value}&page&_format=csv`,
    { fetchImpl, text: true }
  ));
  let rows = await yearRows(year);
  if (rows.length < 11) rows = [...rows, ...await yearRows(year - 1)];
  if (rows.length < 2) throw new Error("Treasury yield history is too short");
  return rows.slice(0, 11);
}

// Signed GET only, so the client cannot place, amend, or stop orders.
export function createOkxReadOnlyClient({ apiKey, secretKey, passphrase, fetchImpl = fetch, now = () => new Date() }) {
  if (!apiKey || !secretKey || !passphrase) throw new Error("OKX read-only credentials are incomplete");
  return async function privateGet(path, params = {}) {
    const allowed = new Set(["/api/v5/public/instruments", "/api/v5/account/positions", "/api/v5/trade/orders-algo-pending", "/api/v5/orbit/currency-sentiment-query",
      `${DCA_BASE}/ongoing-list`, `${DCA_BASE}/history-list`, `${DCA_BASE}/position-details`, `${DCA_BASE}/orders`,
      "/api/v5/tradingBot/grid/orders-algo-pending", "/api/v5/tradingBot/grid/positions"]);
    if (!allowed.has(path)) throw new Error("OKX read-only endpoint allowlist rejected path");
    const query = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")
    ).toString();
    const requestPath = query ? `${path}?${query}` : path;
    const timestamp = now().toISOString();
    const payload = await request(`${OKX_BASE}${requestPath}`, {
      fetchImpl,
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": createHmac("sha256", secretKey).update(`${timestamp}GET${requestPath}`).digest("base64"),
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase
      }
    });
    if (payload.code !== "0" || !Array.isArray(payload.data)) {
      throw new Error(`OKX ${path} failed: ${payload.code} ${payload.msg || ""}`.trim());
    }
    return payload.data;
  };
}

export async function loadSentiment(privateGet) {
  const data = await privateGet("/api/v5/orbit/currency-sentiment-query", { ccy: "BTC", period: "24h" });
  const sentiment = data[0]?.details?.find((detail) => detail.ccy === "BTC")?.sentiment;
  return {
    bull: probability(sentiment?.bullishRatio, "BTC bullish ratio"),
    bear: probability(sentiment?.bearishRatio, "BTC bearish ratio")
  };
}

const round = (value, places) => Number(value.toFixed(places));

// OKX's fillSafetyOrds also counts manual add orders, so automatic safety fills
// and the remaining ladder come from the cycle's orders when they are available.
export function dcaPosition(bot, details, orders = null) {
  const direction = bot.direction === "short" ? "short" : "long";
  const stop = (bot.triggerParams || []).find((trigger) => trigger.triggerAction === "stop");
  const manual = Number(details.fillManualOrds) > 0 ? Number(details.fillManualOrds) : 0;
  const maximum = finite(bot.maxSafetyOrds, "Maximum safety orders");
  const contractValue = Number(bot.ctVal) > 0 ? Number(bot.ctVal) : 0.01;
  const listed = Array.isArray(orders) ? orders.filter((order) => order.ordType === "safety_order") : [];
  const safety = listed.length ? listed : null;
  const pending = (safety || [])
    .filter((order) => order.state === "live")
    .map((order) => [finite(order.px, "Safety order price"), finite(order.sz, "Safety order size")])
    .sort((left, right) => direction === "short" ? left[0] - right[0] : right[0] - left[0]);
  const filled = safety
    ? safety.filter((order) => order.state === "filled").length
    : Math.max(0, finite(details.fillSafetyOrds, "Filled safety orders") - manual);
  const step = finite(bot.pxSteps, "Price step");
  const multiplier = Number(bot.pxStepsMult) > 0 ? Number(bot.pxStepsMult) : 1;
  let deviation = 0;
  for (let order = 0; order <= filled; order += 1) deviation += step * multiplier ** order;
  const formulaNext = filled >= maximum ? null : round(finite(details.initPx, "Initial price") * (1 + (direction === "short" ? deviation : -deviation)), 1);
  return {
    id: `dca:${bot.algoId}`, source: "dca", direction,
    avg: round(finite(details.avgPx, "Average price"), 2),
    tp: finite(details.tpPx, "Take-profit price"),
    sl: Number(stop?.triggerPx) > 0 ? Number(stop.triggerPx) : 0,
    liq: round(finite(details.liqPx, "Liquidation price"), 1),
    sz_btc: round(Math.abs(finite(details.sz, "Contracts")) * contractValue, 4),
    lever: finite(bot.lever, "Leverage"),
    total_pnl: round(finite(bot.totalPnl, "Total PnL"), 2),
    safety_filled: filled,
    safety_max: maximum,
    next_safety: safety ? (pending[0]?.[0] ?? null) : formulaNext,
    manual_adds: manual,
    ladder: { pending, ctVal: contractValue, complete: Boolean(safety) }
  };
}

// Keep the legacy primary selection, but optionally collect every long/short bot.
export async function loadDcaPosition(privateGet, { pinnedAlgoId = null, trackedAlgoId = null, includeAll = false } = {}) {
  const rows = await privateGet(`${DCA_BASE}/ongoing-list`, { algoOrdType: "contract_dca", limit: "100" });
  if (rows.length >= 100) throw new Error("DCA list may be truncated");
  const running = rows
    .filter((bot) => bot.instId === "BTC-USDT-SWAP" && ["long", "short"].includes(bot.direction) && (!bot.state || bot.state === "running"));
  const bot = pinnedAlgoId
    ? running.find((candidate) => candidate.algoId === pinnedAlgoId)
    : [...running].sort((left, right) => Number(right.cTime) - Number(left.cTime))[0];
  const events = [];
  if (trackedAlgoId && !running.some((candidate) => candidate.algoId === trackedAlgoId)) {
    const ended = (await privateGet(`${DCA_BASE}/history-list`, { algoOrdType: "contract_dca", algoId: trackedAlgoId }))
      .find((candidate) => candidate.algoId === trackedAlgoId);
    events.push({ type: "STRATEGY_ENDED", algoId: trackedAlgoId, state: ended?.state || "unknown" });
  }
  if (bot && trackedAlgoId && bot.algoId !== trackedAlgoId) {
    events.push({ type: "STRATEGY_SWITCHED", algoId: bot.algoId, previousAlgoId: trackedAlgoId });
  }
  const positions = [];
  for (const candidate of includeAll ? running : bot ? [bot] : []) {
    const [details] = await privateGet(`${DCA_BASE}/position-details`, { algoId: candidate.algoId, algoOrdType: "contract_dca" });
    if (!details) throw new Error(`DCA position details missing for ${candidate.algoId}`);
    let orders = null;
    try {
      orders = await privateGet(`${DCA_BASE}/orders`, {
        algoId: candidate.algoId, algoOrdType: "contract_dca", cycleId: details.curCycleId, limit: "100"
      });
      if (orders.length >= 100) orders = null;
    } catch {
      // Without the cycle's orders the counts fall back to OKX's summary fields.
    }
    positions.push(dcaPosition(candidate, details, orders));
  }
  return { position: positions.find((held) => held.id === `dca:${bot?.algoId}`) || null,
    algoId: bot?.algoId || null, events, ...(includeAll ? { positions } : {}) };
}

const optionalNumber = (value) => value !== "" && value != null && Number.isFinite(Number(value)) ? Number(value) : null;

async function btcContractValue(privateGet) {
  const [instrument] = await privateGet("/api/v5/public/instruments", { instType: "SWAP", instId: "BTC-USDT-SWAP" });
  if (instrument?.instId !== "BTC-USDT-SWAP" || instrument.ctValCcy !== "BTC" || instrument.ctType !== "linear"
    || !(Number(instrument.ctVal) > 0) || !(Number(instrument.ctMult) > 0)) throw new Error("BTC contract identity/value unavailable");
  return Number(instrument.ctVal) * Number(instrument.ctMult);
}

function perpetualPosition(row, contractValue) {
  const contracts = finite(row.pos, "Position contracts");
  if (!["long", "short", "net"].includes(row.posSide)) throw new Error("Unknown BTC position side");
  return {
    direction: row.posSide === "net" ? (contracts < 0 ? "short" : "long") : row.posSide,
    avg: finite(row.avgPx, "Position average"), sz_btc: Math.abs(contracts) * contractValue,
    liq: optionalNumber(row.liqPx), lever: optionalNumber(row.lever),
    mark_price: optionalNumber(row.markPx), last_price: optionalNumber(row.last),
    unrealized_pnl: optionalNumber(row.upl), margin_mode: row.mgnMode,
    sl: null, tp: null
  };
}

export async function loadAccountPositions(privateGet) {
  const rows = (await privateGet("/api/v5/account/positions", { instId: "BTC-USDT-SWAP" }))
    .filter((row) => row.instId === "BTC-USDT-SWAP" && finite(row.pos, "Position contracts") !== 0);
  if (!rows.length) return [];
  const contractValue = await btcContractValue(privateGet);
  return rows.map((row) => {
    const attached = row.closeOrderAlgo || [];
    const trigger = (kind) => {
      const orders = attached.filter((order) => Number(order[`${kind}TriggerPx`]) > 0);
      if (orders.length !== 1) return {};
      const type = orders[0][`${kind}TriggerPxType`] || "last";
      if (!["last", "mark"].includes(type)) return {};
      return { [kind]: Number(orders[0][`${kind}TriggerPx`]), [`${kind}_price_type`]: type };
    };
    return { ...perpetualPosition(row, contractValue), id: `account:${row.posId || `${row.mgnMode}:${row.posSide}`}`,
      source: "account", ...trigger("sl"), ...trigger("tp"),
      stop_note: "仅识别全仓平仓附带委托；分批或移动止损未确认" };
  });
}

export async function loadGridPositions(privateGet) {
  const rows = await privateGet("/api/v5/tradingBot/grid/orders-algo-pending", { algoOrdType: "contract_grid", limit: "100" });
  if (rows.length >= 100) throw new Error("Grid list may be truncated");
  const bots = rows.filter((bot) => bot.instId === "BTC-USDT-SWAP" && bot.state === "running");
  if (!bots.length) return [];
  const contractValue = await btcContractValue(privateGet);
  const positions = [];
  for (const bot of bots) {
    const held = await privateGet("/api/v5/tradingBot/grid/positions", { algoId: bot.algoId, algoOrdType: "contract_grid" });
    for (const row of held.filter((row) => row.instId === "BTC-USDT-SWAP" && finite(row.pos, "Grid contracts") !== 0)) {
      positions.push({ ...perpetualPosition(row, contractValue), id: `grid:${bot.algoId}:${row.posSide}`, source: "grid",
        total_pnl: optionalNumber(bot.totalPnl), grid_pnl: optionalNumber(bot.gridProfit),
        sl: optionalNumber(bot.slTriggerPx), tp: optionalNumber(bot.tpTriggerPx),
        stop_note: Number(bot.slRatio) > 0 ? "设置了比例止损，未换算为固定止损价" : "未读取到固定价格止损",
        grid_range: [optionalNumber(bot.minPx), optionalNumber(bot.maxPx)] });
    }
  }
  return positions;
}

async function allAlgoStops(privateGet, ordType) {
  const orders = new Map();
  let after;
  for (let page = 0; page < 20; page++) {
    const rows = await privateGet("/api/v5/trade/orders-algo-pending", { ordType, limit: "100", ...(after ? { after } : {}) });
    for (const row of rows) {
      if (!row.algoId) throw new Error("OKX stop order identity missing");
      orders.set(row.algoId, row);
    }
    if (rows.length < 100) return [...orders.values()];
    const next = rows.at(-1)?.algoId;
    if (!next || next === after) throw new Error("OKX stop order pagination incomplete");
    after = next;
  }
  throw new Error("OKX stop order list may be truncated");
}

const riskNumber = value => (typeof value === "number" || typeof value === "string" && value.trim() !== "")
  && Number.isFinite(Number(value)) ? Number(value) : null;

function stopQuantity(order, row, size) {
  if (order.instType && order.instType !== row.instType || order.tgtCcy
    || !["oco", "conditional"].includes(order.ordType) || order.state !== "live") return null;
  if (order.closeFraction != null && order.closeFraction !== "") {
    // OKX only supports closeFraction=1 for FUTURES/SWAP market TP/SL.
    return riskNumber(order.closeFraction) === 1 && ["FUTURES", "SWAP"].includes(row.instType)
      && riskNumber(order.slOrdPx) === -1 ? size : null;
  }
  const quantity = riskNumber(order.sz), price = riskNumber(order.slOrdPx);
  if (!(quantity > 0)) return null;
  if (row.instType === "MARGIN") {
    // GET positions documents pos in base units. MARGIN limit orders and
    // market sells use base sz; a market buy uses quote sz. tgtCcy is SPOT-only.
    // A future market fill cannot be converted using slTriggerPx as a guarantee.
    // https://www.okx.com/docs-v5/en/ (Get positions / Place order / Place algo order)
    if (!(price > 0 || price === -1) || order.side === "buy" && price === -1) return null;
  }
  return quantity;
}

// Do not convert all instruments to BTC or add incomparable contract counts.
// Account positions include margin (e.g. HYPE), futures, swaps and options.
// Bot accounts remain separate; their internally managed stops are not ordinary OCOs.
export async function loadLeveragedAccountRisk(privateGet) {
  const rows = (await privateGet("/api/v5/account/positions"))
    .filter(row => Math.abs(finite(row.pos, "Position size")) > 0);
  const stops = await Promise.allSettled([allAlgoStops(privateGet, "oco"), allAlgoStops(privateGet, "conditional")]);
  const complete = stops.every(result => result.status === "fulfilled");
  const orders = new Map(stops.flatMap(result => result.status === "fulfilled" ? result.value : []).map(row => [row.algoId, row]));
  const positionErrors = [];
  const positions = rows.map(row => {
    if (!row.instId || !["long", "short", "net"].includes(row.posSide)) throw new Error("OKX position identity unavailable");
    const size = Math.abs(finite(row.pos, "Position size"));
    const margin = row.instType === "MARGIN", contracts = ["SWAP", "FUTURES", "OPTION"].includes(row.instType);
    const currencies = row.instId.split("-");
    // MARGIN pos is always positive; posCcy identifies direction, not the sign.
    const direction = margin ? row.posSide === "net" && Number(row.pos) > 0 && currencies.length === 2 ?
      row.posCcy === currencies[0] ? "long" : row.posCcy === currencies[1] ? "short" : null : null :
      contracts ? row.posSide === "net" ? Number(row.pos) < 0 ? "short" : "long" : row.posSide : null;
    const matches = order => order.instId === row.instId && order.tdMode === row.mgnMode &&
      order.posSide === row.posSide && order.side === (direction === "short" ? "buy" : "sell") &&
      (!order.state || order.state === "live") && Number(order.slTriggerPx) > 0 &&
      (row.posSide !== "net" || order.reduceOnly === true || order.reduceOnly === "true");
    const attached = (row.closeOrderAlgo || []).filter(order => order.algoId && Number(order.slTriggerPx) > 0)
      .map(order => [order.algoId, { ordType: "conditional", state: "live", ...order, instId: row.instId, tdMode: row.mgnMode, posSide: row.posSide,
        side: direction === "short" ? "buy" : "sell", reduceOnly: true }]);
    const unique = new Map([...attached, ...orders]);
    const ambiguous = rows.filter(other => other.instId === row.instId && other.posSide === row.posSide && other.mgnMode === row.mgnMode
      && (!margin || other.posCcy === row.posCcy)).length > 1;
    const quantities = [...unique.values()].filter(matches).map(order => stopQuantity(order, row, size));
    const unresolved = !direction || !["cross", "isolated"].includes(row.mgnMode) ? "POSITION_DIRECTION_OR_UNIT_UNKNOWN" :
      quantities.includes(null) ? "STOP_QUANTITY_OR_UNIT_UNKNOWN" : null;
    if (unresolved) positionErrors.push(`${row.instId}: ${unresolved}`);
    const covered = quantities.reduce((sum, quantity) => sum + (quantity ?? 0), 0);
    const coverage = complete && !ambiguous && !unresolved ? Math.min(size, covered) / size : null;
    return { id: `account:${row.posId || `${row.instId}:${row.mgnMode}:${row.posSide}`}`, source: "account",
      instId: row.instId, instType: row.instType || "UNKNOWN", direction, marginMode: row.mgnMode,
      size, sizeUnit: margin ? "base" : contracts ? "contracts" : "unknown", leverage: optionalNumber(row.lever),
      stopSize: coverage === null ? null : Math.min(size, covered), stopCoverage: coverage,
      coverageLevel: coverage === null ? "unknown" : coverage < 1 ? "red" : "green",
      coverageNote: ambiguous ? "AMBIGUOUS_POSITION_IDENTITY" : !complete ? "STOP_SOURCE_FAILED" : unresolved || "OCO_CONDITIONAL_AND_ATTACHED_ONLY" };
  });
  const botErrors = [];
  // Query each strategy subaccount, not just BTC bots. An unknown internally
  // managed stop must not be misreported as a 100% ordinary OCO stop.
  for (const kind of ["dca", "grid"]) {
    try {
      const params = kind === "dca" ? { algoOrdType: "contract_dca", limit: "100" } : { algoOrdType: "contract_grid", limit: "100" };
      const bots = await privateGet(kind === "dca" ? `${DCA_BASE}/ongoing-list` : "/api/v5/tradingBot/grid/orders-algo-pending", params);
      if (bots.length >= 100) throw new Error(`${kind} bot list may be truncated`);
      for (const bot of bots.filter(bot => !bot.state || bot.state === "running")) {
        const held = await privateGet(kind === "dca" ? `${DCA_BASE}/position-details` : "/api/v5/tradingBot/grid/positions",
          { algoId: bot.algoId, algoOrdType: params.algoOrdType });
        for (const row of held) {
          const quantity = riskNumber(kind === "dca" ? row.sz : row.pos);
          if (quantity === null) throw new Error(`Position size unavailable for bot ${bot.algoId}`);
          const size = Math.abs(quantity);
          if (size === 0) continue;
          positions.push({ id: `${kind}:${bot.algoId}:${row.posSide || bot.direction}`, source: kind,
            instId: row.instId || bot.instId, instType: "SWAP", direction: row.posSide === "net" ? Number(row.pos) < 0 ? "short" : "long" : row.posSide || bot.direction,
            marginMode: row.mgnMode || null, size, sizeUnit: "contracts", leverage: optionalNumber(row.lever || bot.lever),
            stopSize: null, stopCoverage: null, coverageLevel: "unknown", coverageNote: "BOT_INTERNAL_STOP_NOT_ORDINARY_OCO" });
        }
      }
    } catch (error) { botErrors.push(`${kind}: ${error.message}`); }
  }
  return { positions, complete: complete && !positionErrors.length && !botErrors.length, errors: [...stops.filter(result => result.status === "rejected").map(result => result.reason.message), ...positionErrors, ...botErrors],
    scope: "OKX主账户全部非零持仓；策略子账户在页面分开显示，不合并张数" };
}

// Complete UTC daily candles, no intraday close masquerading as history.
export async function loadRadarDailyHistory(instId, { fetchImpl = fetch, nowMs = Date.now(), days = 450 } = {}) {
  const points = new Map();
  let after;
  for (let page = 0; page < Math.ceil(days / 100) + 1; page++) {
    const rows = await okxPublic("/api/v5/market/history-candles", { instId, bar: "1Dutc", limit: "100", ...(after ? { after } : {}) }, fetchImpl);
    if (!rows.length) break;
    for (const row of rows) {
      const ts = Number(row[0]);
      if (row[8] === "1" && ts + 86400000 <= nowMs && Number(row[4]) > 0)
        points.set(ts, { date: new Date(ts).toISOString().slice(0, 10), close: Number(row[4]) });
    }
    const next = rows.at(-1)[0];
    if (next === after) throw new Error("OKX daily history cursor did not advance");
    after = next;
    if (points.size >= days || rows.length < 100) break;
  }
  if (points.size < 30) throw new Error(`Insufficient ${instId} completed daily history`);
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
}

export async function loadCoinbaseDailyHistory(product, { fetchImpl = fetch, nowMs = Date.now(), days = 450 } = {}) {
  const points = new Map();
  const end = Math.floor(nowMs / 86400000) * 86400000;
  for (let offset = 0; offset < days; offset += 250) {
    const until = end - offset * 86400000;
    const since = Math.max(end - days * 86400000, until - 250 * 86400000);
    const params = new URLSearchParams({ granularity: "86400", start: new Date(since).toISOString(), end: new Date(until).toISOString() });
    const rows = await request(`https://api.exchange.coinbase.com/products/${product}/candles?${params}`, { fetchImpl, headers: { "User-Agent": BTC_RADAR_BROWSER_UA } });
    if (!Array.isArray(rows)) throw new Error("Coinbase history malformed");
    for (const row of rows) if (Number(row[0]) * 1000 + 86400000 <= nowMs && Number(row[4]) > 0)
      points.set(Number(row[0]), { date: new Date(Number(row[0]) * 1000).toISOString().slice(0, 10), close: Number(row[4]) });
  }
  if (points.size < 30) throw new Error(`Insufficient Coinbase ${product} history`);
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function parseEtfFlows(html) {
  // Farside publishes USD millions. Require the named Total column, not the
  // final arbitrary HTML cell, and omit incomplete/provisional totals.
  const clean = text => text.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;/g, " ").trim();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const rows = [];
  for (const table of String(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    let totalIndex = -1;
    for (const tr of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => clean(m[1]));
      if (cells.includes("Total")) { totalIndex = cells.indexOf("Total"); continue; }
      const date = cells[0]?.match(/^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/);
      if (!date || totalIndex < 0) continue;
      const cell = cells[totalIndex]?.replaceAll(",", "");
      if (!/^-?\d+(?:\.\d+)?$|^\(\d+(?:\.\d+)?\)$/.test(cell || "")) continue;
      const month = months.indexOf(date[2]);
      if (month < 0) continue;
      rows.push({ date: `${date[3]}-${String(month + 1).padStart(2, "0")}-${date[1].padStart(2, "0")}`,
        flowUsd: Number(cell.replace(/[()]/g, "")) * (cell.startsWith("(") ? -1 : 1) * 1e6 });
    }
  }
  const unique = new Map();
  for (const row of rows) {
    if (unique.has(row.date) && unique.get(row.date).flowUsd !== row.flowUsd) throw new Error("ETF conflicting totals");
    unique.set(row.date, row);
  }
  if (unique.size < 5) throw new Error("ETF complete daily totals unavailable");
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function loadRadarPercentileDatasets(context = {}) {
  const { fetchImpl = fetch, nowMs = Date.now() } = context;
  const loaders = {
    btc: () => loadRadarDailyHistory("BTC-USDT", context),
    gold: () => loadRadarDailyHistory("XAUT-USDT", context),
    treasury: async () => {
      const year = new Date(nowMs).getUTCFullYear();
      return (await Promise.all([year - 1, year].map(y => request(`${TREASURY_BASE}/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`, { fetchImpl, text: true }).then(parseTreasuryCsv)))).flat();
    },
    coinbase: () => loadCoinbaseDailyHistory("BTC-USD", context),
    usdt: () => loadCoinbaseDailyHistory("USDT-USD", context),
    etf: async () => parseEtfFlows(await request("https://farside.co.uk/btc-all-data/", { fetchImpl, text: true, headers: { "User-Agent": BTC_RADAR_BROWSER_UA } })),
    stablecoin: async () => {
      const rows = await request("https://stablecoins.llama.fi/stablecoincharts/all", { fetchImpl });
      if (!Array.isArray(rows)) throw new Error("Stablecoin history malformed");
      return rows.map(row => ({ date: new Date(Number(row.date) * 1000).toISOString().slice(0, 10), supply: finite(row.totalCirculating?.peggedUSD, "Stablecoin USD supply") }));
    },
    // OKX retention is often shorter than one year. Report that as warmup;
    // never pretend 100 days of funding/OI form a 365-day calibration.
    funding: () => loadFundingHistory(context),
    openInterest: async () => {
      const rows = await okxPublic("/api/v5/rubik/stat/contracts/open-interest-history", { instId: "BTC-USDT-SWAP", period: "1D", limit: "100" }, fetchImpl);
      return rows.map(row => ({ date: new Date(Number(row[0])).toISOString().slice(0, 10), value: finite(row[2], "Open interest") }));
    }
  };
  const datasets = {}, errors = [];
  await Promise.all(Object.entries(loaders).map(async ([key, load]) => {
    try { datasets[key] = await load(); }
    catch (error) { errors.push({ key, error: error.message }); }
  }));
  return { datasets, errors, fetchedAt: new Date(nowMs).toISOString() };
}

export async function loadRadarPercentiles(context = {}) {
  const { datasets, errors, fetchedAt } = await loadRadarPercentileDatasets(context);
  const fresh = buildPercentileHistory(datasets);
  const history = {};
  const cutoff = (context.nowMs ?? Date.now()) - 800 * 86400000;
  for (const key of new Set([...Object.keys(context.previousPercentiles?.history || {}), ...Object.keys(fresh)])) {
    history[key] = [...new Map([...(context.previousPercentiles?.history?.[key] || []), ...(fresh[key] || [])]
      .filter(row => Date.parse(row.date) >= cutoff).map(row => [row.date, row])).values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  return { ...percentileInputsAt(history, context.nowMs ?? Date.now()), sourceErrors: errors, fetchedAt };
}
