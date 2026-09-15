import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { parseYahooAdjustedDailyChart } from "./us-etf-rotation-backtest.mjs";
import { latestCompletedTradingDate } from "./strategy-data.mjs";
import { researchTradingDates } from "./weekly-research-calendar.mjs";
import { evaluateCandidate, hashResearch, RESEARCH_RULES, validateDailyHistory, WEEKLY_POLICY } from "./weekly-research.mjs";

const execFileAsync = promisify(execFile);
const DAY = 86400000;
export async function publicResearchFetch(url) {
  const transport = new URL(url).hostname === "fred.stlouisfed.org" ? ["--http1.1"] : [];
  const { stdout } = await execFileAsync("curl", ["-fsSL", "--compressed", ...transport, "--max-time", "25", "--retry", "1", "--retry-delay", "1", "--retry-max-time", "35", "-A", "Mozilla/5.0", url], { maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
  return stdout;
}

export function parseFredCsv(text, cutoff, maxAgeDays) {
  const rows = text.trim().split(/\r?\n/).slice(1).map((line) => {
    const [date, value] = line.split(",");
    return { date, value: value === "" || value === "." ? NaN : Number(value) };
  }).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.date <= cutoff && Number.isFinite(row.value));
  const latest = rows.at(-1);
  return { rows: rows.slice(-400), effectiveAt: latest?.date || null,
    status: latest && Date.parse(cutoff) - Date.parse(latest.date) <= maxAgeDays * DAY ? "AVAILABLE" : "STALE_OR_EMPTY",
    limitation: "Current vintage; observation date is not release date. Context only, never historical strategy input." };
}

const plain = (text) => String(text || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, "").replaceAll("&amp;", "&").trim();
export function parseResearchFeed(text, nowMs) {
  const entries = [...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].flatMap(([, block]) => {
    const field = (tag) => plain(block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1]);
    const publishedAt = field("pubDate"), time = Date.parse(publishedAt);
    const url = field("link");
    if (!Number.isFinite(time) || time > nowMs || nowMs - time > 30 * DAY || !url.startsWith("https://")) return [];
    return [{ title: field("title"), url, publishedAt: new Date(time).toISOString(), summary: field("description").slice(0, 1200) }];
  }).slice(0, 30);
  return { status: entries.length ? "AVAILABLE" : "STALE_OR_EMPTY", entries,
    limitation: "Discovery feed, not comprehensive political coverage; manager must read linked originals and check opposing evidence." };
}

