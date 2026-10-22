#!/usr/bin/env node
// BTC daily Up/Down ("Bitcoin Up or Down on <date>?") research: is any rule positive after fees?
//
// The market compares the Binance BTCUSDT 1m candle close at 12:00 ET on day D with the one at
// 12:00 ET on day D-1 (higher = Up; equal = 50-50). Taker fee 0.07 * p * (1 - p) per share, Future +1%.
//
// Approaches:
//   E. price-only effects on 2019-2026 Binance 1h candles (weekday, previous day, streaks)
//   A. buy the market favorite at a fixed hour
//   B. high-price favorite bands
//   C. price-model edge (z = ln(P_T/P_0) / (sigma_1h * sqrt(hours left)), fitted on 2019-01..2026-03)
//   D. cheap underdogs (longshot test)
//   F. price-only signals traded at the real market price around the window open
// Market rules are tuned on April-June 2026 and judged on July-October 2026; one bet per day.
//
// Cache: artifacts/1d-research/. Usage: NODE_USE_ENV_PROXY=1 node scripts/run-1d-updown-research.mjs [--stage=fetch|report|all]

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { researchArtifactPath } from '../src/polymarket-updown.mjs';

const OUT = researchArtifactPath('1d-research');
const GAMMA_EVENTS = 'https://gamma-api.polymarket.com/events';
const DATA_TRADES = 'https://data-api.polymarket.com/trades';
const BINANCE_KLINES = 'https://data-api.binance.vision/api/v3/klines';
const FEE = 0.07;
const FUTURE = 0.01;
const KLINE_START = Date.UTC(2019, 0, 1);
const MODEL_END = Date.UTC(2026, 3, 1) / 1000;
const MARKET_FIRST = Date.UTC(2026, 3, 5); // first resolution day in the crypto_fees_v2 sample
const SPLIT = Date.UTC(2026, 6, 1) / 1000;
const NOW = Math.floor(Date.now() / 1000);
const HOURS = Array.from({ length: 23 }, (_, i) => i + 1);
const LOOKBACK = 600;
const FILL = 120;
const FILL_FALLBACK = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;
async function getJson(url, tries = 8) {
  for (let attempt = 0; ; attempt++) {
    try {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + 85;
      if (wait) await sleep(wait);
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

// Noon ET of a UTC calendar date (EDT 16:00 UTC, EST 17:00 UTC).
function noonEt(y, m, d) {
  const guess = Date.UTC(y, m, d, 16) / 1000;
  const hour = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(guess * 1000);
  return hour === 12 ? guess : guess + 3600;
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const slugOf = (date) => `bitcoin-up-or-down-on-${MONTHS[date.getUTCMonth()]}-${date.getUTCDate()}-${date.getUTCFullYear()}`;
const weekdayEt = (sec) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(sec * 1000);

// ---------------------------------------------------------------------------
// Fetch

async function takerTrades(conditionId, lo, hi) {
  const rows = await getJson(`${DATA_TRADES}?market=${conditionId}&takerOnly=true&limit=1000&start=${lo}&end=${hi}`);
  if (rows.length < 1000 || hi <= lo) return rows;
  const mid = Math.floor((lo + hi) / 2);
  return [...(await takerTrades(conditionId, lo, mid)), ...(await takerTrades(conditionId, mid + 1, hi))];
}

async function fetchDays() {
  await fs.mkdir(OUT, { recursive: true });
  const file = path.join(OUT, 'days.jsonl');
  const done = new Set();
  if (existsSync(file)) for (const line of (await fs.readFile(file, 'utf8')).split('\n')) if (line) done.add(JSON.parse(line).end);
  const todo = [];
  for (let t = MARKET_FIRST; ; t += 86400000) {
    const date = new Date(t);
    const end = noonEt(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    if (end > NOW - 600) break;
    if (!done.has(end)) todo.push({ date, end });
  }
  console.log(`days: ${done.size} cached, ${todo.length} to fetch`);
  for (const { date, end } of todo) {
    try {
      const event = (await getJson(`${GAMMA_EVENTS}?slug=${slugOf(date)}`))[0];
      const market = event?.markets?.[0];
      if (!market) { await fs.appendFile(file, JSON.stringify({ end, slug: slugOf(date), missing: true }) + '\n'); continue; }
      const start = noonEt(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - 1);
      const prices = JSON.parse(market.outcomePrices ?? '[]').map(Number);
      const winner = prices[0] === 1 ? 'Up' : prices[1] === 1 ? 'Down' : prices[0] === 0.5 ? 'Tie' : null;
      const trades = await takerTrades(market.conditionId, start - 3 * 86400, end);
      // [seconds after window start (negative = before the window), 1 = Up / 0 = Down, price, shares]
      const buys = trades.filter((t) => t.side === 'BUY' && t.timestamp < end)
        .map((t) => [t.timestamp - start, t.outcome === 'Up' ? 1 : 0, +t.price, +(+t.size).toFixed(2)])
        .sort((a, b) => a[0] - b[0]);
      await fs.appendFile(file, JSON.stringify({ start, end, slug: slugOf(date), winner, volume: Math.round(+market.volume || 0),
        fee: market.feeSchedule ?? null, listed: market.startDate, nTaker: trades.length, buys }) + '\n');
      console.log(`${slugOf(date)}: ${winner}, ${buys.length} taker buys`);
    } catch (err) {
      console.warn(`${slugOf(date)} failed (${err.message}); rerun to resume`);
    }
  }
}

async function fetchKlines() {
  await fs.mkdir(OUT, { recursive: true });
  const file = path.join(OUT, 'klines-1h.json');
  let rows = existsSync(file) ? JSON.parse(await fs.readFile(file, 'utf8')) : [];
  let t = rows.length ? (rows.at(-1)[0] + 3600) * 1000 : KLINE_START;
  while (t < NOW * 1000) {
    const batch = await getJson(`${BINANCE_KLINES}?symbol=BTCUSDT&interval=1h&startTime=${t}&limit=1000`);
    if (!batch.length) break;
    for (const k of batch) rows.push([k[0] / 1000, +k[1], +k[2], +k[3], +k[4]]);
    t = batch.at(-1)[0] + 3600000;
  }
  rows = rows.filter((r) => r[0] + 3600 <= NOW); // completed candles only
  await fs.writeFile(file, JSON.stringify(rows));
  console.log(`klines 1h: ${rows.length}`);
}

// ---------------------------------------------------------------------------
// Helpers

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const pnl = (win, price) => { const p = Math.min(0.99, price); return (win ? 1 / p : 0) - 1 - FEE * (1 - p) - FUTURE; };
const pct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%` : '—');
function fitLogistic(rows) {
  let a = 0, b = 1;
  for (let it = 0; it < 50; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const [z, y] of rows) {
      const p = 1 / (1 + Math.exp(-(a + b * z)));
      const w = p * (1 - p);
      ga += y - p; gb += (y - p) * z; haa += w; hab += w * z; hbb += w * z * z;
    }
    const det = haa * hbb - hab * hab;
    if (!det) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b };
}
const prob = (f, z) => 1 / (1 + Math.exp(-(f.a + f.b * Math.max(-12, Math.min(12, z)))));
const tStat = (xs) => mean(xs) / (sd(xs) / Math.sqrt(xs.length));

function summarize(bets) {
  const r = bets.map((b) => b.pnl);
  const h1 = bets.filter((b) => b.start < SPLIT), h2 = bets.filter((b) => b.start >= SPLIT);
  return { n: bets.length, win: mean(bets.map((b) => (b.win ? 1 : 0))), price: mean(bets.map((b) => b.price)), ev: mean(r),
    t: bets.length > 2 ? tStat(r) : NaN, first: mean(h1.map((b) => b.pnl)), second: mean(h2.map((b) => b.pnl)), nFirst: h1.length, nSecond: h2.length };
}
const HEAD = '| 规则 | 注数 | 胜率 | 平均买价 | 胜率−买价 | 每注收益 | t | 4–6 月 | 7–10 月 |\n|---|---|---|---|---|---|---|---|---|';
const row = (label, s) => `| ${label} | ${s.n} | ${pct(s.win)} | ${s.price?.toFixed(3)} | ${signed(s.win - s.price)} | ${signed(s.ev)} | ${s.t?.toFixed(2)} | ${signed(s.first)} (${s.nFirst}) | ${signed(s.second)} (${s.nSecond}) |`;

// ---------------------------------------------------------------------------
// Report

async function report() {
  const lines = [];
  const out = (s = '') => { lines.push(s); console.log(s); };
  const kl = JSON.parse(await fs.readFile(path.join(OUT, 'klines-1h.json'), 'utf8'));
  const bySec = new Map(kl.map((k) => [k[0], k]));

  // Daily windows over the whole kline history: price at noon ET = open of the noon hour candle.
  const windows = [];
  for (let t = KLINE_START + 2 * 86400000; t < NOW * 1000; t += 86400000) {
    const d = new Date(t);
    const end = noonEt(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const start = noonEt(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1);
    const hours = (end - start) / 3600;
    const path_ = [];
    for (let h = -24; h <= hours; h++) path_.push(bySec.get(start + h * 3600));
    if (path_.some((c) => !c)) continue;
    const open = path_[24][1];
    const close = path_[24 + hours][1];
    windows.push({ start, end, hours, open, close, up: close > open ? 1 : close < open ? 0 : null, path: path_, weekday: weekdayEt(end) });
  }
  windows.forEach((w, i) => { w.prev = windows[i - 1]?.end === w.start ? windows[i - 1] : null; });

  out(`# BTC 日线 Up/Down 研究\n\n生成时间 ${new Date().toISOString()}。Binance 1h K 线 ${new Date(KLINE_START).toISOString().slice(0, 10)} 起，日窗口 ${windows.length} 个。\n`);

  // E. Price-only effects. Break-even at a 0.50 entry with fees: win rate > (1 + 0.035 + 0.01) / 2 = 52.25%.
  out('## E. 纯价格效应（2019 至今，Binance；0.50 买入的盈亏平衡胜率约 52.3%）\n\n| 条件 | 天数 | 收涨比例 | 2019–2022 | 2023–2026 |\n|---|---|---|---|---|');
  const cut = Date.UTC(2023, 0, 1) / 1000;
  const eff = (label, f) => {
    const ws = windows.filter((w) => w.up != null && f(w));
    const r = (xs) => pct(mean(xs.map((w) => w.up)));
    out(`| ${label} | ${ws.length} | ${r(ws)} | ${r(ws.filter((w) => w.start < cut))} | ${r(ws.filter((w) => w.start >= cut))} |`);
  };
  eff('全部', () => true);
  for (const wd of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) eff(`结算日 ${wd}`, (w) => w.weekday === wd);
  eff('前一日涨', (w) => w.prev?.up === 1);
  eff('前一日跌', (w) => w.prev?.up === 0);
  const prevRet = (w) => (w.prev ? Math.log(w.prev.close / w.prev.open) : null);
  for (const [lo, hi, label] of [[-1, -0.05, '前一日跌 >5%'], [-0.05, -0.02, '前一日跌 2–5%'], [-0.02, 0, '前一日跌 0–2%'],
    [0, 0.02, '前一日涨 0–2%'], [0.02, 0.05, '前一日涨 2–5%'], [0.05, 1, '前一日涨 >5%']]) eff(label, (w) => prevRet(w) != null && prevRet(w) >= lo && prevRet(w) < hi);
  eff('连涨 2 日后', (w) => w.prev?.up === 1 && w.prev.prev?.up === 1);
  eff('连跌 2 日后', (w) => w.prev?.up === 0 && w.prev.prev?.up === 0);
  // Overnight drift before the window: price change in the 12 hours before the window opens.
  const preRet = (w) => Math.log(w.path[24][1] / w.path[12][1]);
  eff('开窗前 12 小时涨 >1%', (w) => preRet(w) > 0.01);
  eff('开窗前 12 小时跌 >1%', (w) => preRet(w) < -0.01);

  // Price model on hourly checkpoints, fitted before the market sample.
  const stateAt = (w, h) => {
    const price = w.path[24 + h][1];
    const rets = [];
    for (let i = 24 + h - 24; i < 24 + h; i++) rets.push(Math.log(w.path[i + 1][1] / w.path[i][1]));
    const mu = mean(rets);
    const sigma = Math.max(1e-4, Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1)));
    const left = w.hours - h;
    return { h, left, z: Math.log(price / w.open) / (sigma * Math.sqrt(left)) };
  };
  const BUCKETS = [[0, 3], [3, 8], [8, 16], [16, 25]];
  const bucketOf = (left) => BUCKETS.findIndex(([a, b]) => left > a && left <= b);
  const train = BUCKETS.map(() => []);
  for (const w of windows) {
    if (w.end > MODEL_END || w.up == null) continue;
    for (const h of HOURS) if (h < w.hours) { const s = stateAt(w, h); train[bucketOf(s.left)].push([s.z, w.up]); }
  }
  const fits = train.map(fitLogistic);
  out('\n## 价格模型 P(Up) = logistic(a + b·z)，2019-01 至 2026-03 拟合\n\n| 剩余小时 | 样本 | a | b | z=1 | z=2 |\n|---|---|---|---|---|---|');
  BUCKETS.forEach(([lo, hi], i) => out(`| ${lo}–${hi} | ${train[i].length} | ${fits[i].a.toFixed(3)} | ${fits[i].b.toFixed(3)} | ${pct(prob(fits[i], 1))} | ${pct(prob(fits[i], 2))} |`));

  // Market sample.
  const days = (await fs.readFile(path.join(OUT, 'days.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((d) => !d.missing && (d.winner === 'Up' || d.winner === 'Down')).sort((a, b) => a.start - b.start);
  const byStart = new Map(windows.map((w) => [w.start, w]));
  const market = days.map((d) => ({ ...d, w: byStart.get(d.start) })).filter((d) => d.w);
  const agree = mean(market.filter((d) => d.w.up != null).map((d) => ((d.w.up ? 'Up' : 'Down') === d.winner ? 1 : 0)));
  const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  out(`\n## 市场样本\n\n结算日 ${market.length} 个（${new Date(market[0].end * 1000).toISOString().slice(0, 10)} 至 ${new Date(market.at(-1).end * 1000).toISOString().slice(0, 10)}）；每日 taker 买单中位数 ${med(market.map((d) => d.buys.length))}，成交额中位数 $${med(market.map((d) => d.volume))}；Binance 1h 近似与实际结果一致率 ${pct(agree)}；收涨 ${pct(mean(market.map((d) => (d.winner === 'Up' ? 1 : 0))))}`);
  out(`开窗前已有 taker 买单的天数 ${market.filter((d) => d.buys.some((b) => b[0] < 0)).length}；开窗前成交额占比中位数 ${pct(med(market.map((d) => { const pre = d.buys.filter((b) => b[0] < 0).reduce((a, b) => a + b[2] * b[3], 0); const all = d.buys.reduce((a, b) => a + b[2] * b[3], 0); return all ? pre / all : 0; })))}`);

  const view = (d, sec) => {
    const xs = [];
    for (const [t, u, p] of d.buys) { if (t >= sec) break; if (t >= sec - LOOKBACK) xs.push(u ? p : 1 - p); }
    return xs.length ? med(xs.slice(-5)) : null;
  };
  const lastSide = (d, sec, up) => { let last = null; for (const [t, u, p] of d.buys) { if (t >= sec) break; if (t >= sec - LOOKBACK) last = u === up ? p : 1 - p; } return last; };
  const fillAt = (d, sec, up) => {
    for (const width of [FILL, FILL_FALLBACK]) {
      let n = 0, s = 0;
      for (const [t, u, p, z] of d.buys) { if (t < sec) continue; if (t >= sec + width) break; if (u === up) { n += p * z; s += z; } }
      if (s) return n / s;
    }
    return null;
  };
  // Conservative fill: max(VWAP after the decision, last side price before it) + 1c.
  const bet = (d, sec, up, extra = {}) => {
    const vw = fillAt(d, sec, up ? 1 : 0);
    if (vw == null) return null;
    const before = lastSide(d, sec, up ? 1 : 0);
    const price = Math.min(0.99, Math.max(vw, before ?? 0) + 0.01);
    const win = (d.winner === 'Up') === up;
    return { start: d.start, up, price, win, pnl: pnl(win, price), raw: pnl(win, vw), weekend: ['Sat', 'Sun'].includes(weekdayEt(d.end)), ...extra };
  };
  const both = (label, bets) => { out(row(`${label}（保守）`, summarize(bets))); out(row(`${label}（实际成交价）`, summarize(bets.map((b) => ({ ...b, pnl: b.raw }))))); };

  // Calibration of the market favorite by hour.
  out('\n## 盘口校准：热门方向胜率 vs 价格\n\n| 进入窗口后 | 天数 | 热门胜率 | 热门均价 | 模型热门胜率 | 模型 Brier | 盘口 Brier |\n|---|---|---|---|---|---|---|');
  for (const h of [1, 3, 6, 9, 12, 15, 18, 20, 22, 23]) {
    const pts = market.map((d) => ({ m: view(d, h * 3600), p: prob(fits[bucketOf(d.w.hours - h)], stateAt(d.w, h).z), y: d.winner === 'Up' ? 1 : 0 })).filter((x) => x.m != null);
    const fav = pts.filter((x) => x.m !== 0.5);
    out(`| +${h} 小时 | ${pts.length} | ${pct(mean(fav.map((x) => ((x.m > 0.5) === (x.y === 1) ? 1 : 0))))} | ${pct(mean(fav.map((x) => Math.max(x.m, 1 - x.m))))} | ${pct(mean(pts.map((x) => ((x.p >= 0.5) === (x.y === 1) ? 1 : 0))))} | ${mean(pts.map((x) => (x.p - x.y) ** 2)).toFixed(4)} | ${mean(pts.map((x) => (x.m - x.y) ** 2)).toFixed(4)} |`);
  }

  // A. Fixed-hour favorite.
  out(`\n## A. 固定时点买盘口热门（每天 1 注；含 Polymarket 费与 Future 1%）\n\n${HEAD}`);
  for (const h of [0, 1, 3, 6, 12, 18, 21, 23]) {
    const bets = market.map((d) => { const m = view(d, h * 3600); return m == null || m === 0.5 ? null : bet(d, h * 3600, m > 0.5); }).filter(Boolean);
    both(`+${h} 小时`, bets);
  }

  // B. High-price favorite, first hour the favorite trades in the band.
  out(`\n## B. 高价热门（首个整点热门价落在区间内即买）\n\n${HEAD}`);
  for (const [lo, hi] of [[0.7, 0.8], [0.8, 0.9], [0.9, 0.97]]) {
    const bets = [];
    for (const d of market) for (const h of HOURS) { const m = view(d, h * 3600); if (m == null) continue; const q = Math.max(m, 1 - m); if (q >= lo && q < hi) { const b = bet(d, h * 3600, m > 0.5); if (b) { bets.push(b); break; } } }
    both(`热门 ${lo}–${hi}`, bets);
  }

  // C. Price-model edge grid.
  const grid = [];
  for (const minP of [0.6, 0.7, 0.8, 0.9, 0.95]) for (const edge of [0, 0.03, 0.05, 0.08, 0.12]) {
    const bets = [];
    for (const d of market) for (const h of HOURS) {
      if (h >= d.w.hours) break;
      const m = view(d, h * 3600);
      if (m == null) continue;
      const p = prob(fits[bucketOf(d.w.hours - h)], stateAt(d.w, h).z);
      const up = p >= 0.5;
      const pSide = up ? p : 1 - p, mSide = up ? m : 1 - m;
      if (pSide >= minP && pSide - mSide >= edge) { const b = bet(d, h * 3600, up); if (b) { bets.push(b); break; } }
    }
    grid.push({ label: `模型 ≥${minP}，优势 ≥${edge}`, bets, train: summarize(bets.filter((b) => b.start < SPLIT)), test: summarize(bets.filter((b) => b.start >= SPLIT)), all: summarize(bets) });
  }
  const ranked = grid.filter((g) => g.train.n >= 25).sort((a, b) => b.train.ev - a.train.ev);
  out(`\n## C. 价格模型优势（${grid.length} 组，保守成交价；按 4–6 月选前 6）\n\n| 规则 | 4–6 月注数 | 4–6 月胜率 | 4–6 月收益 | 7–10 月注数 | 7–10 月胜率 | 7–10 月收益 | 全样本 t |\n|---|---|---|---|---|---|---|---|`);
  for (const g of ranked.slice(0, 6)) out(`| ${g.label} | ${g.train.n} | ${pct(g.train.win)} | ${signed(g.train.ev)} | ${g.test.n} | ${pct(g.test.win)} | ${signed(g.test.ev)} | ${g.all.t.toFixed(2)} |`);

  // D. Cheap underdogs.
  out(`\n## D. 便宜冷门（首个整点冷门价低于阈值即买）\n\n${HEAD}`);
  for (const cap of [0.1, 0.2, 0.3]) {
    const bets = [];
    for (const d of market) for (const h of HOURS) { const m = view(d, h * 3600); if (m == null) continue; const q = Math.min(m, 1 - m); if (q <= cap && q > 0.02) { const b = bet(d, h * 3600, m < 0.5); if (b) { bets.push(b); break; } } }
    both(`冷门 ≤${cap}`, bets);
  }

  // F. Price-only signals traded at the real price right after the window opens (+5 min).
  out(`\n## F. 价格信号在开窗后 5 分钟按实际盘口下单\n\n${HEAD}`);
  const at = 300;
  const sig = {
    '前一日跌则买涨（反转）': (d) => (d.w.prev ? (d.w.prev.up === 0 ? true : null) : null),
    '前一日涨则买涨（动量）': (d) => (d.w.prev ? (d.w.prev.up === 1 ? true : null) : null),
    '前一日方向反着买': (d) => (d.w.prev && d.w.prev.up != null ? d.w.prev.up === 0 : null),
    '前一日方向顺着买': (d) => (d.w.prev && d.w.prev.up != null ? d.w.prev.up === 1 : null),
    '开窗前 12 小时涨 >1% 买涨': (d) => (preRet(d.w) > 0.01 ? true : null),
    '开窗前 12 小时跌 >1% 买涨': (d) => (preRet(d.w) < -0.01 ? true : null),
    '始终买涨': () => true,
  };
  for (const [label, f] of Object.entries(sig)) {
    const bets = market.map((d) => { const up = f(d); return up == null ? null : bet(d, at, up); }).filter(Boolean);
    both(label, bets);
  }
  // G. Calendar / reversal effects: year by year on Binance, and whether the market already prices them.
  const years = [...new Set(windows.map((w) => new Date(w.end * 1000).getUTCFullYear()))];
  const effects = {
    '周六结算（周五正午→周六正午）': (w) => w.weekday === 'Sat',
    '周日结算': (w) => w.weekday === 'Sun',
    '前一日跌': (w) => w.prev?.up === 0,
    '开窗前 12 小时跌 >1%': (w) => preRet(w) < -0.01,
    '周六结算且前一日跌': (w) => w.weekday === 'Sat' && w.prev?.up === 0,
    '周末结算（周六或周日）': (w) => w.weekday === 'Sat' || w.weekday === 'Sun',
  };
  out(`\n## G. 逐年收涨比例（Binance）\n\n| 条件 | ${years.join(' | ')} | 全部 |\n|${'---|'.repeat(years.length + 2)}`);
  for (const [label, f] of Object.entries(effects)) {
    const cells = years.map((y) => { const ws = windows.filter((w) => w.up != null && f(w) && new Date(w.end * 1000).getUTCFullYear() === y); return `${pct(mean(ws.map((w) => w.up)), 0)} (${ws.length})`; });
    const all = windows.filter((w) => w.up != null && f(w));
    out(`| ${label} | ${cells.join(' | ')} | ${pct(mean(all.map((w) => w.up)))} (${all.length}) |`);
  }
  out(`\n### 市场样本：开窗后 5 分钟买涨（这些条件下盘口给涨的价格是否已偏高）\n\n${HEAD}`);
  for (const [label, f] of Object.entries(effects)) both(label, market.filter((d) => f(d.w)).map((d) => bet(d, 300, true)).filter(Boolean));
  both('其余日子（对照）', market.filter((d) => !Object.values(effects).slice(0, 4).some((f) => f(d.w))).map((d) => bet(d, 300, true)).filter(Boolean));
  // Entering before the window opens (the market lists days ahead): price an hour before the open.
  both('周六结算，开窗前 1 小时买涨', market.filter((d) => d.w.weekday === 'Sat').map((d) => bet(d, -3600, true)).filter(Boolean));

  // H. The last hour in finer steps: buy the favorite at a fixed minute before the close.
  out(`\n## H. 最后一小时买热门（固定时点，每天 1 注）\n\n${HEAD}`);
  for (const minsLeft of [60, 45, 30, 20, 15, 10, 5]) {
    const bets = market.map((d) => { const sec = d.end - d.start - minsLeft * 60; const m = view(d, sec); return m == null || m === 0.5 ? null : bet(d, sec, m > 0.5); }).filter(Boolean);
    both(`收盘前 ${minsLeft} 分钟`, bets);
  }
  for (const [lo, hi] of [[0.85, 0.95], [0.9, 0.97]]) {
    const bets = market.map((d) => {
      for (const minsLeft of [60, 50, 40, 30, 20, 10]) {
        const sec = d.end - d.start - minsLeft * 60;
        const m = view(d, sec);
        if (m == null) continue;
        const q = Math.max(m, 1 - m);
        if (q >= lo && q < hi) return bet(d, sec, m > 0.5);
      }
      return null;
    }).filter(Boolean);
    both(`最后一小时热门首次落在 ${lo}–${hi}`, bets);
  }
  await fs.writeFile(path.join(OUT, 'report.md'), lines.join('\n') + '\n');
}

const stage = (process.argv.find((a) => a.startsWith('--stage=')) ?? '--stage=all').split('=')[1];
if (stage === 'fetch' || stage === 'all') { await fetchKlines(); await fetchDays(); }
if (stage === 'report' || stage === 'all') await report();
