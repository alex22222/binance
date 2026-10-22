#!/usr/bin/env node
// Weekend BTC Up/Down momentum backtest (Polymarket rounds, as listed on future.news).
//
// Rule under test: on US-Eastern Saturdays and Sundays, 60 seconds after each round opens,
// buy the side BTC is already on (price now vs. round open) and hold to resolution.
//
// Two independent checks:
//   1. price-only: Binance BTCUSDT 1m candles over two years, weekend vs. weekday hit rate
//   2. market:     real Polymarket rounds, entry at the taker prices actually paid at +60..75s,
//                  taker fee 0.07 * p * (1 - p) per share, resolution from the market itself
//
// Everything is cached under artifacts/weekend-updown/ so reruns are cheap.
// Usage: NODE_USE_ENV_PROXY=1 node scripts/run-weekend-updown-backtest.mjs [--stage=klines|markets|report|all]

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FEE_RATE, SERIES, etParts, researchArtifactPath } from '../src/polymarket-updown.mjs';

const OUT = researchArtifactPath('weekend-updown');
const BINANCE_KLINES = 'https://data-api.binance.vision/api/v3/klines';
const GAMMA_EVENTS = 'https://gamma-api.polymarket.com/events';
const DATA_TRADES = 'https://data-api.polymarket.com/trades';

// Price-only sample: two full years ending at the last completed weekend.
const KLINE_START = Date.UTC(2024, 9, 5, 4);
const KLINE_END = Date.UTC(2026, 9, 5, 4);
// Market sample: current fee schedule (crypto_fees_v2) began in early April 2026.
const MARKET_START = Date.UTC(2026, 3, 4, 4); // Sat 2026-04-04 00:00 EDT
const MARKET_END = Date.UTC(2026, 9, 5, 4); // Mon 2026-10-05 00:00 EDT

const ENTRY_SEC = 60;
const ENTRY_WINDOW = [60, 75];
const FALLBACK_WINDOW = [60, 120];