export function filterPredictionMarkets(markets, nowMs) {
  if (!Array.isArray(markets)) throw new Error("Invalid Gamma markets payload");
  const seen = new Set();
  const selected = [];
  for (const market of markets) {
    const relevant = /federal reserve|fed interest|interest rate|recession|inflation|tariff|election|war|ceasefire|treasury|gold price|gdp/i.test(market.question || "");
    const expires = Date.parse(market.endDate), updated = Date.parse(market.updatedAt);
    const liquidity = Number(market.liquidityNum), volume24hr = Number(market.volume24hr);
    const bid = Number(market.bestBid), ask = Number(market.bestAsk);
    if (!relevant || market.active !== true || market.closed !== false || market.archived === true
      || !Number.isFinite(expires) || expires <= nowMs || !Number.isFinite(updated) || updated > nowMs || nowMs - updated > DAY
      || !(liquidity >= 10000) || !(volume24hr >= 1000) || market.bestBid == null || market.bestAsk == null
      || !(bid > 0 && bid <= ask && ask < 1 && ask - bid <= 0.1) || !market.description) continue;
    let outcomes, probabilities;
    try { outcomes = JSON.parse(market.outcomes); probabilities = JSON.parse(market.outcomePrices).map(Number); } catch { continue; }
    if (outcomes.length !== 2 || probabilities.length !== 2 || !outcomes.includes("Yes") || !outcomes.includes("No")
      || probabilities.some((value) => !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(probabilities[0] + probabilities[1] - 1) > 0.03) continue;
    const eventId = String(market.events?.[0]?.id || market.id);
    if (seen.has(eventId)) continue;
    seen.add(eventId);
    selected.push({ id: String(market.id), eventId, question: market.question, resolution: market.description.slice(0, 5000),
      endDate: market.endDate, updatedAt: market.updatedAt, liquidity, volume24hr, bid, ask, outcomes, probabilities,
      url: `https://polymarket.com/event/${encodeURIComponent(market.events?.[0]?.slug || market.slug)}` });
  }
  return { status: selected.length ? "AVAILABLE" : "NO_QUALIFIED_MARKETS", markets: selected.slice(0, 20),
    limitation: "Filtered sample of 300 high-volume markets; prices are market-implied beliefs, not calibrated objective probabilities. No trade authorization." };
}

export async function collectWeeklyResearch({ universe, universeSource, nowMs = Date.now(), fetchText = publicResearchFetch }) {
  if (!Array.isArray(universe) || !universe.length || universe.length > 100 || universe.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) || new Set(universe).size !== universe.length) throw new Error("Invalid research universe");
  const cutoff = latestCompletedTradingDate(nowMs);
  const start = `${Number(cutoff.slice(0, 4)) - 6}${cutoff.slice(4)}`;
  const expectedDates = researchTradingDates(start, cutoff);
  const sources = [], history = {}, quality = {}, raw = {};
  const collectedAt = new Date(nowMs).toISOString();
  const tasks = [];
  function task(id, axis, url, parse) {
    tasks.push(async () => {
      try {
        const text = await fetchText(url); raw[id] = text;
        const value = parse(text);
        sources.push({ id, axis, url, retrievedAt: collectedAt, contentHash: hashResearch(text), ...value });
      } catch (error) {
        sources.push({ id, axis, url, retrievedAt: collectedAt, status: "FETCH_OR_PARSE_FAILED", contentHash: null,
          failureCode: String(error.code || error.name || "UNKNOWN"), httpStatus: String(error.stderr || "").match(/error: (\d{3})/)?.[1] || null });
      }
    });
  }
  for (const symbol of [...new Set([...universe, "GLD", "TLT", "SPY", "QQQ"])]) {
    const axis = symbol === "GLD" ? "gold" : symbol === "TLT" ? "bonds" : "technical";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${Date.parse(start) / 1000}&period2=${Math.floor((Date.parse(cutoff) + DAY) / 1000)}&interval=1d&events=div%2Csplits`;
    task(`price-${symbol}`, axis, url, (text) => {
      const chart = JSON.parse(text).chart?.result?.[0];
      if (!chart) throw new Error("Missing chart");
      // Keep out-of-cutoff/duplicate rows visible to the validator; do not silently align intersections.
      const bars = parseYahooAdjustedDailyChart(chart);
      history[symbol] = bars;
      quality[symbol] = validateDailyHistory(bars, expectedDates);
      return { status: quality[symbol].passed ? "AVAILABLE" : "INVALID_HISTORY", effectiveAt: bars.at(-1)?.date, quality: quality[symbol],
        latest: bars.at(-1), return20dPct: bars.length > 20 ? (bars.at(-1).close / bars.at(-21).close - 1) * 100 : null,
        instrument: "UNDERLYING_ADJUSTED_DAILY_PROXY", referenceOnly: !universe.includes(symbol), publishedAt: null };
    });
  }
  for (const [series, axis, age] of [["DGS10", "bonds", 7], ["DGS2", "bonds", 7], ["DFII10", "bonds", 7], ["FEDFUNDS", "macro", 65], ["CPIAUCSL", "macro", 65], ["UNRATE", "macro", 65]]) {
    task(`fred-${series}`, axis, `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${start}`, (text) => parseFredCsv(text, cutoff, age));
  }
  task("fed-news", "macro", "https://www.federalreserve.gov/feeds/press_all.xml", (text) => parseResearchFeed(text, nowMs));
  task("whitehouse-news", "politics", "https://www.whitehouse.gov/news/feed/", (text) => parseResearchFeed(text, nowMs));
  task("gamma-markets", "polymarket", "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=300", (text) => filterPredictionMarkets(JSON.parse(text), nowMs));
  let cursor = 0;
  await Promise.all(Array.from({ length: 3 }, async () => { while (cursor < tasks.length) await tasks[cursor++](); }));
  for (const symbol of universe) quality[symbol] ||= validateDailyHistory([], expectedDates);
  const candidates = universe.flatMap((symbol) => RESEARCH_RULES.map((rule) => ({ id: `${symbol}:${rule}`, symbol,
    ...evaluateCandidate(history[symbol] || [], rule, quality[symbol]) })));
  const codeHashes = {};
  for (const file of ["weekly-research.mjs", "weekly-research-data.mjs", "weekly-research-calendar.mjs", "us-etf-rotation-backtest.mjs", "strategy-data.mjs", "strategy.mjs"]) {
    codeHashes[file] = hashResearch(await readFile(new URL(file, import.meta.url), "utf8"));
  }
  return { bundle: { schemaVersion: 1, collectedAt, cutoff, start, universe: [...universe], universeSource, policy: WEEKLY_POLICY,
    sources: sources.sort((a, b) => a.id.localeCompare(b.id)), quality, candidates, codeHashes,
    historyHash: hashResearch(history), liveAuthorized: false,
    limitations: ["Current universe survivorship bias; no delisted-universe reconstruction.", "Two fixed research rules per symbol, all results retained; selecting winners across tests is not proof of alpha.",
      "Daily momentum is not the live 15-minute adaptive strategy. Close-breakout is not the production high/low ATR Turtle rule.",
      "No macro/news/probability vintage history is used in backtests; only contemporary scenario analysis.",
      "50/100 bps per side are conservative research assumptions, not measured executable token costs; no wallet access.",
      "Retrospective split has been observed; independent publish-forward evidence begins only after artifact freeze."] }, history, raw };
}
