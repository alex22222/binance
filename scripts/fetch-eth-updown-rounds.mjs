// ETH / XRP / SOL 15m and 1h Up/Down rounds with every taker buy, plus the coin's USDT 1m klines,
// for backtesting the live 15m counter-1h + R1 strategy on other coins. Same record format as
// weekend-favorite-timing/*.jsonl. Cache: artifacts/<coin>-updown/. All days 2026-04-04 .. 2026-10-21;
// weekends are fetched first.
// Usage: ASSET=eth|xrp|sol NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 node scripts/fetch-eth-updown-rounds.mjs
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { etParts, isEtWeekend, researchArtifactPath } from '../src/polymarket-updown.mjs';

const ASSETS = {
  btc: { hourly: 'bitcoin', symbol: 'BTCUSDT' },
  eth: { hourly: 'ethereum', symbol: 'ETHUSDT' },
  xrp: { hourly: 'xrp', symbol: 'XRPUSDT' },
  sol: { hourly: 'solana', symbol: 'SOLUSDT' },
};
const ASSET = process.env.ASSET ?? 'eth';
const COIN = ASSETS[ASSET];
if (!COIN) throw new Error(`ASSET must be one of ${Object.keys(ASSETS).join(', ')}`);
const OUT = researchArtifactPath(process.env.OUT_DIR ?? `${ASSET}-updown`);
const GAMMA_EVENTS = 'https://gamma-api.polymarket.com/events';
const DATA_TRADES = 'https://data-api.polymarket.com/trades';
const KLINES = 'https://data-api.binance.vision/api/v3/klines';
// FROM / TO (ISO dates or timestamps) override the default window, e.g. for a weekly review.
const FROM = process.env.FROM ? Date.parse(process.env.FROM) / 1000 : Date.UTC(2026, 3, 4, 4) / 1000; // Sat 2026-04-04 00:00 EDT
const TO = process.env.TO ? Date.parse(process.env.TO) / 1000 : Date.UTC(2026, 9, 21, 4) / 1000; // Wed 2026-10-21 00:00 EDT
const hourly = (s) => { const p = etParts(s); return `${COIN.hourly}-up-or-down-${p.month.toLowerCase()}-${p.day}-${p.year}-${p.hour}${p.dayPeriod.toLowerCase()}-et`; };
const SERIES = { '1h': { sec: 3600, slug: hourly }, '15m': { sec: 900, slug: (s) => `${ASSET}-updown-15m-${s}` } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;
async function paced() {
  const now = Date.now(), wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 85; // Data API: 200 /trades requests per 10 s
  if (wait) await sleep(wait);
}
async function getJson(url, tries = 8) {
  for (let attempt = 0; ; attempt++) {
    try {
      await paced();
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { fatal: true });
      return await res.json();
    } catch (err) {
      if (err.fatal || attempt >= tries) throw err;
      await sleep(1000 + Math.random() * 1000 * Math.min(attempt + 1, 4));
    }
  }
}
async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}
const regimeOf = (d = '') => (/TWAP/.test(d) ? 'twap' : /Chainlink/.test(d) ? 'chainlink' : /Binance/.test(d) ? 'binance' : 'other');
async function takerTrades(conditionId, lo, hi) {
  const rows = await getJson(`${DATA_TRADES}?market=${conditionId}&takerOnly=true&limit=1000&start=${lo}&end=${hi}`);
  if (rows.length < 1000 || hi <= lo) return rows;
  const mid = Math.floor((lo + hi) / 2);
  return [...(await takerTrades(conditionId, lo, mid)), ...(await takerTrades(conditionId, mid + 1, hi))];
}

function marketWinner(market) {
  // Closure and extreme quotes alone are not resolution evidence. Missing status stays unknown.
  if (market.closed !== true || market.umaResolutionStatus !== 'resolved' || typeof market.conditionId !== 'string' || !market.conditionId) return null;
  try {
    const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    if (!Array.isArray(outcomes) || outcomes.length !== 2 || !outcomes.includes('Up') || !outcomes.includes('Down')) return null;
    if (!Array.isArray(prices) || prices.length !== 2 || !prices.every((p) =>
      (typeof p === 'number' || typeof p === 'string' && p.trim() !== '') && [0, 1].includes(Number(p)))) return null;
    const binary = prices.map(Number);
    return binary[0] + binary[1] === 1 ? outcomes[binary.indexOf(1)] : null;
  } catch { return null; }
}

