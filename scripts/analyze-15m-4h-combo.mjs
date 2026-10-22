// Running the 15m counter-1h strategy and the 4h high-confidence strategy together on weekends.
// 15m: at +150s buy the 15m favorite (60-97c) only when the concurrent 1h favorite is the other side.
// 4h:  first 5-minute checkpoint where the price model says >=95% and beats the market by >=3c.
// Both: $1 per bet, Polymarket taker fee and Future 1%. Common sample: weekends 2026-04-04..2026-10-04.
import fs from 'node:fs';
import { researchArtifactPath } from '../src/polymarket-updown.mjs';

const A = researchArtifactPath();
const load = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => !r.missing && r.winner);
const r15 = load(`${A}/weekend-favorite-timing/15m.jsonl`);
const r1h = new Map(load(`${A}/weekend-favorite-timing/1h.jsonl`).map((r) => [r.start, r]));
const END = Date.UTC(2026, 9, 5, 4) / 1000;
const SPLIT = Date.UTC(2026, 6, 1) / 1000;
const FEE = 0.07, FUTURE = 0.01;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

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

// 15m counter-1h bets.
const bets15 = [];
for (const r of r15) {
  if (r.start >= END) continue;
  const T = 150, t = r.start + T;
  const lean = leanAt(r, t), side = sideOf(lean);
  if (!side) continue;
  const q = Math.max(lean, 1 - lean);
  if (q < 0.6 || q > 0.97) continue;
  const hour = r1h.get(Math.floor(t / 3600) * 3600);
  const hourSide = sideOf(hour && leanAt(hour, t));
  if (!hourSide || hourSide === side) continue;
  const up = side === 'Up' ? 1 : 0;
  const price = vwap(r.buys, up, T, T + 20) ?? vwap(r.buys, up, T, T + 60);
  if (price == null) continue;
  const win = r.winner === side;
  bets15.push({ k: '15m', t, start: r.start, side, price, win, pnl: (win ? 1 / price : 0) - 1 - FEE * (1 - price) - FUTURE });
}

// 4h candidate bets (weekend, same date range); `raw` is actual-fill PnL before Future's fee.
const bets4 = JSON.parse(fs.readFileSync(`${A}/4h-research/candidate-bets.json`, 'utf8'))
  .filter((b) => b.weekend && b.start < END)
  .map((b) => ({ k: '4h', t: b.start + b.m * 60, start: b.start, side: b.up ? 'Up' : 'Down', price: b.price, win: b.win,
    pnl: b.raw - FUTURE, conservative: b.pnl }));

function line(name, bets, key = 'pnl') {
  const p = bets.map((b) => b[key]);
  const m = mean(p);
  const h1 = bets.filter((b) => b.start < SPLIT).map((b) => b[key]);
  const h2 = bets.filter((b) => b.start >= SPLIT).map((b) => b[key]);
  console.log(`| ${name} | ${bets.length} | ${(100 * mean(bets.map((b) => +b.win))).toFixed(1)}% | ${pct(m)} | ${(m / (sd(p) / Math.sqrt(p.length))).toFixed(2)} | ${pct(mean(h1))} | ${pct(mean(h2))} | $${p.reduce((a, b) => a + b, 0).toFixed(2)} |`);
}
console.log('| 策略 | 注数 | 胜率 | 每注收益 | t | 4–6 月 | 7–10 月 | 累计（每注 $1） |\n|---|---|---|---|---|---|---|---|');
line('15m 反 1h', bets15);
line('4h 高把握（实际成交价）', bets4);
line('4h 高把握（保守成交价）', bets4, 'conservative');
const both = [...bets15, ...bets4].sort((a, b) => a.t - b.t);
line('合并（4h 用实际成交价）', both);
line('合并（4h 用保守成交价）', both.map((b) => ({ ...b, pnl: b.k === '4h' ? b.conservative : b.pnl })));

// Per-weekend PnL and correlation.
const byWeek = new Map();
for (const b of both) { const w = Math.floor((b.t - 4 * 3600) / (7 * 86400)); const e = byWeek.get(w) ?? { '15m': 0, '4h': 0 }; e[b.k] += b.pnl; byWeek.set(w, e); }
const wk = [...byWeek.values()];
const x = wk.map((e) => e['15m']), y = wk.map((e) => e['4h']);
const corr = mean(x.map((v, i) => (v - mean(x)) * (y[i] - mean(y)))) / (sd(x) * sd(y)) * (x.length - 1) / x.length;
const total = wk.map((e) => e['15m'] + e['4h']);
console.log(`\n周末数 ${wk.length}；每周末盈亏相关系数 ${corr.toFixed(2)}；每周末平均：15m $${mean(x).toFixed(2)}、4h $${mean(y).toFixed(2)}、合并 $${mean(total).toFixed(2)}；亏损周末：15m ${x.filter((v) => v < 0).length}、4h ${y.filter((v) => v < 0).length}、合并 ${total.filter((v) => v < 0).length}`);
for (const [name, bets] of [['15m', bets15], ['4h', bets4], ['合并', both]]) {
  let eq = 0, pk = 0, dd = 0;
  for (const b of bets) { eq += b.pnl; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); }
  console.log(`${name}: 最大回撤 $${dd.toFixed(2)}`);
}

// Same 4h round: does the 15m bet agree with the 4h bet?
let same = 0, opposite = 0, sameWin = [], oppWin = [];
for (const b4 of bets4) {
  for (const b of bets15.filter((b) => b.t >= b4.start && b.t < b4.start + 14400)) {
    if (b.side === b4.side) { same++; sameWin.push(b.pnl); } else { opposite++; oppWin.push(b.pnl); }
  }
}
console.log(`\n4h 下注所在的 4 小时内的 15m 下注：同向 ${same} 注（每注 ${pct(mean(sameWin))}），反向 ${opposite} 注（每注 ${pct(mean(oppWin))}）`);
// Timing conflicts on the single Future page: 15m entry [+150,+170) vs 4h decision + 2-minute fill window.
const clash = bets4.filter((b) => { const q = (b.t - b.start) % 900; return q < 170 && q + 120 > 150; }).length;
console.log(`4h 触发时间与 15m 下单窗口（每刻钟 +150–170 秒）重叠：${clash}/${bets4.length}`);
console.log(`每个周末平均：15m ${(bets15.length / wk.length).toFixed(1)} 注、4h ${(bets4.length / wk.length).toFixed(1)} 注`);

// Only 15m bets placed after the 4h signal fired (no lookahead): agree vs disagree with the 4h side.
const after = { same: [], opposite: [], before: [] };
for (const b4 of bets4) {
  for (const b of bets15.filter((b) => b.t >= b4.start && b.t < b4.start + 14400)) {
    if (b.t < b4.t) after.before.push(b);
    else (b.side === b4.side ? after.same : after.opposite).push(b);
  }
}
console.log('\n| 15m 下注（与 4h 信号同一轮） | 注数 | 胜率 | 每注收益 | t | 4–6 月 | 7–10 月 | 累计 |\n|---|---|---|---|---|---|---|---|');
line('4h 信号之前', after.before);
line('4h 信号之后，与 4h 同向', after.same);
line('4h 信号之后，与 4h 反向', after.opposite);
const filtered = bets15.filter((b) => !after.opposite.includes(b));
line('15m 全部，但剔除 4h 信号后反向的', filtered);
