// Which BTC conditions (time, volatility, volume, trend) change the 15m "buy the favorite at +150s"
// results, and does a filter survive out of sample?
//   Historical: cached weekend 15m/1h rounds with every taker buy (2026-04-04 .. 10-05).
//   Live: the Future wallet's real 15m buys (2026-10-15 ..), outcomes from the CLOB.
// Features use only BTCUSDT 1m candles that closed before the decision. Cut points come from the
// training half only (before 2026-07-04); validation is the later half, then the live trades.
import fs from 'node:fs';
import path from 'node:path';
import { researchArtifactPath } from '../src/polymarket-updown.mjs';

const A = researchArtifactPath();
const C = path.join(A, '15m-conditions');
const SPLIT = Date.UTC(2026, 6, 4, 4) / 1000;
const T = 150, FEE = 0.07, FUTURE = 0.01;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const pnl = (b) => (b.win ? 1 / b.price : 0) - 1 - FEE * (1 - b.price) - FUTURE;

// ---- BTC 1m candles: [open, high, low, close, volume, takerBuy] indexed by minute ----
const K = new Map();
for (const f of fs.readdirSync(path.join(C, 'klines')).sort())
  for (const k of JSON.parse(fs.readFileSync(path.join(C, 'klines', f), 'utf8'))) K.set(k[0], k);
const k = (sec) => K.get(sec);

// Features at decision time t for a bet on `side` in the round starting at `start`.
// Only candles that closed at or before floor(t/60)*60 are used.
function features(start, t, side) {
  const s = side === 'Up' ? 1 : -1;
  const last = Math.floor(t / 60) * 60 - 60; // last fully closed minute
  const rets = [], vols = [], day = [];
  for (let m = last - 59 * 60; m <= last; m += 60) { const c = k(m); if (!c) return null; rets.push(Math.log(c[4] / c[1])); }
  for (let m = last - 1439 * 60; m <= last; m += 60) { const c = k(m); if (c) day.push(c[5]); }
  if (day.length < 1200) return null;
  const vol60 = sd(rets) * 1e4; // bps per minute
  let v15 = 0, tb15 = 0;
  for (let m = last - 14 * 60; m <= last; m += 60) { const c = k(m); v15 += c[5]; tb15 += c[6]; }
  const roundOpen = k(start)?.[1], hourStart = Math.floor(start / 3600) * 3600, hourOpen = k(hourStart)?.[1];
  const close = k(last)[4];
  const pre60 = k(start - 3600)?.[1], pre15 = k(start - 900)?.[1];
  if (!roundOpen || !hourOpen || !pre60 || !pre15) return null;
  const et = (new Date((start - 4 * 3600) * 1000).getUTCHours()); // EDT (Apr–Oct)
  const lead = Math.log(close / roundOpen) * 1e4;
  return {
    etHour: et,
    session: et < 6 ? '00-06 ET' : et < 12 ? '06-12 ET' : et < 18 ? '12-18 ET' : '18-24 ET',
    quarter: `第${(start % 3600) / 900 + 1}刻`,
    vol60,
    volRatio: v15 / 15 / mean(day),
    takerFlow: s * (2 * tb15 / v15 - 1),
    trend60: s * Math.log(roundOpen / pre60) * 1e4,
    trend15: s * Math.log(roundOpen / pre15) * 1e4,
    leadZ: s * lead / (vol60 * Math.sqrt(2)),
    hourMove: s * Math.log(close / hourOpen) * 1e4,
  };
}

// ---- Historical bets: 15m favorite at +150s, 60–97¢, with the concurrent 1h favorite ----
const load = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => !r.missing && r.winner);
const r15 = load(path.join(A, 'weekend-favorite-timing/15m.jsonl'));
const r1h = new Map(load(path.join(A, 'weekend-favorite-timing/1h.jsonl')).map((r) => [r.start, r]));
function leanAt(round, t) {
  const rel = t - round.start, xs = [];
  for (const [s, u, p] of round.buys) { if (s >= rel) break; if (s >= rel - 60) xs.push(u ? p : 1 - p); }
  return xs.length ? median(xs.slice(-5)) : null;
}
const sideOf = (lean) => (lean == null || lean === 0.5 ? null : lean > 0.5 ? 'Up' : 'Down');
function vwap(buys, up, lo, hi) {
  let n = 0, s = 0;
  for (const [t, u, p, z] of buys) { if (t < lo) continue; if (t >= hi) break; if (u !== up) continue; n += p * z; s += z; }
  return s ? n / s : null;
}
const hist = [];
for (const r of r15) {
  const t = r.start + T, lean = leanAt(r, t), side = sideOf(lean);
  if (!side) continue;
  const q = Math.max(lean, 1 - lean);
  if (q < 0.6 || q > 0.97) continue;
  const up = side === 'Up' ? 1 : 0;
  const price = vwap(r.buys, up, T, T + 20) ?? vwap(r.buys, up, T, T + 60);
  if (price == null) continue;
  const hour = r1h.get(Math.floor(t / 3600) * 3600);
  const s1h = hour ? sideOf(leanAt(hour, t)) : null;
  const f = features(r.start, t, side);
  if (!f) continue;
  hist.push({ start: r.start, side, price, win: r.winner === side, counter: s1h != null && s1h !== side, set: r.start < SPLIT ? 'train' : 'test', ...f });
}

