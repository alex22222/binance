// Downloads the public histories the radar score backtest needs into ./data
// (cached; rerun refreshes). Run with NODE_USE_ENV_PROXY=1 behind a proxy.
import { mkdir, writeFile } from "node:fs/promises";

const dir = new URL("./data/", import.meta.url);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function get(url, type = "json") {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "btc-radar-study" }, signal: AbortSignal.timeout(30000) });
      if (response.ok) return type === "json" ? response.json() : response.text();
      if (attempt >= 4) throw new Error(`${response.status} ${url}`);
    } catch (error) {
      if (attempt >= 4) throw error;
    }
    await pause(2000 * attempt);
  }
}
const save = (name, value) => writeFile(new URL(name, dir), typeof value === "string" ? value : JSON.stringify(value));
await mkdir(dir, { recursive: true });

if (!process.argv.includes("--skip-polymarket")) {
  // Polymarket Fed markets the live factor reads: meeting decisions, the
  // year's (another) hike and the year's cut count, with daily Yes prices.
  const RELEVANT = /^(Fed decision in [A-Za-z]+\?|(Another )?Fed rate hike in \d{4}\?|How many Fed rate cuts (this year|in \d{4})\?)$/i;
  const events = [];
  for (let offset = 0; ; offset += 100) {
    const page = await get(`https://gamma-api.polymarket.com/events?tag_slug=fed-rates&limit=100&offset=${offset}&order=startDate&ascending=true`);
    if (!Array.isArray(page) || !page.length) break;
    events.push(...page.filter((event) => RELEVANT.test(event.title || "")));
  }
  const fed = [];
  for (const event of events) {
    const markets = [];
    for (const market of event.markets || []) {
      const outcomes = JSON.parse(market.outcomes || "[]");
      const tokens = JSON.parse(market.clobTokenIds || "[]");
      const yesToken = tokens[outcomes.indexOf("Yes")];
      if (!yesToken) continue;
      const { history = [] } = await get(`https://clob.polymarket.com/prices-history?market=${yesToken}&interval=max&fidelity=1440`);
      markets.push({ question: market.question, groupItemTitle: market.groupItemTitle, history });
      await pause(150);
    }
    fed.push({ slug: event.slug, title: event.title, startDate: event.startDate, endDate: event.endDate, closed: event.closed, markets });
  }
  await save("polymarket-fed.json", fed);
  console.log("polymarket fed events", fed.length, "markets", fed.reduce((sum, event) => sum + event.markets.length, 0));
}

// OKX completed daily candles, oldest first, over the full listing history:
// "1D" bars close at midnight Hong Kong time like the live radar's, "1Dutc"
// bars at midnight UTC like the page's forward returns.
async function okxDaily(instId, bar) {
  const rows = [];
  for (let after = ""; ; ) {
    const body = await get(`https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=100${after ? `&after=${after}` : ""}`);
    if (body.code !== "0") throw new Error(`${body.code} ${body.msg} ${instId}`);
    if (!body.data.length) break;
    rows.push(...body.data);
    after = body.data.at(-1)[0];
    await pause(200);
  }
  const shift = bar === "1D" ? 8 * 3_600_000 : 0;
  return rows.filter((row) => row[8] === "1").map(([ts, , , , close]) => ({ date: new Date(Number(ts) + shift).toISOString().slice(0, 10), close: Number(close) }))
    .sort((left, right) => left.date.localeCompare(right.date));
}
for (const [name, instId, bar] of [["btc-utc.json", "BTC-USDT", "1Dutc"], ["btc-hkt.json", "BTC-USDT", "1D"], ["xaut-utc.json", "XAUT-USDT", "1Dutc"], ["xaut-hkt.json", "XAUT-USDT", "1D"]]) {
  const closes = await okxDaily(instId, bar);
  await save(name, closes);
  console.log(instId, bar, closes.length, closes[0]?.date, closes.at(-1)?.date);
}

// US Treasury daily par yield curve CSVs.
const treasury = [];
for (let year = 2017; year <= 2026; year += 1) {
  treasury.push(await get(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`, "text"));
}
await save("treasury.json", treasury);
console.log("treasury csv years", treasury.length);