function dayType(sec) {
  const weekday = etParts(sec).weekday;
  if (weekday === 'Sat' || weekday === 'Sun') return 'weekend';
  return weekday === 'Wed' ? 'wednesday' : 'weekday';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Global pacing: Polymarket allows 200 /trades requests per 10s; stay well under it.
const MIN_GAP_MS = 85;
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

// ---------------------------------------------------------------------------
// Stage 1: Binance 1m candles

function monthKeys(startMs, endMs) {
  const keys = [];
  const d = new Date(Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1));
  while (d.getTime() < endMs) {
    keys.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return keys;
}

async function fetchKlines() {
  const dir = path.join(OUT, 'klines');
  await fs.mkdir(dir, { recursive: true });
  for (const key of monthKeys(KLINE_START, KLINE_END)) {
    const file = path.join(dir, `${key}.json`);
    const [y, m] = key.split('-').map(Number);
    const from = Math.max(Date.UTC(y, m - 1, 1), KLINE_START - 86400000);
    const to = Math.min(Date.UTC(y, m, 1), KLINE_END + 86400000);
    if (existsSync(file)) continue;
    const rows = [];
    for (let t = from; t < to; ) {
      const batch = await getJson(`${BINANCE_KLINES}?symbol=BTCUSDT&interval=1m&startTime=${t}&endTime=${to - 1}&limit=1000`);
      if (!batch.length) break;
      for (const k of batch) rows.push([k[0] / 1000, +k[1], +k[2], +k[3], +k[4]]);
      t = batch.at(-1)[0] + 60000;
    }
    await fs.writeFile(file, JSON.stringify(rows));
    console.log(`klines ${key}: ${rows.length}`);
  }
}

async function loadKlines() {
  const bySec = new Map();
  for (const key of monthKeys(KLINE_START, KLINE_END)) {
    const file = path.join(OUT, 'klines', `${key}.json`);
    if (!existsSync(file)) continue;
    for (const row of JSON.parse(await fs.readFile(file, 'utf8'))) bySec.set(row[0], row);
  }
  return bySec;
}

// ---------------------------------------------------------------------------
// Stage 2: Polymarket rounds + taker trades around the entry

function roundStarts(seriesSec, includeControl) {
  const starts = [];
  for (let s = MARKET_START / 1000; s < MARKET_END / 1000; s += seriesSec) {
    const type = dayType(s);
    if (type === 'weekend' || (includeControl && type === 'wednesday')) starts.push(s);
  }
  return starts;
}

const FILL_WINDOWS = [[60, 70], [60, 75], [60, 90], [60, 120]];

function vwapOf(trades, side, [lo, hi]) {
  const fills = trades.filter((t) => t[1] === side && t[2] === 'BUY' && t[0] >= lo && t[0] < hi).sort((a, b) => a[0] - b[0]);
  if (!fills.length) return null;
  const notional = fills.reduce((a, t) => a + t[3] * t[4], 0);
  const size = fills.reduce((a, t) => a + t[4], 0);
  return [+(notional / size).toFixed(4), fills[0][3], fills.length, +notional.toFixed(2)];
}

// Keep only what the analysis needs: the market's lean just before +60s (implied Up price
// of the latest taker buys, newest first) and taker-buy VWAPs per side for each entry window.
function summarizeTrades(trades) {
  const lean = trades
    .filter((t) => t[0] >= 30 && t[0] < ENTRY_SEC && t[2] === 'BUY')
    .sort((a, b) => b[0] - a[0])
    .slice(0, 8)
    .map((t) => +(t[1] === 'Up' ? t[3] : 1 - t[3]).toFixed(4));
  const fills = {};
  for (const side of ['Up', 'Down']) {
    fills[side] = Object.fromEntries(FILL_WINDOWS.map((w) => [w.join('-'), vwapOf(trades, side, w)]));
  }
  return { nTrades: trades.length, lean, fills };
}

function regimeOf(description = '') {
  if (/TWAP/.test(description)) return 'twap';
  if (/Chainlink/.test(description)) return 'chainlink';
  if (/Binance/.test(description)) return 'binance';
  return 'other';
}

async function fetchMarkets() {
  const dir = path.join(OUT, 'markets');
  await fs.mkdir(dir, { recursive: true });
  // Smallest series first; within a series, interleaved passes (every 4th round, then the
  // rounds in between) so a partial download is still spread evenly over the period.
  for (const name of ['4h', '1h', '15m', '5m']) {
    const series = SERIES[name];
    const file = path.join(dir, `${name}.jsonl`);
    const done = new Set();
    if (existsSync(file)) {
      for (const line of (await fs.readFile(file, 'utf8')).split('\n')) if (line) done.add(JSON.parse(line).start);
    }
    const pass = (s) => [0, 2, 1, 3][(s / series.sec) % 4];
    const todo = roundStarts(series.sec, true)
      .filter((s) => !done.has(s))
      .sort((a, b) => pass(a) - pass(b) || a - b);
    console.log(`${name}: ${done.size} cached, ${todo.length} to fetch`);
    const batches = [];
    for (let i = 0; i < todo.length; i += 20) batches.push(todo.slice(i, i + 20));
    let written = 0;
    await pool(batches, 3, async (batch) => {
      try {
        const slugs = batch.map(series.slug);
        const events = await getJson(`${GAMMA_EVENTS}?${slugs.map((s) => `slug=${encodeURIComponent(s)}`).join('&')}`);
        const bySlug = new Map(events.map((e) => [e.slug, e]));
        const lines = [];
        await pool(batch, 4, async (start) => {
          const event = bySlug.get(series.slug(start));
          const market = event?.markets?.[0];
          if (!market) {
            lines.push(JSON.stringify({ start, slug: series.slug(start), missing: true }));
            return;
          }
          const prices = JSON.parse(market.outcomePrices ?? '[]').map(Number);
          const winner = prices[0] === 1 ? 'Up' : prices[1] === 1 ? 'Down' : null;
          const trades = await getJson(
            `${DATA_TRADES}?market=${market.conditionId}&takerOnly=true&limit=1000&start=${start + 30}&end=${start + 130}`,
          );
          lines.push(
            JSON.stringify({
              start,
              slug: event.slug,
              regime: regimeOf(market.description),
              feeType: market.feeType ?? null,
              winner,
              volume: +market.volume || 0,
              ...summarizeTrades(trades.map((t) => [t.timestamp - start, t.outcome, t.side, +t.price, +t.size])),
            }),
          );
        });
        await fs.appendFile(file, lines.join('\n') + '\n');
        written += batch.length;
        if (written % 400 < 20) console.log(`${name}: ${written}/${todo.length}`);
      } catch (err) {
        console.warn(`${name}: batch at ${batch[0]} failed (${err.message}); rerun to resume`);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Analysis helpers

const MOVE_BUCKETS = [0, 1, 3, 6, 10, 20, Infinity]; // |first-minute move| in bps

function bucketOf(absBps) {
  for (let i = 0; i < MOVE_BUCKETS.length - 1; i++) {
    if (absBps < MOVE_BUCKETS[i + 1]) return `${MOVE_BUCKETS[i]}-${MOVE_BUCKETS[i + 1]}`;
  }
  return 'n/a';
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const stdev = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

// Brownian-motion benchmark: P(sign of path at t matches sign of the settlement value).
function brownianHitRate(seriesSec, twap) {
  const tau = ENTRY_SEC / seriesSec;
  if (!twap) return 0.5 + Math.asin(Math.sqrt(tau)) / Math.PI;
  // Reference = mean of W over [-c, 0], settlement = mean over [1-c, 1], signal = W(t) - reference,
  // with c = 60s in round units. The reference noise B has Var c/3 and is shared by both sides.
  const c = 60 / seriesSec;
  const a = 1 - c;
  const varRef = c / 3;
  const varEnd = (1 + 2 * a) / 3; // Var of mean of W over [a, 1]
  const cov = tau + varRef; // tau <= a, so Cov(W(tau), end mean) = tau
  const rho = cov / Math.sqrt((tau + varRef) * (varEnd + varRef));
  return 0.5 + Math.asin(Math.min(1, rho)) / Math.PI;
}

function priceOnlyRounds(klines) {
  const rows = [];
  for (const [name, series] of Object.entries(SERIES)) {
    for (let s = KLINE_START / 1000; s < KLINE_END / 1000; s += series.sec) {
      const prev = klines.get(s - 60);
      const first = klines.get(s);
      const last = klines.get(s + series.sec - 60);
      if (!prev || !first || !last) continue;
      const ohlc4 = (k) => (k[1] + k[2] + k[3] + k[4]) / 4;
      // Spot regime (Binance hourly, pre-August Chainlink): open spot vs close spot.
      const open = first[1];
      const at60 = first[4];
      if (at60 === open) continue;
      const finalClose = last[4];
      const dir = at60 > open ? 'Up' : 'Down';
      const winClose = (finalClose >= open ? 'Up' : 'Down') === dir;
      // TWAP regime: price to beat is the 60s TWAP at the start (≈ previous minute's mean),
      // settlement is the 60s TWAP at the end (≈ last minute's mean).
      const ref = ohlc4(prev);
      const twapDir = at60 >= ref ? 'Up' : 'Down';
      const winTwap = (ohlc4(last) >= ref ? 'Up' : 'Down') === twapDir;
      rows.push({
        series: name,
        start: s,
        type: dayType(s) === 'weekend' ? 'weekend' : 'weekday',
        period: s < Date.UTC(2025, 9, 5, 4) / 1000 ? '2024-10~2025-10' : '2025-10~2026-10',
        moveBps: ((at60 - open) / open) * 1e4,
        twapMoveBps: ((at60 - ref) / ref) * 1e4,
        roundBps: ((finalClose - open) / open) * 1e4,
        winClose,
        winTwap,
      });
    }
  }
  return rows;
}

function summarizeHits(rows, key) {
  const hits = rows.filter((r) => r[key]).length;
  const rate = rows.length ? hits / rows.length : null;
  return { n: rows.length, rate, se: rate == null ? null : Math.sqrt((rate * (1 - rate)) / rows.length) };
}

function pnlPerDollar(win, price, slip = 0) {
  const p = Math.min(0.99, price + slip);
  return (win ? 1 / p : 0) - 1 - FEE_RATE * (1 - p);
}

function marketBets(markets, klines, binanceForDirection) {
  const bets = [];
  for (const m of markets) {
    // Direction at +60s. Default: the side the market itself leans to in the latest taker
    // prints before +60s (what a future.news user sees); optionally Binance spot.
    let dir = null;
    let moveBps = null;
    const k = klines?.get(m.start);
    const prev = klines?.get(m.start - 60);
    if (k && prev) {
      // Same reference the round settles against: TWAP rounds use the 60s TWAP at the start.
      const ref = m.regime === 'twap' ? (prev[1] + prev[2] + prev[3] + prev[4]) / 4 : k[1];
      moveBps = ((k[4] - ref) / ref) * 1e4;
    }
    if (binanceForDirection) {
      if (moveBps) dir = moveBps > 0 ? 'Up' : 'Down';
    } else {
      const upPrice = median(m.lean.slice(0, 5));
      if (upPrice != null && upPrice !== 0.5) dir = upPrice > 0.5 ? 'Up' : 'Down';
    }
    if (!dir) continue;
    let entry = m.fills[dir][ENTRY_WINDOW.join('-')];
    let fallback = false;
    if (!entry) {
      entry = m.fills[dir][FALLBACK_WINDOW.join('-')];
      fallback = true;
    }
    if (!entry) continue;
    const [price, firstPrice] = entry;
    const win = m.winner === dir;
    bets.push({
      series: m.series,
      start: m.start,
      type: dayType(m.start) === 'weekend' ? 'weekend' : 'wednesday',
      regime: m.regime,
      dir,
      moveBps,
      price,
      firstPrice,
      windowNotional: m.fills[dir][ENTRY_WINDOW.join('-')]?.[3] ?? 0,
      early: m.fills[dir]['60-70']?.[0] ?? null,
      late: m.fills[dir]['60-90']?.[0] ?? null,
      fallback,
      win,
      pnl: pnlPerDollar(win, price),
      pnlSlip1c: pnlPerDollar(win, price, 0.01),
    });
  }
  return bets;
}

function summarizeBets(bets) {
  if (!bets.length) return { n: 0 };
  const pnl = bets.map((b) => b.pnl);
  const winRate = bets.filter((b) => b.win).length / bets.length;
  const avgPrice = mean(bets.map((b) => b.price));
  const avgFee = mean(bets.map((b) => FEE_RATE * (1 - b.price)));
  // Equity curve at a flat $10 per bet, in time order.
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const b of [...bets].sort((a, c) => a.start - c.start)) {
    equity += 10 * b.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const m = mean(pnl);
  return {
    n: bets.length,
    winRate,
    avgPrice,
    edgeVsPrice: winRate - avgPrice,
    avgFeePct: avgFee,
    roi: m,
    roiSlip1c: mean(bets.map((b) => b.pnlSlip1c)),
    tStat: m / (stdev(pnl) / Math.sqrt(pnl.length)),
    pnlAt10: equity,
    maxDdAt10: maxDd,
    fallbackShare: bets.filter((b) => b.fallback).length / bets.length,
    medianWindowNotional: median(bets.map((b) => b.windowNotional)),
  };
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}

// Out-of-sample filter: P(win | series, regime, day type, |first-minute move|) estimated on
// Binance rounds before the market sample, then bet only when that fair value beats the
// actual entry price after fees.
function modelFilter(priceRows, bets) {
  const fair = new Map();
  const calib = priceRows.filter((r) => r.start < MARKET_START / 1000);
  for (const kind of ['spot', 'twap']) {
    const groups = groupBy(calib, (r) => {
      const move = kind === 'twap' ? r.twapMoveBps : r.moveBps;
      return `${r.series}|${kind}|${r.type}|${bucketOf(Math.abs(move))}`;
    });
    for (const [key, rows] of groups) {
      const hits = rows.filter((r) => (kind === 'twap' ? r.winTwap : r.winClose)).length;
      fair.set(key, { p: (hits + 1) / (rows.length + 2), n: rows.length });
    }
  }
  const scored = [];
  for (const b of bets) {
    if (b.moveBps == null) continue;
    const kind = b.regime === 'twap' ? 'twap' : 'spot';
    const type = b.type === 'weekend' ? 'weekend' : 'weekday';
    const f = fair.get(`${b.series}|${kind}|${type}|${bucketOf(Math.abs(b.moveBps))}`);
    if (!f) continue;
    scored.push({ ...b, fair: f.p, evEst: f.p / b.price - 1 - FEE_RATE * (1 - b.price) });
  }
  const out = { calibrationRounds: calib.length };
  for (const [threshold, label] of [[-Infinity, 'all'], [0, 'ev>0'], [0.03, 'ev>3%'], [0.06, 'ev>6%']]) {
    for (const [key, rows] of groupBy(scored.filter((b) => b.evEst > threshold), (b) => `${b.series}|${b.type}|${label}`)) {
      out[key] = { ...summarizeBets(rows), avgFair: mean(rows.map((b) => b.fair)) };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 3: report

async function report() {
  const klines = await loadKlines();
  const priceRows = priceOnlyRounds(klines);
  const result = { generatedAt: new Date().toISOString(), priceOnly: {}, market: {} };

  for (const [key, rows] of groupBy(priceRows, (r) => `${r.series}|${r.type}|${r.period}`)) {
    result.priceOnly[key] = {
      close: summarizeHits(rows, 'winClose'),
      twapApprox: summarizeHits(rows, 'winTwap'),
      medianAbsFirstMinBps: median(rows.map((r) => Math.abs(r.moveBps))),
      medianAbsRoundBps: median(rows.map((r) => Math.abs(r.roundBps))),
    };
  }
  for (const [key, rows] of groupBy(priceRows, (r) => `${r.series}|${r.type}|all`)) {
    result.priceOnly[key] = {
      close: summarizeHits(rows, 'winClose'),
      twapApprox: summarizeHits(rows, 'winTwap'),
      medianAbsFirstMinBps: median(rows.map((r) => Math.abs(r.moveBps))),
      medianAbsRoundBps: median(rows.map((r) => Math.abs(r.roundBps))),
    };
  }
  result.priceOnlyBuckets = {};
  for (const [key, rows] of groupBy(priceRows.filter((r) => r.type === 'weekend'), (r) => `${r.series}|${bucketOf(Math.abs(r.moveBps))}`)) {
    result.priceOnlyBuckets[key] = { close: summarizeHits(rows, 'winClose'), twapApprox: summarizeHits(rows, 'winTwap') };
  }
  result.brownian = Object.fromEntries(
    Object.entries(SERIES).map(([name, s]) => [name, { close: brownianHitRate(s.sec, false), twap60: brownianHitRate(s.sec, true) }]),
  );

  const allMarkets = [];
  for (const name of Object.keys(SERIES)) {
    const file = path.join(OUT, 'markets', `${name}.jsonl`);
    if (!existsSync(file)) continue;
    const rows = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    result.market[`${name}|coverage`] = {
      rounds: rows.length,
      missing: rows.filter((r) => r.missing).length,
      unresolved: rows.filter((r) => !r.missing && !r.winner).length,
      noTrades: rows.filter((r) => !r.missing && r.winner && !r.nTrades).length,
    };
    allMarkets.push(...rows.filter((r) => !r.missing && r.winner).map((r) => ({ ...r, series: name })));
  }
  for (const [label, useBinance] of [['marketLean', false], ['binanceSign', true]]) {
    const bets = marketBets(allMarkets, klines, useBinance);
    result.market[label] = {};
    for (const [key, rows] of groupBy(bets, (b) => `${b.series}|${b.type}|${b.regime}`)) result.market[label][key] = summarizeBets(rows);
    for (const [key, rows] of groupBy(bets, (b) => `${b.series}|${b.type}|all`)) result.market[label][key] = summarizeBets(rows);
    if (label === 'marketLean') {
      result.market.priceBuckets = {};
      const priceBucket = (p) => `${Math.floor(p * 20) * 5}-${Math.floor(p * 20) * 5 + 5}c`;
      for (const [key, rows] of groupBy(bets.filter((b) => b.type === 'weekend'), (b) => `${b.series}|${priceBucket(b.price)}`)) {
        result.market.priceBuckets[key] = summarizeBets(rows);
      }
      result.market.weekly = {};
      // Saturday's ET date; the whole market sample is in EDT (UTC-4).
      const weekOf = (b) => {
        const sat = etParts(b.start).weekday === 'Sun' ? b.start - 86400 : b.start;
        return new Date((sat - 4 * 3600) * 1000).toISOString().slice(0, 10);
      };
      for (const [key, rows] of groupBy(bets.filter((b) => b.type === 'weekend'), (b) => `${b.series}|${weekOf(b)}`)) {
        const s = summarizeBets(rows);
        result.market.weekly[key] = { n: s.n, winRate: s.winRate, avgPrice: s.avgPrice, roi: s.roi, pnlAt10: s.pnlAt10 };
      }
      result.market.entryTiming = {};
      for (const [key, rows] of groupBy(bets, (b) => `${b.series}|${b.type}`)) {
        const timing = {};
        for (const field of ['early', 'price', 'late']) {
          const xs = rows.filter((b) => b[field] != null);
          timing[field] = { n: xs.length, avgPrice: mean(xs.map((b) => b[field])), roi: mean(xs.map((b) => pnlPerDollar(b.win, b[field]))) };
        }
        result.market.entryTiming[key] = timing;
      }
      await fs.writeFile(path.join(OUT, 'bets.json'), JSON.stringify(bets));
    }
    if (label === 'binanceSign') {
      result.market.modelFilter = modelFilter(priceRows, bets);
      await fs.writeFile(path.join(OUT, 'bets-binance-sign.json'), JSON.stringify(bets));
    }
  }
  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(result, null, 2));
  printReport(result);
}

const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);

function printReport(r) {
  console.log('\n# Price-only (Binance 1m), hit rate of the +60s sign');
  console.log('series | type | period | n | close | twap≈ | med|1m| bps | med|round| bps');
  for (const [k, v] of Object.entries(r.priceOnly).sort()) {
    const [s, t, p] = k.split('|');
    console.log(`${s} | ${t} | ${p} | ${v.close.n} | ${pct(v.close.rate)} | ${pct(v.twapApprox.rate)} | ${v.medianAbsFirstMinBps?.toFixed(1)} | ${v.medianAbsRoundBps?.toFixed(1)}`);
  }
  console.log('\nBrownian benchmark', JSON.stringify(r.brownian));
  console.log('\n# Weekend price-only by |first-minute move|');
  for (const [k, v] of Object.entries(r.priceOnlyBuckets).sort()) console.log(`${k} | n=${v.close.n} | close ${pct(v.close.rate)} | twap≈ ${pct(v.twapApprox.rate)}`);
  for (const label of ['marketLean', 'binanceSign']) {
    console.log(`\n# Market (${label}) series | type | regime | n | win | avg price | edge | fee | ROI | ROI+1c | t | PnL@$10 | maxDD | fallback | med taker $ in window`);
    for (const [k, v] of Object.entries(r.market[label]).sort()) {
      if (!v.n) continue;
      console.log(
        `${k} | ${v.n} | ${pct(v.winRate)} | ${v.avgPrice.toFixed(3)} | ${pct(v.edgeVsPrice)} | ${pct(v.avgFeePct, 2)} | ${pct(v.roi, 2)} | ${pct(v.roiSlip1c, 2)} | ${v.tStat.toFixed(2)} | ${v.pnlAt10.toFixed(0)} | ${v.maxDdAt10.toFixed(0)} | ${pct(v.fallbackShare)} | $${v.medianWindowNotional?.toFixed(0)}`,
      );
    }
  }
  console.log('\n# Model filter (fair value from pre-2026-04 Binance rounds) series | type | filter | n | win | fair | price | ROI | ROI+1c | t | PnL@$10');
  for (const [k, v] of Object.entries(r.market.modelFilter ?? {}).sort()) {
    if (!v?.n) continue;
    console.log(`${k} | ${v.n} | ${pct(v.winRate)} | ${pct(v.avgFair)} | ${v.avgPrice.toFixed(3)} | ${pct(v.roi, 2)} | ${pct(v.roiSlip1c, 2)} | ${v.tStat.toFixed(2)} | ${v.pnlAt10.toFixed(0)}`);
  }
  console.log('\n# Entry timing (60-70s / 60-75s / 60-90s taker VWAP): n, avg price, ROI');
  for (const [k, v] of Object.entries(r.market.entryTiming ?? {}).sort()) {
    console.log(`${k} | ${['early', 'price', 'late'].map((f) => `${v[f].n} ${v[f].avgPrice?.toFixed(3)} ${pct(v[f].roi, 2)}`).join(' | ')}`);
  }
  console.log('\n# Weekend market by entry price');
  for (const [k, v] of Object.entries(r.market.priceBuckets ?? {}).sort()) console.log(`${k} | n=${v.n} | win ${pct(v.winRate)} | avg ${v.avgPrice.toFixed(3)} | ROI ${pct(v.roi, 2)}`);
  for (const [k, v] of Object.entries(r.market).filter(([k]) => k.endsWith('|coverage'))) console.log(k, JSON.stringify(v));
}

const stage = process.argv.find((a) => a.startsWith('--stage='))?.split('=')[1] ?? 'all';
if (stage === 'klines' || stage === 'all') await fetchKlines();
if (stage === 'markets' || stage === 'all') await fetchMarkets();
if (stage === 'report' || stage === 'all') await report();
