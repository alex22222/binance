// Data for the 15m condition study: BTCUSDT 1m klines with volume, the Future wallet's trades and
// the outcomes of the 15m rounds it traded. Cache: artifacts/15m-conditions/. Rerun resumes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { researchArtifactPath } from '../src/polymarket-updown.mjs';

const OUT = researchArtifactPath('15m-conditions');
const WALLET = '0xf86f775c633d70ae3aa871f541cfb2dfeb319a24';
const KLINES = 'https://data-api.binance.vision/api/v3/klines';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 8) {
  for (let attempt = 0; ; attempt++) {
    try {
      await sleep(120);
      const res = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { 'user-agent': 'Mozilla/5.0' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { fatal: true });
      return await res.json();
    } catch (err) {
      if (err.fatal || attempt >= tries) throw err;
      await sleep(1000 + 1000 * Math.min(attempt + 1, 4));
    }
  }
}

// One file per month: [openSec, open, high, low, close, volumeBtc, takerBuyBtc, trades].
async function fetchKlines() {
  const dir = path.join(OUT, 'klines');
  await fs.mkdir(dir, { recursive: true });
  const now = Date.now();
  for (let m = Date.UTC(2026, 3, 1); m < now; m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1)) {
    const end = Math.min(Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1), now);
    const file = path.join(dir, `${new Date(m).toISOString().slice(0, 7)}.json`);
    const complete = end < now - 86400e3;
    try { if (complete && JSON.parse(await fs.readFile(file, 'utf8')).length >= (end - m) / 60000 - 5) continue; } catch {}
    const rows = [];
    for (let t = m; t < end;) {
      const batch = await getJson(`${KLINES}?symbol=BTCUSDT&interval=1m&startTime=${t}&endTime=${end - 1}&limit=1000`);
      if (!batch.length) break;
      for (const k of batch) rows.push([k[0] / 1000, +k[1], +k[2], +k[3], +k[4], +k[5], +k[9], k[8]]);
      t = batch.at(-1)[0] + 60000;
    }
    await fs.writeFile(file, JSON.stringify(rows));
    console.log(`klines ${path.basename(file)}: ${rows.length}`);
  }
}

async function fetchWallet() {
  const trades = [];
  for (let offset = 0; ; offset += 500) {
    const rows = await getJson(`https://data-api.polymarket.com/trades?user=${WALLET}&limit=500&offset=${offset}&takerOnly=false`);
    trades.push(...rows);
    if (rows.length < 500) break;
  }
  await fs.writeFile(path.join(OUT, 'wallet-trades.json'), JSON.stringify(trades));
  const file = path.join(OUT, 'outcomes.json');
  let outcomes = {};
  try { outcomes = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  const markets = new Map(trades.filter((t) => /^btc-updown-(15m|5m)-\d+$/.test(t.slug)).map((t) => [t.slug, t.conditionId]));
  for (const [slug, condition] of markets) {
    if (outcomes[slug]) continue;
    const market = await getJson(`https://clob.polymarket.com/markets/${condition}`);
    const winner = market.tokens?.find((token) => token.winner)?.outcome;
    if (winner) outcomes[slug] = winner;
  }
  await fs.writeFile(file, JSON.stringify(outcomes));
  console.log(`wallet trades ${trades.length}; resolved rounds ${Object.keys(outcomes).length}/${markets.size}`);
}

await fs.mkdir(OUT, { recursive: true });
await fetchWallet();
await fetchKlines();
