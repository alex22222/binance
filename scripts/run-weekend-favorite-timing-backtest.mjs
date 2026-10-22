#!/usr/bin/env node
// Weekend BTC Up/Down "buy the favorite" entry-timing backtest for the 15m and 1h series.
//
// Rule under test (the live Future BTC5m rule, moved to longer rounds): at entry offset T
// after the round opens, buy the side the market prices higher (the larger Future button)
// and hold to resolution. The question is which T works for 15m and 1h rounds.
//
// - Rounds: Polymarket rounds that open on US-Eastern Saturdays/Sundays, 2026-04-04..2026-10-04
//   (current crypto_fees_v2 schedule), resolution from the market itself.
// - Favorite at T: median implied Up price of the latest 5 taker buys in [T-60, T)
//   (approximates the Up/Down buttons a future.news user sees); exactly 0.5 is skipped.
// - Entry: taker-buy VWAP of that side in [T, T+20) (the live 5m rule uses a 20s window),
//   falling back to [T, T+60); no prints at all means no bet.
// - PnL per $1 stake: win / p - 1 - 0.07 * (1 - p) (taker fee 0.07 * p * (1 - p) per share).
//
// Every taker buy of every weekend round is cached once under
// artifacts/weekend-favorite-timing/, so any offset grid can be re-evaluated offline.
// Usage: NODE_USE_ENV_PROXY=1 node scripts/run-weekend-favorite-timing-backtest.mjs [--stage=fetch|report|all]

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FEE_RATE, SERIES, etParts, researchArtifactPath } from '../src/polymarket-updown.mjs';

const OUT = researchArtifactPath('weekend-favorite-timing');
const GAMMA_EVENTS = 'https://gamma-api.polymarket.com/events';
const DATA_TRADES = 'https://data-api.polymarket.com/trades';

const MARKET_START = Date.UTC(2026, 3, 4, 4); // Sat 2026-04-04 00:00 EDT
const MARKET_END = Date.UTC(2026, 9, 5, 4); // Mon 2026-10-05 00:00 EDT
const SPLIT = Date.UTC(2026, 6, 4, 4) / 1000; // first half: April-June, second half: July-October
const NAMES = ['1h', '15m'];
const OFFSETS = {
  '15m': [30, 60, 90, 120, 150, 180, 210, 240, 300, 360, 450, 540, 600, 660, 720, 780, 840],
  '1h': [60, 120, 300, 480, 600, 720, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3420],
};
const ENTRY_WINDOW = 20;
const FALLBACK_WINDOW = 60;
const LEAN_LOOKBACK = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_GAP_MS = 85; // Data API allows 200 /trades requests per 10s
let nextSlot = 0;
async function paced() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
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
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

const isWeekend = (sec) => ['Sat', 'Sun'].includes(etParts(sec).weekday);

function regimeOf(description = '') {
  if (/TWAP/.test(description)) return 'twap';
  if (/Chainlink/.test(description)) return 'chainlink';
  if (/Binance/.test(description)) return 'binance';
  return 'other';
}

// All taker trades of a market in [lo, hi] (absolute seconds). The endpoint caps a page at
// 1000 rows, so a full page is split in half until every slice is complete.
async function takerTrades(conditionId, lo, hi) {
  const rows = await getJson(`${DATA_TRADES}?market=${conditionId}&takerOnly=true&limit=1000&start=${lo}&end=${hi}`);
  if (rows.length < 1000 || hi <= lo) return rows;
  const mid = Math.floor((lo + hi) / 2);
  return [...(await takerTrades(conditionId, lo, mid)), ...(await takerTrades(conditionId, mid + 1, hi))];
}