// ---- Live bets from the wallet ----
const trades = JSON.parse(fs.readFileSync(path.join(C, 'wallet-trades.json'), 'utf8'));
const outcomes = JSON.parse(fs.readFileSync(path.join(C, 'outcomes.json'), 'utf8'));
const live = [];
for (const tr of trades) {
  if (tr.side !== 'BUY' || !/^btc-updown-15m-\d+$/.test(tr.slug) || !outcomes[tr.slug]) continue;
  const start = +tr.slug.split('-').pop();
  const f = features(start, start + T, tr.outcome);
  if (!f) continue;
  const d = new Date(start * 1000).getUTCDay();
  live.push({ start, side: tr.outcome, price: tr.price, win: outcomes[tr.slug] === tr.outcome, counter: true, set: 'live', weekend: d === 0 || d === 6, ...f });
}

// ---- Reporting ----
const fmt = (bets) => {
  if (bets.length < 15) return `n ${String(bets.length).padStart(4)}`.padEnd(46);
  const p = bets.map(pnl), w = mean(bets.map((b) => +b.win)), pr = mean(bets.map((b) => b.price));
  return `n ${String(bets.length).padStart(4)} 胜${(100 * w).toFixed(1).padStart(5)}% 价${pr.toFixed(3)} 优势${(100 * (w - pr)).toFixed(1).padStart(5)} 每注${(100 * mean(p)).toFixed(1).padStart(6)}%`;
};
const tStat = (bets) => { const p = bets.map(pnl); return mean(p) / (sd(p) / Math.sqrt(p.length)); };
const tercile = (key, base) => { const xs = base.map((b) => b[key]).sort((x, y) => x - y); return [xs[Math.floor(xs.length / 3)], xs[Math.floor(2 * xs.length / 3)]]; };

const NUMERIC = { vol60: '60分钟波动(bp/分)', volRatio: '15分钟成交量/24h均值', takerFlow: '主动买卖偏向(顺方向)', trend60: '开盘前60分钟走势(顺方向bp)',
  trend15: '开盘前15分钟走势(顺方向bp)', leadZ: '本轮领先幅度(σ)', hourMove: '本小时至今走势(顺方向bp)', price: '买入价' };
const CATEGORY = { session: '时段(美东)', quarter: '在小时里的第几刻' };

function report(title, train, test, liveSet) {
  console.log(`\n=== ${title} ===`);
  console.log(`总体  训练 ${fmt(train)} | 验证 ${fmt(test)} | 实盘 ${fmt(liveSet)}`);
  const rows = [];
  const add = (label, pred) => {
    const a = train.filter(pred), b = test.filter(pred), c = liveSet.filter(pred);
    console.log(`  ${label.padEnd(26)} 训练 ${fmt(a)} | 验证 ${fmt(b)} | 实盘 ${fmt(c)}`);
    rows.push({ label, train: a, test: b, live: c });
  };
  for (const [key, name] of Object.entries(CATEGORY)) {
    console.log(` ${name}`);
    for (const v of [...new Set(train.map((x) => x[key]))].sort()) add(`${v}`, (x) => x[key] === v);
  }
  for (const [key, name] of Object.entries(NUMERIC)) {
    const [lo, hi] = tercile(key, train);
    console.log(` ${name}（三分位 ${lo.toFixed(2)} / ${hi.toFixed(2)}）`);
    add(`${key} 低`, (x) => x[key] < lo);
    add(`${key} 中`, (x) => x[key] >= lo && x[key] < hi);
    add(`${key} 高`, (x) => x[key] >= hi);
  }
  return rows;
}

const base = { train: hist.filter((b) => b.set === 'train'), test: hist.filter((b) => b.set === 'test') };
const counter = { train: base.train.filter((b) => b.counter), test: base.test.filter((b) => b.counter) };
console.log(`历史下注：全部热门 ${hist.length}（反 1 小时 ${hist.filter((b) => b.counter).length}）；实盘 ${live.length}（周末 ${live.filter((b) => b.weekend).length}）`);
const rowsBase = report('A. 全部 15 分钟热门（第150秒，60–97¢）', base.train, base.test, []);
const rowsCounter = report('B. 现策略：反 1 小时方向', counter.train, counter.test, live);

// A bucket counts as a candidate only if it beats its universe in BOTH train and test.
console.log('\n=== 候选条件：训练与验证都优于总体（每注收益），并检查实盘 ===');
for (const [name, rows, u, liveSet] of [['A', rowsBase, base, []], ['B', rowsCounter, counter, live]]) {
  const mt = mean(u.train.map(pnl)), ms = mean(u.test.map(pnl));
  for (const r of rows) {
    if (r.train.length < 40 || r.test.length < 40) continue;
    const dt = mean(r.train.map(pnl)) - mt, ds = mean(r.test.map(pnl)) - ms;
    if (dt > 0.01 && ds > 0.01)
      console.log(`${name} ${r.label.padEnd(16)} 训练 +${(100 * dt).toFixed(1)} (t ${tStat(r.train).toFixed(2)}) 验证 +${(100 * ds).toFixed(1)} (t ${tStat(r.test).toFixed(2)}) 实盘 ${r.live.length >= 15 ? `${(100 * (mean(r.live.map(pnl)) - mean(liveSet.map(pnl)))).toFixed(1)} vs 总体` : `n ${r.live.length}`}`);
  }
}
fs.writeFileSync(path.join(C, 'bets.json'), JSON.stringify({ hist, live }));
