#!/usr/bin/env node
// BTC 4-hour Up/Down research: which rules win often, and does any of them beat price + fee?
//
// Polymarket 4h rounds open on UTC 4-hour boundaries and resolve Up when the Chainlink BTC/USD
// 60s-TWAP stream at the close is >= the price at the open. Taker fee 0.07 * p * (1 - p) per share.
//
// 1. Price model (no market data): on Binance BTCUSDT 1m candles 2024-10-05..2026-04-03, for every
//    4h round and every 5-minute checkpoint T, z = ln(P_T / P_open) / (sigma_1m * sqrt(minutes left)),
//    sigma from the previous 60 one-minute returns. P(Up | z) is fitted per time-left bucket.
// 2. Market sample: every 4h round 2026-04-04..now (crypto_fees_v2), every taker buy. At checkpoint T
//    the market favorite is the median implied Up price of the last 5 taker buys in [T-300, T);
//    a bet fills at the taker-buy VWAP of its side in [T, T+120) (fallback [T, T+300)).
// 3. Rules are tuned on April-June and judged on July-October; one bet per round at most.
//
// Cache: artifacts/4h-research/. Older 1m candles are reused from artifacts/weekend-updown/klines.
// Usage: NODE_USE_ENV_PROXY=1 node scripts/run-4h-updown-research.mjs [--stage=fetch|report|all]

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FEE_RATE, SERIES, etParts, researchArtifactPath } from '../src/polymarket-updown.mjs';

const OUT = researchArtifactPath('4h-research');
const OLD_KLINES = researchArtifactPath('weekend-updown', 'klines');
const GAMMA_EVENTS = 'https://gamma-api.polymarket.com/events';
const DATA_TRADES = 'https://data-api.polymarket.com/trades';
const BINANCE_KLINES = 'https://data-api.binance.vision/api/v3/klines';

const ROUND = 14400;
const TRAIN_START = Date.UTC(2024, 9, 5) / 1000;
const MARKET_START = Date.UTC(2026, 3, 4) / 1000;
const SPLIT = Date.UTC(2026, 6, 1) / 1000; // tune on April-June, judge on July onward
const NOW = Math.floor(Date.now() / 1000);
const MARKET_END = Math.floor(NOW / ROUND) * ROUND - ROUND; // last fully settled round start
const CHECKPOINTS = Array.from({ length: 47 }, (_, i) => (i + 1) * 5)
  // CHECKPOINTS_MOD15=1 keeps only minutes 5 and 10 of each quarter hour (leaves the 15m entry window free).
  .filter((m) => !process.env.CHECKPOINTS_MOD15 || m % 15 !== 0); // minutes 5..235
const BUCKETS = [[0, 15], [15, 30], [30, 60], [60, 120], [120, 240]]; // minutes left
const LOOKBACK = 300;
const FILL = 120;
const FILL_FALLBACK = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;
async function paced() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 85; // Data API allows 200 /trades requests per 10s
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
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}
const regimeOf = (d = '') => (/TWAP/.test(d) ? 'twap' : /Chainlink/.test(d) ? 'chainlink' : /Binance/.test(d) ? 'binance' : 'other');
const isWeekend = (sec) => ['Sat', 'Sun'].includes(etParts(sec).weekday);

// ---------------------------------------------------------------------------
// Fetch

async function takerTrades(conditionId, lo, hi) {
  const rows = await getJson(`${DATA_TRADES}?market=${conditionId}&takerOnly=true&limit=1000&start=${lo}&end=${hi}`);
  if (rows.length < 1000 || hi <= lo) return rows;
  const mid = Math.floor((lo + hi) / 2);
  return [...(await takerTrades(conditionId, lo, mid)), ...(await takerTrades(conditionId, mid + 1, hi))];
}

