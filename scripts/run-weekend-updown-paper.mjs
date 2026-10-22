#!/usr/bin/env node
// Paper runner for the weekend "+60s direction" strategy on Polymarket BTC Up/Down rounds
// (the markets future.news lists). Real-time data, simulated fills, no orders are sent:
//   - at round open + 60s (US-Eastern Saturdays and Sundays only) compare the current price
//     with the round's price to beat and pick the side the price is on;
//   - walk the live CLOB asks for a taker buy of --stake USDC, taker fee 0.07 * p * (1 - p);
//   - settle against the market's own resolution.
//
// Usage:
//   NODE_USE_ENV_PROXY=1 node scripts/run-weekend-updown-paper.mjs [--stake=10] [--series=5m,15m,1h,4h] [--max-price=0.99]
//   node scripts/run-weekend-updown-paper.mjs --status
// Stop taking new bets (open bets still settle): touch state/weekend-updown-paper/STOP

import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SERIES,
  directionOf,
  isEtWeekend,
  roundStart,
  settlePnl,
  simulateMarketBuy,
  winnerOf,
} from '../src/polymarket-updown.mjs';

const DIR = path.resolve(process.env.RESEARCH_PAPER_DIR || fileURLToPath(new URL('../state/weekend-updown-paper/', import.meta.url)));
const LEDGER = path.join(DIR, 'ledger.jsonl');
const STOP_FILE = path.join(DIR, 'STOP');
const GAMMA_EVENTS = 'https://gamma-api.polymarket.com/events';
const CLOB_BOOK = 'https://clob.polymarket.com/book';
const CRYPTO_PRICE = 'https://polymarket.com/api/crypto/crypto-price';
const BINANCE = 'https://data-api.binance.vision/api/v3';
const RTDS = 'wss://ws-live-data.polymarket.com';

const ENTRY_DELAY_SEC = 60;
const ENTRY_GRACE_SEC = 20; // a round reached later than +80s is recorded as missed
const PRICE_STALE_MS = 5000;
const OFFICIAL_WAIT_SEC = 3 * 3600; // after this, record a separate price estimate, never an official settlement

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const STAKE = Number(arg('stake', '10'));
const ENABLED = arg('series', '5m,15m,1h,4h').split(',').filter((s) => SERIES[s]);
const MAX_PRICE = Number(arg('max-price', '0.99'));

const log = (...parts) => console.log(new Date().toISOString(), ...parts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoSec = (s) => new Date(s * 1000).toISOString().replace('.000', '');

async function getJson(url, tries = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt + 1 >= tries) throw new Error(`${url.split('?')[0]}: ${err.message}`);
      await sleep(400);
    }
  }
}

function readLedger() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const append = (record) => fs.appendFile(LEDGER, JSON.stringify(record) + '\n');

// ---------------------------------------------------------------------------
// Prices

// Chainlink BTC/USD (the "Current Price" future.news shows) from Polymarket's live data feed.
const chainlink = { value: null, observedAt: 0, receivedAt: 0 };

function connectChainlink() {
  let ws = null;
  const open = () => {
    ws = new WebSocket(RTDS);
    let ping = null;
    ws.onopen = () => {
      const filters = JSON.stringify({ symbol: 'btc/usd' });
      ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters }] }));
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('PING'), 5000);
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const payload = msg.payload;
      const point = payload?.value != null ? payload : payload?.data?.at(-1);
      if (!(point?.value > 0)) return;
      chainlink.value = Number(point.value);
      chainlink.observedAt = point.timestamp ?? Date.now();
      chainlink.receivedAt = Date.now();
    };
    ws.onclose = () => {
      clearInterval(ping);
      setTimeout(open, 2000);
    };
    ws.onerror = () => ws.close();
  };
  open();
  setInterval(() => {
    if (Date.now() - chainlink.receivedAt > 30000 && ws?.readyState === WebSocket.OPEN) {
      log('chainlink feed quiet for 30s, reconnecting');
      ws.close();
    }
  }, 10000);
}

async function priceToBeat(name, start) {
  const series = SERIES[name];
  if (!series.priceVariant) {
    // Hourly rounds settle on the Binance BTCUSDT 1H candle.
    const [candle] = await getJson(`${BINANCE}/klines?symbol=BTCUSDT&interval=1h&startTime=${start * 1000}&limit=1`);
    return candle?.[0] === start * 1000 ? Number(candle[1]) : null;
  }
  const d = await getJson(
    `${CRYPTO_PRICE}?symbol=BTC&eventStartTime=${isoSec(start)}&variant=${series.priceVariant}&endDate=${isoSec(start + series.sec)}`,
  );
  return d.openPrice > 0 ? d.openPrice : null;
}

async function currentPrice(name) {
  if (!SERIES[name].priceVariant) {
    const d = await getJson(`${BINANCE}/ticker/price?symbol=BTCUSDT`);
    return { price: Number(d.price), source: 'binance', ageMs: 0 };
  }
  const ageMs = Date.now() - chainlink.observedAt;
  return { price: ageMs <= PRICE_STALE_MS ? chainlink.value : null, source: 'chainlink', ageMs };
}