async function fetchRounds(name) {
  const series = SERIES[name], file = path.join(OUT, `${name}.jsonl`), cached = new Map();
  if (existsSync(file)) for (const line of (await fs.readFile(file, 'utf8')).split('\n')) if (line) {
    const row = JSON.parse(line); cached.set(row.start, row);
  }
  // Legacy winners were inferred by array position without checking closure; revalidate in the requested window.
  const complete = (r) => r && !r.missing && r.settlementValidated === true && ['Up', 'Down'].includes(r.winner)
    && r.settlement && marketWinner(r.settlement) === r.winner && Array.isArray(r.buys);
  const done = new Set([...cached.values()].filter(complete).map((r) => r.start));
  const todo = [];
  for (let s = FROM; s < TO; s += series.sec) if (!done.has(s)) todo.push(s);
  todo.sort((a, b) => Number(!isEtWeekend(a)) - Number(!isEtWeekend(b)) || a - b);
  console.log(`${name}: ${done.size} cached, ${todo.length} to fetch`);
  const batches = [];
  for (let i = 0; i < todo.length; i += 20) batches.push(todo.slice(i, i + 20));
  let written = 0, failed = 0;
  await pool(batches, 2, async (batch) => {
    try {
      const events = await getJson(`${GAMMA_EVENTS}?${batch.map((s) => `slug=${encodeURIComponent(series.slug(s))}`).join('&')}`);
      const bySlug = new Map(events.map((e) => [e.slug, e]));
      const lines = [];
      await pool(batch, 3, async (start) => {
        const event = bySlug.get(series.slug(start)), market = event?.markets?.[0];
        if (!market) return void lines.push({ start, slug: series.slug(start), missing: true });
        const settlement = { conditionId: market.conditionId ?? null, closed: market.closed ?? null,
          umaResolutionStatus: market.umaResolutionStatus ?? null, outcomes: market.outcomes ?? null, outcomePrices: market.outcomePrices ?? null };
        const winner = marketWinner(settlement);
        const trades = market.conditionId ? await takerTrades(market.conditionId, start, start + series.sec) : [];
        const buys = trades.filter((t) => t.side === 'BUY' && t.timestamp >= start && t.timestamp < start + series.sec)
          .map((t) => [t.timestamp - start, t.outcome === 'Up' ? 1 : 0, +t.price, +(+t.size).toFixed(2)]).sort((a, b) => a[0] - b[0]);
        lines.push({ start, slug: event.slug, regime: regimeOf(market.description), feeType: market.feeType ?? null,
          winner, settlement, settlementValidated: winner != null, volume: Math.round(+market.volume || 0), nTaker: trades.length, buys });
      });
      for (const row of lines) cached.set(row.start, row);
      written += batch.length;
      if (written % 1000 < 20) console.log(`${name}: ${written}/${todo.length}`);
    } catch (err) {
      failed++;
      console.warn(`${name}: batch at ${batch[0]} failed (${err.message}); rerun to resume`);
    }
  });
  if (written) {
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, [...cached.values()].sort((a, b) => a.start - b.start).map(JSON.stringify).join('\n') + '\n');
    await fs.rename(temporary, file);
  }
  const incomplete = todo.filter((s) => !complete(cached.get(s))).length;
  if (failed || incomplete) throw new Error(`${name}: ${failed} failed batches, ${incomplete} incomplete rounds; rerun to resume`);
}

// One file per month: [openSec, open, high, low, close, volume, takerBuy, trades].
async function fetchKlines() {
  const dir = path.join(OUT, 'klines');
  await fs.mkdir(dir, { recursive: true });
  const now = Date.now();
  for (let m = Date.UTC(2026, 3, 1); m < now; m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1)) {
    const end = Math.min(Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1), now);
    const file = path.join(dir, `${new Date(m).toISOString().slice(0, 7)}.json`);
    if (existsSync(file) && end < now - 86400e3) continue;
    const rows = [];
    for (let t = m; t < end;) {
      const batch = await getJson(`${KLINES}?symbol=${COIN.symbol}&interval=1m&startTime=${t}&endTime=${end - 1}&limit=1000`);
      if (!batch.length) break;
      for (const k of batch) rows.push([k[0] / 1000, +k[1], +k[2], +k[3], +k[4], +k[5], +k[9], k[8]]);
      t = batch.at(-1)[0] + 60000;
    }
    await fs.writeFile(file, JSON.stringify(rows));
    console.log(`klines ${path.basename(file)}: ${rows.length}`);
  }
}

await fs.mkdir(OUT, { recursive: true });
if (!process.env.SKIP_KLINES) await fetchKlines();
await fetchRounds('1h');
await fetchRounds('15m');
console.log('done');