async function fetchRounds() {
  await fs.mkdir(OUT, { recursive: true });
  const file = path.join(OUT, 'rounds.jsonl');
  const done = new Set();
  if (existsSync(file)) for (const line of (await fs.readFile(file, 'utf8')).split('\n')) if (line) done.add(JSON.parse(line).start);
  const todo = [];
  for (let s = MARKET_START; s <= MARKET_END; s += ROUND) if (!done.has(s)) todo.push(s);
  console.log(`rounds: ${done.size} cached, ${todo.length} to fetch`);
  const batches = [];
  for (let i = 0; i < todo.length; i += 20) batches.push(todo.slice(i, i + 20));
  let written = 0;
  await pool(batches, 2, async (batch) => {
    try {
      const events = await getJson(`${GAMMA_EVENTS}?${batch.map((s) => `slug=${SERIES['4h'].slug(s)}`).join('&')}`);
      const bySlug = new Map(events.map((e) => [e.slug, e]));
      const lines = [];
      await pool(batch, 3, async (start) => {
        const event = bySlug.get(SERIES['4h'].slug(start));
        const market = event?.markets?.[0];
        if (!market) return lines.push(JSON.stringify({ start, missing: true }));
        const prices = JSON.parse(market.outcomePrices ?? '[]').map(Number);
        const winner = prices[0] === 1 ? 'Up' : prices[1] === 1 ? 'Down' : null;
        const trades = await takerTrades(market.conditionId, start - 3600, start + ROUND);
        // Compact taker buys: [seconds after open, 1 = Up / 0 = Down, price, shares].
        const buys = trades
          .filter((t) => t.side === 'BUY' && t.timestamp < start + ROUND)
          .map((t) => [t.timestamp - start, t.outcome === 'Up' ? 1 : 0, +t.price, +(+t.size).toFixed(2)])
          .sort((a, b) => a[0] - b[0]);
        lines.push(JSON.stringify({ start, regime: regimeOf(market.description), feeType: market.feeType ?? null,
          winner, volume: Math.round(+market.volume || 0), nTaker: trades.length, buys }));
      });
      await fs.appendFile(file, lines.join('\n') + '\n');
      written += batch.length;
      if (written % 200 < 20) console.log(`rounds: ${written}/${todo.length}`);
    } catch (err) {
      console.warn(`batch at ${batch[0]} failed (${err.message}); rerun to resume`);
    }
  });
}

async function fetchRecentKlines() {
  const dir = path.join(OUT, 'klines');
  await fs.mkdir(dir, { recursive: true });
  const from = Date.UTC(2026, 9, 1);
  const file = path.join(dir, '2026-10.json');
  const rows = [];
  for (let t = from; t < NOW * 1000;) {
    const batch = await getJson(`${BINANCE_KLINES}?symbol=BTCUSDT&interval=1m&startTime=${t}&limit=1000`);
    if (!batch.length) break;
    for (const k of batch) rows.push([k[0] / 1000, +k[1], +k[2], +k[3], +k[4]]);
    t = batch.at(-1)[0] + 60000;
  }
  await fs.writeFile(file, JSON.stringify(rows));
  console.log(`klines 2026-10: ${rows.length}`);
}

// ---------------------------------------------------------------------------
// Price model

async function loadKlines() {
  const bySec = new Map();
  for (const name of (await fs.readdir(OLD_KLINES)).sort()) {
    if (name === '2026-10.json') continue;
    for (const k of JSON.parse(await fs.readFile(path.join(OLD_KLINES, name), 'utf8'))) bySec.set(k[0], k);
  }
  for (const k of JSON.parse(await fs.readFile(path.join(OUT, 'klines', '2026-10.json'), 'utf8'))) bySec.set(k[0], k);
  return bySec;
}

// Proxies for the Chainlink settlement: open = first 1m open; close = mean OHLC of the last minute
// (the 60s TWAP). The whole-range TWAP variant is kept only to check which rule the markets use.
function roundPath(k, start) {
  const candles = [];
  for (let i = -60; i < 240; i++) {
    const c = k.get(start + i * 60);
    if (!c) return null;
    candles.push(c);
  }
  const body = candles.slice(60);
  const open = body[0][1];
  const last = body[239];
  const close = (last[1] + last[2] + last[3] + last[4]) / 4;
  const rangeTwap = body.reduce((a, c) => a + (c[1] + c[4]) / 2, 0) / 240;
  return { candles, open, up: close >= open, upRange: rangeTwap >= open, upSpot: last[4] >= open };
}