async function provisionalWinner(bet) {
  const series = SERIES[bet.series];
  if (!series.priceVariant) {
    const [candle] = await getJson(`${BINANCE}/klines?symbol=BTCUSDT&interval=1h&startTime=${bet.start * 1000}&limit=1`);
    return candle && Date.now() > candle[6] ? winnerOf(Number(candle[4]), Number(candle[1])) : null;
  }
  const d = await getJson(
    `${CRYPTO_PRICE}?symbol=BTC&eventStartTime=${isoSec(bet.start)}&variant=${series.priceVariant}&endDate=${isoSec(bet.end)}`,
  );
  return d.completed && d.closePrice > 0 ? winnerOf(d.closePrice, d.openPrice) : null;
}

// ---------------------------------------------------------------------------
// Markets

async function findMarket(name, start) {
  const slug = SERIES[name].slug(start);
  const [event] = await getJson(`${GAMMA_EVENTS}?slug=${slug}`);
  const market = event?.markets?.[0];
  if (!market) return null;
  const outcomes = JSON.parse(market.outcomes);
  const tokens = JSON.parse(market.clobTokenIds);
  return { slug, tokens: Object.fromEntries(outcomes.map((o, i) => [o, tokens[i]])) };
}

export async function officialWinner(slug, fetchJson = getJson) {
  const [event] = await fetchJson(`${GAMMA_EVENTS}?slug=${slug}`);
  const market = event?.markets?.[0];
  if (market?.closed !== true) return null;
  const prices = JSON.parse(market.outcomePrices ?? '[]').map(Number);
  const outcomes = JSON.parse(market.outcomes ?? '[]');
  const i = prices.indexOf(1);
  return prices.length === 2 && outcomes.length === 2 && new Set(outcomes).size === 2
    && outcomes.every(o => o === 'Up' || o === 'Down') && i >= 0 && prices[1 - i] === 0 ? outcomes[i] : null;
}

const bestOf = (levels, pick) => (levels?.length ? pick(...levels.map((l) => Number(l.price))) : null);

// ---------------------------------------------------------------------------
// Trading loop

async function skip(base, reason) {
  await append({ ...base, type: 'skip', reason });
  log(`skip ${base.id}: ${reason}`);
}

async function enter(name, start) {
  const startedAt = Date.now();
  const base = { id: `${name}:${start}`, series: name, start, end: start + SERIES[name].sec, stake: STAKE };
  try {
    const [cur, market, ptb] = await Promise.all([currentPrice(name), findMarket(name, start), priceToBeat(name, start)]);
    if (!market) return skip(base, 'market not listed');
    if (ptb == null) return skip(base, 'price to beat unavailable');
    if (cur.price == null) return skip(base, `${cur.source} price stale (${cur.ageMs}ms)`);
    const side = directionOf(cur.price, ptb);
    if (!side) return skip(base, 'price exactly at price to beat');
    const other = side === 'Up' ? 'Down' : 'Up';
    const [ownBook, otherBook] = await Promise.all([
      getJson(`${CLOB_BOOK}?token_id=${market.tokens[side]}`),
      getJson(`${CLOB_BOOK}?token_id=${market.tokens[other]}`),
    ]);
    const fill = simulateMarketBuy(ownBook.asks ?? [], STAKE, MAX_PRICE);
    if (!fill.shares) return skip(base, `no asks at or below ${MAX_PRICE}`);
    const bet = {
      ...base,
      type: 'bet',
      slug: market.slug,
      side,
      priceToBeat: ptb,
      price: cur.price,
      priceSource: cur.source,
      moveBps: ((cur.price - ptb) / ptb) * 1e4,
      ...fill,
      ownBestBid: bestOf(ownBook.bids, Math.max),
      otherBestAsk: bestOf(otherBook.asks, Math.min),
      latencyMs: Date.now() - startedAt,
      enteredAt: Date.now() / 1000,
    };
    await append(bet);
    log(
      `bet ${bet.id} ${side} move ${bet.moveBps.toFixed(1)}bp: ${fill.shares.toFixed(2)} sh @ ${fill.avgPrice.toFixed(3)}` +
        ` (best ask ${fill.bestAsk}) fee $${fill.fee.toFixed(3)}${fill.filled ? '' : ' PARTIAL'}`,
    );
  } catch (err) {
    await skip(base, err.message);
  }
}

export async function settlementPass({ records = readLedger(), now = Date.now() / 1000,
  resolveOfficial = officialWinner, resolveProvisional = provisionalWinner, write = append, logResult = log } = {}) {
  const settled = new Set(records.filter((r) => r.type === 'settle' && r.official === true && validWinner(r.winner)).map((r) => r.id));
  const estimated = new Set(records.filter(isProvisional).map((r) => r.id));
  for (const bet of records.filter((r) => r.type === 'bet' && !settled.has(r.id) && now > r.end + 15)) {
    let winner = await resolveOfficial(bet.slug).catch(() => null);
    const official = validWinner(winner);
    if (!official) {
      if (estimated.has(bet.id) || now <= bet.end + OFFICIAL_WAIT_SEC) continue;
      winner = await resolveProvisional(bet).catch(() => null);
    }
    if (!validWinner(winner)) continue;
    const { payout, pnl } = settlePnl(bet, winner);
    await write({ type: official ? 'settle' : 'provisional_settle', id: bet.id, winner, official, payout, pnl, settledAt: now });
    (official ? settled : estimated).add(bet.id);
    logResult(`${official ? 'settle' : 'estimate'} ${bet.id}: ${winner}, bet ${bet.side}, pnl ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}${official ? '' : ' (unofficial; excluded from official performance)'}`);
  }
}

