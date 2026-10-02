import { createHmac } from "node:crypto";
import { isTransientNetworkError } from "./reliability.mjs";
import { retry } from "./retry.mjs";

const OKX_BASE = "https://www.okx.com";
const POLYMARKET_BASE = "https://gamma-api.polymarket.com";
const TREASURY_BASE = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv";
const DCA_BASE = "/api/v5/tradingBot/dca";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const BTC_RADAR_SOURCES = Object.freeze([
  ["Polymarket", "https://polymarket.com/crypto/bitcoin"],
  ["美国财政部收益率", "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve"],
  ["OKX 行情 / 持仓", "https://www.okx.com"],
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
      headers: { Accept: text ? "text/csv" : "application/json", ...headers },
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

// "Dip to $X" markets become dips and "Reach $X" markets become reaches.
// Duplicated levels keep the higher Yes price: a resolved market reads 1.
export function priceLadder(markets) {
  const ladder = { dips: {}, reaches: {} };
  for (const market of markets || []) {
    const match = String(market.question || "").match(/\b(dip to|reach)\s+\$([\d,]+(?:\.\d+)?)/i);
    const yes = yesPrice(market);
    if (!match || yes === null) continue;
    const level = Number(match[2].replaceAll(",", ""));
    if (!(level > 0)) continue;
    const side = match[1].toLowerCase().startsWith("dip") ? ladder.dips : ladder.reaches;
    side[String(level)] = Math.max(side[String(level)] ?? 0, yes);
  }
  if (!Object.keys(ladder.dips).length || !Object.keys(ladder.reaches).length) {
    throw new Error("Polymarket price ladder is missing dip or reach markets");
  }
  return ladder;
}

const WEEKLY_TITLE = new RegExp(
  `^What price will Bitcoin hit ((?:${MONTHS.join("|")}) \\d{1,2}\\s*[-–]\\s*(?:(?:${MONTHS.join("|")}) )?\\d{1,2})\\?$`
);

export function selectWeeklyEvent(events, nowMs) {
  return events
    .filter((event) => WEEKLY_TITLE.test(event.title || "") && Date.parse(event.endDate) > nowMs)
    .sort((left, right) => Date.parse(left.endDate) - Date.parse(right.endDate))[0] || null;
}

export async function loadPolymarketWeek({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const events = await request(
    `${POLYMARKET_BASE}/events?tag_slug=bitcoin&active=true&closed=false&limit=100&order=volume24hr&ascending=false`,
    { fetchImpl }
  );
  const event = selectWeeklyEvent(Array.isArray(events) ? events : [], nowMs);
  if (!event) throw new Error("Weekly Bitcoin price-hit event not found");
  return { label: event.title.match(WEEKLY_TITLE)[1], ...priceLadder(event.markets) };
}

export async function loadPolymarketMonth({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const { year, month } = newYorkMonth(nowMs);
  const slug = `what-price-will-bitcoin-hit-in-${MONTHS[month - 1].toLowerCase()}-${year}`;
  const events = await request(`${POLYMARKET_BASE}/events?slug=${slug}`, { fetchImpl });
  const event = Array.isArray(events) ? events[0] : null;
  if (!event) throw new Error(`Monthly Bitcoin price-hit event not found: ${slug}`);
  return { label: `${month}月`, ...priceLadder(event.markets) };
}

function meetingProbabilities(event) {
  let hike = 0;
  let cut = 0;
  for (const market of event.markets || []) {
    const yes = yesPrice(market);
    const label = `${market.groupItemTitle || ""} ${market.question || ""}`.toLowerCase();
    if (yes === null) continue;
    if (/\bincrease/.test(label)) hike += yes;
    else if (/\bdecrease/.test(label)) cut += yes;
  }
  return { hike: Number(hike.toFixed(6)), cut: Number(cut.toFixed(6)) };
}

export function fedExpectations(events, nowMs) {
  const decision = /^Fed Decision in ([A-Z][a-z]+)\?$/;
  const meetings = events
    .filter((event) => decision.test(event.title || "") && Date.parse(event.endDate) > nowMs)
    .sort((left, right) => Date.parse(left.endDate) - Date.parse(right.endDate));
  if (!meetings.length) throw new Error("Next Fed decision market not found");
  const [next, following] = meetings.map(meetingProbabilities);
  const month = MONTHS.indexOf(meetings[0].title.match(decision)[1]) + 1;
  if (month < 1) throw new Error("Fed decision month is not recognized");
  const { year } = newYorkMonth(nowMs);
  const anotherHike = events.find((event) => event.title === `Another Fed rate hike in ${year}?`);
  const hikeYes = anotherHike ? yesPrice(anotherHike.markets?.[0]) : null;
  const cuts = events.find((event) => event.title === `How many Fed rate cuts in ${year}?`);
  const noCut = cuts?.markets?.find((market) => /\bno fed rate cuts\b/i.test(market.question || ""));
  const noCutYes = noCut ? yesPrice(noCut) : null;
  return {
    next_meeting: `${month}月议息`,
    p_hike_next: next.hike,
    p_cut_next: next.cut,
    p_hike_2026_any: hikeYes ?? Math.max(next.hike, following?.hike ?? 0),
    p_cut_2026_any: noCutYes === null ? Math.max(next.cut, following?.cut ?? 0) : Number((1 - noCutYes).toFixed(6))
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

export function dcaPosition(bot, details) {
  const stop = (bot.triggerParams || []).find((trigger) => trigger.triggerAction === "stop");
  const filled = finite(details.fillSafetyOrds, "Filled safety orders");
  const maximum = finite(bot.maxSafetyOrds, "Maximum safety orders");
  const step = finite(bot.pxSteps, "Price step");
  const multiplier = Number(bot.pxStepsMult) > 0 ? Number(bot.pxStepsMult) : 1;
  let deviation = 0;
  for (let order = 0; order <= filled; order += 1) deviation += step * multiplier ** order;
  return {
    avg: round(finite(details.avgPx, "Average price"), 2),
    tp: finite(details.tpPx, "Take-profit price"),
    sl: Number(stop?.triggerPx) > 0 ? Number(stop.triggerPx) : 0,
    liq: round(finite(details.liqPx, "Liquidation price"), 1),
    sz_btc: round(finite(details.sz, "Contracts") * (Number(bot.ctVal) > 0 ? Number(bot.ctVal) : 0.01), 4),
    lever: finite(bot.lever, "Leverage"),
    total_pnl: round(finite(bot.totalPnl, "Total PnL"), 2),
    safety_filled: filled,
    safety_max: maximum,
    next_safety: filled >= maximum ? null : round(finite(details.initPx, "Initial price") * (1 - deviation), 1)
  };
}

// The newest running BTC-USDT-SWAP long contract DCA bot, unless one is pinned.
export async function loadDcaPosition(privateGet, { pinnedAlgoId = null, trackedAlgoId = null } = {}) {
  const running = (await privateGet(`${DCA_BASE}/ongoing-list`, { algoOrdType: "contract_dca" }))
    .filter((bot) => bot.instId === "BTC-USDT-SWAP" && bot.direction === "long" && (!bot.state || bot.state === "running"));
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
  if (!bot) return { position: null, algoId: null, events };
  const [details] = await privateGet(`${DCA_BASE}/position-details`, { algoId: bot.algoId, algoOrdType: "contract_dca" });
  if (!details) throw new Error(`DCA position details missing for ${bot.algoId}`);
  return { position: dcaPosition(bot, details), algoId: bot.algoId, events };
}