// State at checkpoint `m` minutes after open: price is the close of minute m-1.
function stateAt(p, m) {
  const price = p.candles[59 + m][4];
  const rets = [];
  for (let i = m; i < m + 60; i++) rets.push(Math.log(p.candles[i][4] / p.candles[i - 1][4]));
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sigma = Math.max(1e-5, Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1)));
  const left = 240 - m;
  const x = Math.log(price / p.open);
  return { x, sigma, left, z: x / (sigma * Math.sqrt(left)) };
}
const bucketOf = (left) => BUCKETS.findIndex(([a, b]) => left > a && left <= b);

// Logistic regression p = 1 / (1 + exp(-(a + b z))) by Newton's method.
function fitLogistic(rows) {
  let a = 0;
  let b = 1;
  for (let it = 0; it < 50; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const [z, y] of rows) {
      const p = 1 / (1 + Math.exp(-(a + b * z)));
      const w = p * (1 - p);
      ga += y - p; gb += (y - p) * z;
      haa += w; hab += w * z; hbb += w * z * z;
    }
    const det = haa * hbb - hab * hab;
    if (!det) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b };
}
const prob = (fit, z) => 1 / (1 + Math.exp(-(fit.a + fit.b * Math.max(-12, Math.min(12, z)))));

// ---------------------------------------------------------------------------
// Report

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const pnl = (win, price, slip = 0) => { const p = Math.min(0.99, price + slip); return (win ? 1 / p : 0) - 1 - FEE_RATE * (1 - p); };
const pct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%` : '—');

function summarize(bets) {
  const r = bets.map((b) => b.pnl);
  const m = mean(r);
  return {
    n: bets.length,
    win: mean(bets.map((b) => (b.win ? 1 : 0))),
    price: mean(bets.map((b) => b.price)),
    ev: m,
    slip: mean(bets.map((b) => pnl(b.win, b.price, 0.01))),
    t: bets.length > 1 ? m / (sd(r) / Math.sqrt(bets.length)) : NaN,
    first: mean(bets.filter((b) => b.start < SPLIT).map((b) => b.pnl)),
    second: mean(bets.filter((b) => b.start >= SPLIT).map((b) => b.pnl)),
    nFirst: bets.filter((b) => b.start < SPLIT).length,
    nSecond: bets.filter((b) => b.start >= SPLIT).length,
  };
}
const row = (label, s) => `| ${label} | ${s.n} | ${pct(s.win)} | ${s.price?.toFixed(3)} | ${signed(s.win - s.price)} | ${signed(s.ev)} | ${signed(s.slip)} | ${s.t?.toFixed(2)} | ${signed(s.first)} (${s.nFirst}) | ${signed(s.second)} (${s.nSecond}) |`;
const HEAD = '| 规则 | 注数 | 胜率 | 平均买价 | 胜率−买价 | 每注收益 | +1¢ 滑点 | t | 4–6 月 | 7–10 月 |\n|---|---|---|---|---|---|---|---|---|---|';

function marketView(round, sec) {
  const before = [];
  for (const [t, u, p] of round.buys) {
    if (t >= sec) break;
    if (t >= sec - LOOKBACK) before.push(u ? p : 1 - p);
  }
  if (!before.length) return null;
  const last = before.slice(-5).sort((a, b) => a - b);
  return last[Math.floor(last.length / 2)];
}
function fillAt(round, sec, up) {
  for (const width of [FILL, FILL_FALLBACK]) {
    let notional = 0, size = 0;
    for (const [t, u, p, s] of round.buys) {
      if (t < sec) continue;
      if (t >= sec + width) break;
      if (u === up) { notional += p * s; size += s; }
    }
    if (size) return notional / size;
  }
  return null;
}

async function report() {
  const k = await loadKlines();
  const lines = [];
  const out = (s = '') => { lines.push(s); console.log(s); };

  // 1. Train the price model on rounds before the market sample.
  const train = BUCKETS.map(() => []);
  let nTrain = 0;
  for (let s = TRAIN_START; s < MARKET_START; s += ROUND) {
    const p = roundPath(k, s);
    if (!p) continue;
    nTrain++;
    for (const m of CHECKPOINTS) {
      const st = stateAt(p, m);
      train[bucketOf(st.left)].push([st.z, p.up ? 1 : 0]);
    }
  }
  const fits = train.map(fitLogistic);
  out(`# BTC 4 小时 Up/Down 研究\n\n生成时间 ${new Date().toISOString()}；训练轮次 ${nTrain}（Binance 1m，${new Date(TRAIN_START * 1000).toISOString().slice(0, 10)} 至 ${new Date(MARKET_START * 1000).toISOString().slice(0, 10)}）\n`);
  out('## 价格模型 P(Up) = logistic(a + b·z)\n\n| 剩余分钟 | 样本 | a | b | z=0.5 | z=1 | z=2 |\n|---|---|---|---|---|---|---|');
  BUCKETS.forEach(([lo, hi], i) => out(`| ${lo}–${hi} | ${train[i].length} | ${fits[i].a.toFixed(3)} | ${fits[i].b.toFixed(3)} | ${pct(prob(fits[i], 0.5))} | ${pct(prob(fits[i], 1))} | ${pct(prob(fits[i], 2))} |`));

  // 2. Market rounds.
  const rounds = (await fs.readFile(path.join(OUT, 'rounds.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => !r.missing && r.winner && r.feeType === 'crypto_fees_v2').sort((a, b) => a.start - b.start);
  const enriched = rounds.map((r) => ({ ...r, path: roundPath(k, r.start) })).filter((r) => r.path);
  const regimes = {};
  for (const r of enriched) regimes[r.regime] = (regimes[r.regime] ?? 0) + 1;
  out(`\n## 市场样本\n\n轮次 ${rounds.length}（有完整 K 线 ${enriched.length}）；结算口径 ${JSON.stringify(regimes)}；${new Date(rounds[0].start * 1000).toISOString().slice(0, 10)} 至 ${new Date(rounds.at(-1).start * 1000).toISOString().slice(0, 10)}；每轮 taker 买单中位数 ${[...rounds.map((r) => r.buys.length)].sort((a, b) => a - b)[Math.floor(rounds.length / 2)]}，成交额中位数 $${[...rounds.map((r) => r.volume)].sort((a, b) => a - b)[Math.floor(rounds.length / 2)]}`);
  const agree = (key) => mean(enriched.map((r) => ((r.path[key] ? 'Up' : 'Down') === r.winner ? 1 : 0)));
  out(`\n结算规则核对（Binance 近似 vs 实际结果一致率）：最后 1 分钟均价 ${pct(agree('up'))}，最后一分钟收盘 ${pct(agree('upSpot'))}，整段 4 小时均价 ${pct(agree('upRange'))}`);
  out(`实际结果：涨 ${pct(mean(enriched.map((r) => (r.winner === 'Up' ? 1 : 0))))}`);

  // DUMP_ROUND=<start>: the model at every checkpoint of one round, to cross-check the live port.
  if (process.env.DUMP_ROUND) {
    const start = Number(process.env.DUMP_ROUND);
    const p = roundPath(k, start);
    await fs.writeFile(path.join(OUT, `dump-${start}.json`), JSON.stringify(CHECKPOINTS.map((m) => {
      const st = stateAt(p, m);
      return { m, z: st.z, sigma: st.sigma, pUp: prob(fits[bucketOf(st.left)], st.z) };
    })));
  }
  // Per-checkpoint state for every market round.
  const states = enriched.map((r) => CHECKPOINTS.map((m) => {
    const st = stateAt(r.path, m);
    const pUp = prob(fits[bucketOf(st.left)], st.z);
    const mkt = marketView(r, m * 60);
    return { m, ...st, pUp, mkt };
  }));

  // Calibration: model vs market vs outcome on the market sample.
  out('\n## 校准：模型与盘口谁更准（市场样本，所有检查点）\n\n| 剩余分钟 | 检查点数 | 模型 Brier | 盘口 Brier | 盘口热门胜率 | 盘口热门均价 | 模型热门胜率 | 模型热门平均概率 |\n|---|---|---|---|---|---|---|---|');
  BUCKETS.forEach(([lo, hi], bi) => {
    const pts = [];
    enriched.forEach((r, i) => states[i].forEach((s) => { if (bucketOf(s.left) === bi && s.mkt != null) pts.push({ ...s, y: r.winner === 'Up' ? 1 : 0 }); }));
    const brier = (f) => mean(pts.map((p) => (f(p) - p.y) ** 2));
    const favMkt = pts.filter((p) => p.mkt !== 0.5);
    const favMod = pts;
    out(`| ${lo}–${hi} | ${pts.length} | ${brier((p) => p.pUp).toFixed(4)} | ${brier((p) => p.mkt).toFixed(4)} | ${pct(mean(favMkt.map((p) => ((p.mkt > 0.5) === (p.y === 1) ? 1 : 0))))} | ${pct(mean(favMkt.map((p) => Math.max(p.mkt, 1 - p.mkt))))} | ${pct(mean(favMod.map((p) => ((p.pUp >= 0.5) === (p.y === 1) ? 1 : 0))))} | ${pct(mean(favMod.map((p) => Math.max(p.pUp, 1 - p.pUp))))} |`);
  });

  // A. Buy the market favorite at a fixed checkpoint.
  const betOn = (r, m, up) => {
    const price = fillAt(r, m * 60, up ? 1 : 0);
    if (price == null) return null;
    const win = (r.winner === 'Up') === up;
    return { start: r.start, m, up, price, win, pnl: pnl(win, price), weekend: isWeekend(r.start) };
  };
  out(`\n## A. 固定时点买盘口热门（每轮 1 注）\n\n${HEAD}`);
  for (const m of [5, 15, 30, 60, 90, 120, 150, 180, 200, 210, 220, 230, 235]) {
    const bets = [];
    enriched.forEach((r, i) => {
      const s = states[i].find((x) => x.m === m);
      if (!s) return;
      if (s.mkt == null || s.mkt === 0.5) return;
      const b = betOn(r, m, s.mkt > 0.5);
      if (b) bets.push(b);
    });
    out(row(`+${m} 分钟`, summarize(bets)));
  }

  // B. High-price favorite: first checkpoint where the favorite trades within [lo, hi].
  const firstWhere = (pred, sideOf) => {
    const bets = [];
    enriched.forEach((r, i) => {
      for (const s of states[i]) {
        if (!pred(s)) continue;
        const b = betOn(r, s.m, sideOf(s));
        if (b) { bets.push({ ...b, pModel: s.pUp }); break; }
      }
    });
    return bets;
  };
  out(`\n## B. 高价热门：首次出现热门价落在区间内即买（每轮最多 1 注）\n\n${HEAD}`);
  for (const [lo, hi] of [[0.7, 0.8], [0.8, 0.9], [0.85, 0.95], [0.9, 0.97], [0.93, 0.99]]) {
    for (const minLeft of [0, 60, 120]) {
      const bets = firstWhere((s) => s.mkt != null && s.left > minLeft && Math.max(s.mkt, 1 - s.mkt) >= lo && Math.max(s.mkt, 1 - s.mkt) < hi, (s) => s.mkt > 0.5);
      out(row(`热门 ${lo}–${hi}，剩余 >${minLeft} 分`, summarize(bets)));
    }
  }

  // C. Price-model edge: buy the side the model favors when model probability beats the market.
  const grid = [];
  for (const minP of [0.6, 0.7, 0.8, 0.9, 0.95]) {
    for (const edge of [0, 0.03, 0.05, 0.08, 0.12]) {
      for (const [lo, hi] of [[0, 240], [0, 60], [60, 240]]) {
        const bets = firstWhere((s) => {
          if (s.mkt == null || s.left <= lo || s.left > hi) return false;
          const up = s.pUp >= 0.5;
          const pSide = up ? s.pUp : 1 - s.pUp;
          const mSide = up ? s.mkt : 1 - s.mkt;
          return pSide >= minP && pSide - mSide >= edge;
        }, (s) => s.pUp >= 0.5);
        grid.push({ label: `模型 ≥${minP}，优势 ≥${edge}，剩余 ${lo}–${hi} 分`, bets, s: summarize(bets),
          train: summarize(bets.filter((b) => b.start < SPLIT)), test: summarize(bets.filter((b) => b.start >= SPLIT)) });
      }
    }
  }
  const eligible = grid.filter((g) => g.train.n >= 60);
  eligible.sort((a, b) => b.train.ev - a.train.ev);
  out(`\n## C. 价格模型优势（${grid.length} 组参数；按 4–6 月收益选前 8，7–10 月为样本外）\n\n| 规则 | 4–6 月注数 | 4–6 月胜率 | 4–6 月收益 | 7–10 月注数 | 7–10 月胜率 | 7–10 月平均买价 | 7–10 月收益 | 7–10 月 t |\n|---|---|---|---|---|---|---|---|---|`);
  for (const g of eligible.slice(0, 8)) out(`| ${g.label} | ${g.train.n} | ${pct(g.train.win)} | ${signed(g.train.ev)} | ${g.test.n} | ${pct(g.test.win)} | ${g.test.price?.toFixed(3)} | ${signed(g.test.ev)} | ${g.test.t?.toFixed(2)} |`);
  const highWin = grid.filter((g) => g.s.n >= 100).sort((a, b) => b.s.win - a.s.win).slice(0, 6);
  out(`\n### 胜率最高的模型规则（全样本 ≥100 注）\n\n${HEAD}`);
  for (const g of highWin) out(row(g.label, g.s));

  // Weekend vs weekday for the best train-selected rule.
  if (eligible.length) {
    const best = eligible[0];
    out(`\n### 训练期最优规则「${best.label}」分周末/工作日\n\n${HEAD}`);
    out(row('周末', summarize(best.bets.filter((b) => b.weekend))));
    out(row('工作日', summarize(best.bets.filter((b) => !b.weekend))));
    await fs.writeFile(path.join(OUT, 'best-rule-bets.json'), JSON.stringify(best.bets));
  }

  // D. Robustness of the high-confidence model rule.
  //   - one decision per round: the first checkpoint that qualifies; no retry if it does not fill
  //   - "conservative" fill: max(fill VWAP, last side price before T) + 1c, plus Future's 1% fee
  //   - signals that never fill within 5 minutes are reported with their outcome (selection bias check)
  const sidePriceBefore = (r, sec, up) => {
    let last = null;
    let at = null;
    for (const [t, u, p] of r.buys) {
      if (t >= sec) break;
      if (t >= sec - LOOKBACK) { last = u === up ? p : 1 - p; at = t; }
    }
    return { price: last, age: at == null ? null : sec - at };
  };
  const robust = (minP, edge, lo = 0, hi = 240, { fresh = Infinity } = {}) => {
    const bets = [];
    const unfilled = [];
    enriched.forEach((r, i) => {
      for (const s of states[i]) {
        if (s.mkt == null || s.left <= lo || s.left > hi) continue;
        const up = s.pUp >= 0.5;
        const pSide = up ? s.pUp : 1 - s.pUp;
        const mSide = up ? s.mkt : 1 - s.mkt;
        if (pSide < minP || pSide - mSide < edge) continue;
        const before = sidePriceBefore(r, s.m * 60, up ? 1 : 0);
        if (before.age == null || before.age > fresh) continue;
        const win = (r.winner === 'Up') === up;
        const vw = fillAt(r, s.m * 60, up ? 1 : 0);
        if (vw == null) { unfilled.push({ start: r.start, win, price: before.price }); break; }
        const price = Math.min(0.99, Math.max(vw, before.price) + 0.01);
        bets.push({ start: r.start, m: s.m, up, win, price, pnl: pnl(win, price) - 0.01, raw: pnl(win, vw),
          regime: r.regime, weekend: isWeekend(r.start) });
        break;
      }
    });
    return { bets, unfilled };
  };
  out('\n## D. 稳健性：模型 ≥0.95、优势 ≥0.03（每轮只在首个触发点决定，不重试）\n');
  out('保守成交价 = max(触发后 2 分钟成交均价, 触发前该方向最后成交价) + 1¢；收益另扣 Future 1%。\n');
  out(`${HEAD}`);
  for (const [lo, hi] of [[0, 240], [60, 240], [0, 60]]) {
    const { bets, unfilled } = robust(0.95, 0.03, lo, hi);
    const s = summarize(bets);
    out(row(`剩余 ${lo}–${hi} 分（保守）`, s));
    out(row(`剩余 ${lo}–${hi} 分（原始成交价、不扣 Future 费）`, summarize(bets.map((b) => ({ ...b, pnl: b.raw })))));
    out(`|  未成交信号 ${unfilled.length} 个，其方向胜率 ${pct(mean(unfilled.map((u) => (u.win ? 1 : 0))))} | | | | | | | | | |`);
  }
  {
    const { bets } = robust(0.95, 0.03, 0, 240, { fresh: 60 });
    out(row('只用 60 秒内有成交的盘口（保守）', summarize(bets)));
  }
  const base = robust(0.95, 0.03).bets;
  out(`\n### 按月（保守口径，剩余 0–240 分）\n\n| 月份 | 注数 | 胜率 | 平均买价 | 每注收益 |\n|---|---|---|---|---|`);
  const months = {};
  for (const b of base) (months[new Date(b.start * 1000).toISOString().slice(0, 7)] ??= []).push(b);
  for (const [mo, bs] of Object.entries(months)) { const s = summarize(bs); out(`| ${mo} | ${s.n} | ${pct(s.win)} | ${s.price.toFixed(3)} | ${signed(s.ev)} |`); }
  out(`\n${HEAD}`);
  for (const reg of ['chainlink', 'twap']) out(row(`结算口径 ${reg}`, summarize(base.filter((b) => b.regime === reg))));
  out(row('周末', summarize(base.filter((b) => b.weekend))));
  out(row('工作日', summarize(base.filter((b) => !b.weekend))));
  let equity = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const b of base.sort((a, z) => a.start - z.start)) {
    equity += b.pnl; peak = Math.max(peak, equity); dd = Math.min(dd, equity - peak);
    streak = b.win ? 0 : streak + 1; worst = Math.max(worst, streak);
  }
  out(`\n每注 $1 累计 ${equity.toFixed(2)} 美元；最大回撤 ${dd.toFixed(2)} 美元；最长连败 ${worst} 注；约 ${(base.length / ((MARKET_END - MARKET_START) / 86400)).toFixed(2)} 注/天`);
  // Bootstrap 90% interval for the conservative mean.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const boots = Array.from({ length: 2000 }, () => mean(Array.from({ length: base.length }, () => base[Math.floor(rand() * base.length)].pnl))).sort((a, b) => a - b);
  out(`自助法 90% 区间（保守每注收益）：${signed(boots[100])} 至 ${signed(boots[1899])}；P(≤0) ≈ ${pct(boots.filter((v) => v <= 0).length / boots.length)}`);
  out(`\n### 阈值敏感性（保守口径，剩余 0–240 分；格内为 4–6 月 / 7–10 月 每注收益与注数）\n\n| 模型下限 \\ 优势下限 | 0 | 0.02 | 0.03 | 0.05 | 0.08 |\n|---|---|---|---|---|---|`);
  for (const minP of [0.9, 0.93, 0.95, 0.97, 0.98]) {
    const cells = [0, 0.02, 0.03, 0.05, 0.08].map((e) => {
      const s = summarize(robust(minP, e).bets);
      return `${signed(s.first)} (${s.nFirst}) / ${signed(s.second)} (${s.nSecond})`;
    });
    out(`| ${minP} | ${cells.join(' | ')} |`);
  }
  await fs.writeFile(path.join(OUT, 'candidate-bets.json'), JSON.stringify(base));
  await fs.writeFile(path.join(OUT, 'report.md'), lines.join('\n') + '\n');
}

const stage = (process.argv.find((a) => a.startsWith('--stage=')) ?? '--stage=all').split('=')[1];
if (stage === 'fetch' || stage === 'all') {
  await fetchRecentKlines();
  await fetchRounds();
}
if (stage === 'report' || stage === 'all') await report();