const validWinner = winner => winner === 'Up' || winner === 'Down';
const isProvisional = r => validWinner(r.winner) && r.official === false && ['settle', 'provisional_settle'].includes(r.type);

export function summarize(records) {
  const settles = new Map(records.filter((r) => r.type === 'settle' && r.official === true && validWinner(r.winner)).map((r) => [r.id, r]));
  const estimates = new Map(records.filter(isProvisional).map((r) => [r.id, r]));
  const provisionalRows = {};
  const rows = {};
  const add = (key, bet, s) => {
    const row = (rows[key] ??= { bets: 0, open: 0, settled: 0, wins: 0, notional: 0, fee: 0, pnl: 0, priceSum: 0 });
    row.bets++;
    if (!s) return void row.open++;
    row.settled++;
    row.wins += s.winner === bet.side ? 1 : 0;
    row.notional += bet.notional;
    row.fee += bet.fee;
    row.pnl += s.pnl;
    row.priceSum += bet.avgPrice;
  };
  for (const bet of records.filter((r) => r.type === 'bet')) {
    add(bet.series, bet, settles.get(bet.id));
    add('total', bet, settles.get(bet.id));
    if (!settles.has(bet.id) && estimates.has(bet.id)) {
      for (const key of [bet.series, 'total']) {
        const row = (provisionalRows[key] ??= { estimated: 0, pnl: 0 });
        row.estimated++;
        row.pnl += estimates.get(bet.id).pnl;
      }
    }
  }
  const skips = records.filter((r) => r.type === 'skip');
  return { rows, provisionalRows, skips: skips.length, missed: skips.filter((r) => r.reason.startsWith('missed')).length };
}

export function formatSummary({ rows, provisionalRows, skips, missed }) {
  const lines = ['OFFICIAL SETTLEMENT ONLY — Paper simulated fills, not Live returns',
    'open includes all bets awaiting official settlement, even when a price estimate exists',
    'series | bets | open | win rate | avg price | fees | pnl | ROI on notional'];
  for (const key of [...ENABLED, 'total']) {
    const r = rows[key];
    if (!r) continue;
    const pct = (x) => (r.settled ? `${(x * 100).toFixed(1)}%` : '—');
    lines.push(
      `${key} | ${r.bets} | ${r.open} | ${pct(r.wins / r.settled)} | ${r.settled ? (r.priceSum / r.settled).toFixed(3) : '—'}` +
        ` | ${r.settled ? '$' + r.fee.toFixed(2) : '—'} | ${r.settled ? '$' + r.pnl.toFixed(2) : '—'} | ${pct(r.pnl / r.notional)}`,
    );
  }
  lines.push('PROVISIONAL PRICE ESTIMATES ONLY — excluded from official counts, wins, PnL and ROI',
    'series | estimated awaiting official | estimated pnl');
  for (const key of [...ENABLED, 'total']) {
    const r = provisionalRows[key];
    if (r) lines.push(`${key} | ${r.estimated} | $${r.pnl.toFixed(2)}`);
  }
  lines.push(`skipped rounds: ${skips} (missed timing: ${missed})`);
  return lines.join('\n');
}

async function main() {
  await fs.mkdir(DIR, { recursive: true });
  const seen = new Set(readLedger().filter((r) => r.type === 'bet' || r.type === 'skip').map((r) => r.id));
  connectChainlink();
  log(`paper runner (no orders are sent): stake $${STAKE}, series ${ENABLED.join(',')}, max price ${MAX_PRICE}, ledger ${LEDGER}`);
  setInterval(() => settlementPass().catch((err) => log(`settlement error: ${err.message}`)), 30000);
  setInterval(() => log(`summary\n${formatSummary(summarize(readLedger()))}`), 30 * 60000);
  process.on('SIGTERM', () => {
    log('stopping');
    process.exit(0);
  });
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    if (!existsSync(STOP_FILE)) {
      for (const name of ENABLED) {
        const start = roundStart(now, SERIES[name].sec);
        const id = `${name}:${start}`;
        if (seen.has(id) || !isEtWeekend(start) || now - start < ENTRY_DELAY_SEC) continue;
        seen.add(id);
        const base = { id, series: name, start, end: start + SERIES[name].sec, stake: STAKE };
        const job = now - start > ENTRY_DELAY_SEC + ENTRY_GRACE_SEC ? skip(base, `missed entry (reached at +${now - start}s)`) : enter(name, start);
        job.catch((err) => log(`${id} failed: ${err.message}`));
      }
    }
    await sleep(250);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--status')) {
    console.log(formatSummary(summarize(readLedger())));
  } else {
    await main();
  }
}