async function fetchRounds() {
  await fs.mkdir(OUT, { recursive: true });
  for (const name of NAMES) {
    const series = SERIES[name];
    const file = path.join(OUT, `${name}.jsonl`);
    const done = new Set();
    if (existsSync(file)) {
      for (const line of (await fs.readFile(file, 'utf8')).split('\n')) if (line) done.add(JSON.parse(line).start);
    }
    const todo = [];
    for (let s = MARKET_START / 1000; s < MARKET_END / 1000; s += series.sec) if (isWeekend(s) && !done.has(s)) todo.push(s);
    // Interleave weekends so a partial download still covers the whole period.
    const pass = (s) => [0, 2, 1, 3][Math.floor(s / 86400) % 4];
    todo.sort((a, b) => pass(a) - pass(b) || a - b);
    console.log(`${name}: ${done.size} cached, ${todo.length} to fetch`);
    const batches = [];
    for (let i = 0; i < todo.length; i += 20) batches.push(todo.slice(i, i + 20));
    let written = 0;
    await pool(batches, 2, async (batch) => {
      try {
        const events = await getJson(`${GAMMA_EVENTS}?${batch.map((s) => `slug=${encodeURIComponent(series.slug(s))}`).join('&')}`);
        const bySlug = new Map(events.map((e) => [e.slug, e]));
        const lines = [];
        await pool(batch, 3, async (start) => {
          const event = bySlug.get(series.slug(start));
          const market = event?.markets?.[0];
          if (!market) {
            lines.push(JSON.stringify({ start, slug: series.slug(start), missing: true }));
            return;
          }
          const prices = JSON.parse(market.outcomePrices ?? '[]').map(Number);
          const winner = prices[0] === 1 ? 'Up' : prices[1] === 1 ? 'Down' : null;
          const trades = await takerTrades(market.conditionId, start, start + series.sec);
          // Compact: [seconds after open, 1 = Up / 0 = Down, price, shares], taker buys only.
          const buys = trades
            .filter((t) => t.side === 'BUY' && t.timestamp >= start && t.timestamp < start + series.sec)
            .map((t) => [t.timestamp - start, t.outcome === 'Up' ? 1 : 0, +t.price, +(+t.size).toFixed(2)])
            .sort((a, b) => a[0] - b[0]);
          lines.push(
            JSON.stringify({
              start,
              slug: event.slug,
              regime: regimeOf(market.description),
              feeType: market.feeType ?? null,
              winner,
              volume: Math.round(+market.volume || 0),
              nTaker: trades.length,
              buys,
            }),
          );
        });
        await fs.appendFile(file, lines.join('\n') + '\n');
        written += batch.length;
        if (written % 200 < 20) console.log(`${name}: ${written}/${todo.length}`);
      } catch (err) {
        console.warn(`${name}: batch at ${batch[0]} failed (${err.message}); rerun to resume`);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Analysis

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const stdev = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
const pnlPerDollar = (win, price, slip = 0) => {
  const p = Math.min(0.99, price + slip);
  return (win ? 1 / p : 0) - 1 - FEE_RATE * (1 - p);
};

function vwap(buys, up, lo, hi) {
  let notional = 0;
  let size = 0;
  for (const [t, u, p, s] of buys) {
    if (t < lo) continue;
    if (t >= hi) break;
    if (u !== up) continue;
    notional += p * s;
    size += s;
  }
  return size ? { price: notional / size, notional } : null;
}

function betAt(round, offset) {
  const before = [];
  for (const [t, u, p] of round.buys) {
    if (t >= offset) break;
    if (t >= offset - LEAN_LOOKBACK) before.push(u ? p : 1 - p);
  }
  if (!before.length) return { skip: 'noQuote' };
  const lean = median(before.slice(-5));
  if (lean === 0.5) return { skip: 'tied' };
  const dir = lean > 0.5 ? 'Up' : 'Down';
  const up = dir === 'Up' ? 1 : 0;
  let fill = vwap(round.buys, up, offset, offset + ENTRY_WINDOW);
  let fallback = false;
  if (!fill) {
    fill = vwap(round.buys, up, offset, offset + FALLBACK_WINDOW);
    fallback = true;
  }
  if (!fill) return { skip: 'noFill' };
  const win = round.winner === dir;
  return {
    start: round.start,
    regime: round.regime,
    dir,
    lean,
    price: fill.price,
    windowNotional: fallback ? 0 : fill.notional,
    fallback,
    win,
    pnl: pnlPerDollar(win, fill.price),
    pnlSlip1c: pnlPerDollar(win, fill.price, 0.01),
  };
}

function summarize(bets, rounds) {
  if (!bets.length) return { n: 0 };
  const pnl = bets.map((b) => b.pnl);
  const m = mean(pnl);
  const winRate = bets.filter((b) => b.win).length / bets.length;
  const avgPrice = mean(bets.map((b) => b.price));
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const b of bets) {
    equity += b.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return {
    n: bets.length,
    coverage: rounds ? bets.length / rounds : null,
    winRate,
    avgPrice,
    edge: winRate - avgPrice,
    feePct: mean(bets.map((b) => FEE_RATE * (1 - b.price))),
    roi: m,
    roiSlip1c: mean(bets.map((b) => b.pnlSlip1c)),
    t: m / (stdev(pnl) / Math.sqrt(pnl.length)),
    pnlPer1: equity,
    maxDdPer1: maxDd,
    fallbackShare: bets.filter((b) => b.fallback).length / bets.length,
    medWindowUsd: median(bets.filter((b) => !b.fallback).map((b) => b.windowNotional)),
  };
}

async function report() {
  const result = { generatedAt: new Date().toISOString(), sample: [MARKET_START, MARKET_END].map((ms) => new Date(ms).toISOString()), series: {} };
  for (const name of NAMES) {
    const file = path.join(OUT, `${name}.jsonl`);
    if (!existsSync(file)) continue;
    const all = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const rounds = all.filter((r) => !r.missing && r.winner).sort((a, b) => a.start - b.start);
    const halves = { first: rounds.filter((r) => r.start < SPLIT), second: rounds.filter((r) => r.start >= SPLIT) };
    const out = {
      coverage: { rounds: all.length, missing: all.filter((r) => r.missing).length, unresolved: all.filter((r) => !r.missing && !r.winner).length },
      upShare: rounds.filter((r) => r.winner === 'Up').length / rounds.length,
      offsets: {},
    };
    for (const offset of OFFSETS[name]) {
      const bets = [];
      const skips = {};
      for (const r of rounds) {
        const b = betAt(r, offset);
        if (b.skip) skips[b.skip] = (skips[b.skip] ?? 0) + 1;
        else bets.push(b);
      }
      const row = { all: summarize(bets, rounds.length), skips };
      for (const [half, rs] of Object.entries(halves)) {
        const set = new Set(rs.map((r) => r.start));
        row[half] = summarize(bets.filter((b) => set.has(b.start)), rs.length);
      }
      for (const regime of new Set(rounds.map((r) => r.regime))) row[`regime:${regime}`] = summarize(bets.filter((b) => b.regime === regime));
      // Calibration: does the favorite win more often than its price says?
      row.priceBuckets = {};
      for (const [lo, hi] of [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]]) {
        row.priceBuckets[`${lo.toFixed(1)}-${Math.min(hi, 1).toFixed(1)}`] = summarize(bets.filter((b) => b.price >= lo && b.price < hi));
      }
      out.offsets[offset] = row;
    }
    // Pick the offset on the first half only, then read it off the untouched second half.
    const ranked = OFFSETS[name].filter((o) => out.offsets[o].first.n >= 100).sort((a, b) => out.offsets[b].first.roi - out.offsets[a].first.roi);
    out.selection = { bestOnFirstHalf: ranked[0], firstHalf: out.offsets[ranked[0]]?.first, secondHalf: out.offsets[ranked[0]]?.second };
    result.series[name] = out;
  }
  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(result, null, 2));
  printReport(result);
}

const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const fmtT = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}` : `${s}s`);

function printReport(r) {
  for (const [name, s] of Object.entries(r.series)) {
    console.log(`\n# ${name} weekend rounds ${JSON.stringify(s.coverage)}, Up share ${pct(s.upShare)}`);
    console.log('entry | n | cover | win | price | edge | fee | ROI | ROI+1c | t | 1st half ROI (t) | 2nd half ROI (t) | med $ in 20s | fallback');
    for (const [offset, row] of Object.entries(s.offsets)) {
      const a = row.all;
      if (!a.n) continue;
      console.log(
        `+${fmtT(+offset)} | ${a.n} | ${pct(a.coverage, 0)} | ${pct(a.winRate)} | ${a.avgPrice.toFixed(3)} | ${pct(a.edge)} | ${pct(a.feePct, 2)} | ${pct(a.roi, 2)} | ${pct(a.roiSlip1c, 2)} | ${a.t.toFixed(2)} | ${pct(row.first.roi, 2)} (${row.first.t?.toFixed(2)}) | ${pct(row.second.roi, 2)} (${row.second.t?.toFixed(2)}) | $${a.medWindowUsd?.toFixed(0)} | ${pct(a.fallbackShare, 0)}`,
      );
    }
    console.log(`selection on first half: +${fmtT(s.selection.bestOnFirstHalf)} → 1st ${pct(s.selection.firstHalf?.roi, 2)}, 2nd ${pct(s.selection.secondHalf?.roi, 2)} (t ${s.selection.secondHalf?.t?.toFixed(2)})`);
    console.log('regimes / price buckets per entry:');
    for (const [offset, row] of Object.entries(s.offsets)) {
      const regimes = Object.entries(row).filter(([k]) => k.startsWith('regime:')).map(([k, v]) => `${k.slice(7)} ${v.n} ${pct(v.roi, 2)}`).join(', ');
      const buckets = Object.entries(row.priceBuckets).filter(([, v]) => v.n).map(([k, v]) => `${k}: ${v.n} win ${pct(v.winRate)} @${v.avgPrice.toFixed(3)} ${pct(v.roi, 1)}`).join(' | ');
      console.log(`  +${fmtT(+offset)} | ${regimes} | ${buckets}`);
    }
  }
}

const stage = process.argv.find((a) => a.startsWith('--stage='))?.split('=')[1] ?? 'all';
if (stage === 'fetch' || stage === 'all') await fetchRounds();
if (stage === 'report' || stage === 'all') await report();
