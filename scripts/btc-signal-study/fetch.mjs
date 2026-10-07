// Downloads the public histories the study needs into ./data (cached; rerun refreshes).
import { writeFile } from "node:fs/promises";
const dir = new URL("./data/", import.meta.url);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function get(url, type = "json") {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { headers: { "User-Agent": "btc-signal-study" } });
    if (response.ok) return type === "json" ? response.json() : response.text();
    if (attempt >= 4) throw new Error(`${response.status} ${url}`);
    await pause(3000 * attempt);
  }
}
const save = (name, value) => writeFile(new URL(name, dir), typeof value === "string" ? value : JSON.stringify(value));

// CoinMetrics community: daily close (PriceUSD) and MVRV.
let url = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=PriceUSD,CapMVRVCur&frequency=1d&start_time=2014-01-01&page_size=10000";
const coinmetrics = [];
while (url) { const page = await get(url); coinmetrics.push(...page.data); url = page.next_page_url; }
await save("coinmetrics.json", coinmetrics);
console.log("coinmetrics", coinmetrics.length, coinmetrics[0]?.time, coinmetrics.at(-1)?.time);

// BitMEX XBTUSD funding (8h) since 2016.
const funding = [];
for (let start = 0; ; start += 500) {
  const page = await get(`https://www.bitmex.com/api/v1/funding?symbol=XBTUSD&count=500&start=${start}&reverse=false`);
  funding.push(...page.map(({ timestamp, fundingRate, fundingInterval }) => ({ timestamp, fundingRate, fundingInterval })));
  if (page.length < 500) break;
  await pause(2500);
}
await save("bitmex-funding.json", funding);
console.log("funding", funding.length, funding[0]?.timestamp, funding.at(-1)?.timestamp);

// Crypto Fear & Greed (alternative.me), full history.
const fng = (await get("https://api.alternative.me/fng/?limit=0&format=json")).data;
await save("fng.json", fng);
console.log("fng", fng.length, fng.at(-1)?.timestamp, fng[0]?.timestamp);

// FRED: broad dollar index, 10y real yield, 10y nominal yield.
for (const id of ["DTWEXBGS", "DFII10", "DGS10"]) {
  const csv = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, "text");
  await save(`${id}.csv`, csv);
  const lines = csv.trim().split("\n");
  console.log(id, lines.length - 1, lines[1]?.split(",")[0], lines.at(-1));
}

// Gold: Stooq XAUUSD daily (for the radar's gold factor).
try {
  const csv = await get("https://stooq.com/q/d/l/?s=xauusd&i=d", "text");
  await save("xauusd.csv", csv);
  const lines = csv.trim().split("\n");
  console.log("xauusd", lines.length - 1, lines[1]?.split(",")[0], lines.at(-1)?.split(",")[0]);
} catch (error) { console.log("xauusd unavailable:", error.message); }
