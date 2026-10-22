// Weekend cross-timeframe combinations of the "buy the favorite" rule, using cached real taker trades.
// Every lean is computed only from trades strictly before the decision time.
import fs from 'node:fs';
import { researchArtifactPath } from '../src/polymarket-updown.mjs';
const A = researchArtifactPath();
const load = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => !r.missing && r.winner);
const r5 = load(`${A}/btc5m-early-entry/5m.jsonl`).filter((r) => r.day === 'weekend');
const r15 = new Map(load(`${A}/weekend-favorite-timing/15m.jsonl`).map((r) => [r.start, r]));
const r1h = new Map(load(`${A}/weekend-favorite-timing/1h.jsonl`).map((r) => [r.start, r]));
const SPLIT = Date.UTC(2026, 6, 4, 4) / 1000;
const FEE = 0.07, FUTURE = 0.01;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

// Implied Up price of the round at absolute time t (median of the last 5 taker buys in [t-60, t)).
function leanAt(round, t) {
  const rel = t - round.start;
  const xs = [];
  for (const [s, u, p] of round.buys) { if (s >= rel) break; if (s >= rel - 60) xs.push(u ? p : 1 - p); }
  return xs.length ? median(xs.slice(-5)) : null;
}
const sideOf = (lean) => (lean == null || lean === 0.5 ? null : lean > 0.5 ? 'Up' : 'Down');
function vwap(buys, up, lo, hi) {
  let n = 0, s = 0;
  for (const [t, u, p, z] of buys) { if (t < lo) continue; if (t >= hi) break; if (u !== up) continue; n += p * z; s += z; }
  return s ? n / s : null;
}
const fill = (round, side, T) => vwap(round.buys, side === 'Up' ? 1 : 0, T, T + 20) ?? vwap(round.buys, side === 'Up' ? 1 : 0, T, T + 60);
const pnl = (b) => (b.win ? 1 / b.price : 0) - 1 - FEE * (1 - b.price) - FUTURE;
const higher = (t, sec, map) => map.get(Math.floor(t / sec) * sec);

function stats(name, bets) {
  if (bets.length < 40) return console.log(`${name.padEnd(46)} n ${bets.length}`);
  const p = bets.map(pnl), m = mean(p);
  const half = (f) => { const q = bets.filter(f).map(pnl); return q.length > 20 ? `${(100 * mean(q)).toFixed(2)}%` : '—'; };
  console.log(`${name.padEnd(46)} n ${String(bets.length).padStart(5)}  胜 ${(100 * mean(bets.map((b) => +b.win))).toFixed(1)}%  价 ${mean(bets.map((b) => b.price)).toFixed(3)}  每注 ${(100 * m).toFixed(2).padStart(6)}%  t ${(m / (sd(p) / Math.sqrt(p.length))).toFixed(2).padStart(5)}  | 4-6月 ${half((b) => b.start < SPLIT)}  7-10月 ${half((b) => b.start >= SPLIT)}`);
}

// ---- 1) 5m favorite at +T, filtered by the 15m / 1h favorite at the same moment ----
for (const T of [45, 60]) {
  console.log(`\n# 5m 热门方向，第 ${T} 秒下单（含 60¢ 下限、97¢ 上限、Future 1%）`);
  const groups = {};
  const add = (k, b) => (groups[k] ??= []).push(b);
  for (const r of r5) {
    const t = r.start + T;
    const lean5 = leanAt(r, t), side5 = sideOf(lean5);
    if (!side5) continue;
    const q = Math.max(lean5, 1 - lean5);
    const s15 = sideOf(higher(t, 900, r15) && leanAt(higher(t, 900, r15), t));
    const s1h = sideOf(higher(t, 3600, r1h) && leanAt(higher(t, 3600, r1h), t));
    const price = fill(r, side5, T);
    if (price == null) continue;
    const b = {start: r.start, price, win: r.winner === side5};
    if (q < 0.6 || q > 0.97) {
      // 2) Below 60¢ (skipped today): buy the 5m side the 1h favorite points to, even if it is the cheaper side.
      if (s1h && q < 0.6) { const p2 = fill(r, s1h, T); if (p2 != null) add('rej<60 · 买 1h 方向', {start: r.start, price: p2, win: r.winner === s1h}); }
      continue;
    }
    add('基准（现规则）', b);
    if (s15) add(s15 === side5 ? '15m 同向' : '15m 反向', b);
    if (s1h) add(s1h === side5 ? '1h 同向' : '1h 反向', b);
    if (s15 && s1h) add(s15 === side5 && s1h === side5 ? '三者同向' : '非三者同向', b);
    // 2) Against the 1h favorite: buy the 5m underdog in the 1h direction instead.
    if (s1h && s1h !== side5) { const p2 = fill(r, s1h, T); if (p2 != null) add('1h 反向时改买 1h 方向（5m 冷门）', {start: r.start, price: p2, win: r.winner === s1h}); }
    if (s15 && s15 !== side5) { const p2 = fill(r, s15, T); if (p2 != null) add('15m 反向时改买 15m 方向（5m 冷门）', {start: r.start, price: p2, win: r.winner === s15}); }
  }
  for (const k of ['基准（现规则）', '15m 同向', '15m 反向', '1h 同向', '1h 反向', '三者同向', '非三者同向',
    '1h 反向时改买 1h 方向（5m 冷门）', '15m 反向时改买 15m 方向（5m 冷门）', 'rej<60 · 买 1h 方向']) stats(k, groups[k] ?? []);
}

// ---- 3) 15m and 1h favorites filtered by the other timeframes ----
const series = [['15m', r15, 900, [60, 150, 300]], ['1h', r1h, 3600, [60, 600, 1800]]];
for (const [name, map, sec, offsets] of series) {
  for (const T of offsets) {
    console.log(`\n# ${name} 热门方向，第 ${T} 秒下单（60–97¢，Future 1%）`);
    const groups = {};
    const add = (k, b) => (groups[k] ??= []).push(b);
    for (const r of map.values()) {
      const t = r.start + T;
      const lean = leanAt(r, t), side = sideOf(lean);
      if (!side) continue;
      const q = Math.max(lean, 1 - lean);
      if (q < 0.6 || q > 0.97) continue;
      const price = fill(r, side, T);
      if (price == null) continue;
      const b = {start: r.start, price, win: r.winner === side};
      add('基准', b);
      const other = name === '15m' ? higher(t, 3600, r1h) : higher(t, 900, r15);
      const so = sideOf(other && leanAt(other, t));
      if (so) add(`${name === '15m' ? '1h' : '15m'} ${so === side ? '同向' : '反向'}`, b);
    }
    for (const k of Object.keys(groups)) stats(k, groups[k]);
  }
}
