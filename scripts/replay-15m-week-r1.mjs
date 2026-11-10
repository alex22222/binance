// This week's 15m counter-1h strategy replayed round by round from real taker trades, with and
// without R1, next to the wallet's actual buys. Same rules and PnL model as the backtests.
// Data: fetch-eth-updown-rounds.mjs with ASSET=btc OUT_DIR=btc-week-20261019, klines and wallet
// trades from fetch-15m-conditions-data.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { researchArtifactPath } from '../src/polymarket-updown.mjs';

const A = researchArtifactPath();
const DIR = path.join(A, process.env.WEEK_DIR ?? 'btc-week-20261019'), C = path.join(A, '15m-conditions');
const WEEK = Date.parse('2026-10-19T00:00:00+08:00') / 1000, R1_LIVE = Date.parse('2026-10-22T21:00:00+08:00') / 1000;
const T = 150, FEE = 0.07, FUTURE = 0.01, VOL_MAX = 4.16;
const pnl = (b) => (b.win ? 1 / b.price : 0) - 1 - FEE * (1 - b.price) - FUTURE;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const cst = (t) => new Date((t + 8 * 3600) * 1000).toISOString();

const K = new Map();
for (const f of fs.readdirSync(path.join(C, 'klines'))) for (const k of JSON.parse(fs.readFileSync(path.join(C, 'klines', f), 'utf8'))) K.set(k[0], k);
const vol60 = (s) => { const r = []; for (let m = s + 60 - 59 * 60; m <= s + 60; m += 60) { const c = K.get(m); if (!c) return null; r.push(Math.log(c[4] / c[1])); } return sd(r) * 1e4; };
const load = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').trim().split('\n').map(JSON.parse).filter((r) => !r.missing && r.winner);
const leanAt = (round, t) => { const rel = t - round.start, xs = []; for (const [s, u, p] of round.buys) { if (s >= rel) break; if (s >= rel - 60) xs.push(u ? p : 1 - p); } return xs.length ? median(xs.slice(-5)) : null; };
const sideOf = (l) => (l == null || l === 0.5 ? null : l > 0.5 ? 'Up' : 'Down');
const vwap = (buys, up, lo, hi) => { let n = 0, s = 0; for (const [t, u, p, z] of buys) { if (t < lo) continue; if (t >= hi) break; if (u !== up) continue; n += p * z; s += z; } return s ? n / s : null; };

const r1h = new Map(load('1h.jsonl').map((r) => [r.start, r]));
const sim = [];
for (const r of load('15m.jsonl').filter((r) => r.start >= WEEK).sort((a, b) => a.start - b.start)) {
  const t = r.start + T, lean = leanAt(r, t), side = sideOf(lean);
  if (!side) continue;
  const fav = Math.max(lean, 1 - lean);
  if (fav < 0.6 || fav > 0.97) continue;
  const up = side === 'Up' ? 1 : 0, price = vwap(r.buys, up, T, T + 20) ?? vwap(r.buys, up, T, T + 60);
  if (price == null) continue;
  const hour = r1h.get(Math.floor(t / 3600) * 3600), s1h = hour ? sideOf(leanAt(hour, t)) : null;
  if (!s1h || s1h === side) continue;
  sim.push({ start: r.start, side, price, win: r.winner === side, vol: vol60(r.start) });
}

const trades = JSON.parse(fs.readFileSync(path.join(C, 'wallet-trades.json'), 'utf8'));
const outcomes = JSON.parse(fs.readFileSync(path.join(C, 'outcomes.json'), 'utf8'));
const live = trades.filter((t) => t.side === 'BUY' && /^btc-updown-15m-\d+$/.test(t.slug) && +t.slug.split('-').pop() >= WEEK && outcomes[t.slug])
  .map((t) => ({ start: +t.slug.split('-').pop(), side: t.outcome, price: +t.price, win: outcomes[t.slug] === t.outcome, vol: vol60(+t.slug.split('-').pop()) }));

const line = (label, bs) => {
  if (!bs.length) return console.log(`${label.padEnd(26)}   0 注`);
  const p = bs.map(pnl), w = mean(bs.map((b) => +b.win)), pr = mean(bs.map((b) => b.price));
  console.log(`${label.padEnd(26)} ${String(bs.length).padStart(3)} 注  胜 ${(100 * w).toFixed(1).padStart(5)}%  均价 ${pr.toFixed(3)}  胜率-价格 ${(100 * (w - pr)).toFixed(1).padStart(5)}  每注 ${(100 * mean(p)).toFixed(1).padStart(6)}%  合计 ${sum(p) >= 0 ? '+' : ''}$${sum(p).toFixed(2)}`);
};
const keep = (b) => b.vol != null && b.vol <= VOL_MAX;
console.log(`本周（北京时间 10-19 起）回放：反 1 小时下注 ${sim.length} 轮（其中波动 >4.16 的 ${sim.filter((b) => !keep(b)).length} 轮）\n`);
console.log('== 回放：同一周、同一规则，只差 R1 ==');
line('不加 R1（全部下注）', sim);
line('加 R1（跳过高波动）', sim.filter(keep));
line('  R1 跳过的那部分', sim.filter((b) => !keep(b)));
console.log('\n分段');
for (const [name, f] of [['R1 上线前（周一至周四 21:00）', (b) => b.start < R1_LIVE], ['R1 上线后', (b) => b.start >= R1_LIVE]]) {
  line(`${name} 不加 R1`, sim.filter(f));
  line(`${name} 加 R1`, sim.filter((b) => f(b) && keep(b)));
}
console.log('\n按天：不加 R1 → 加 R1（合计 $）');
for (const d of [...new Set(sim.map((b) => cst(b.start).slice(0, 10)))]) {
  const all = sim.filter((b) => cst(b.start).slice(0, 10) === d), k = all.filter(keep);
  console.log(`  ${d}  ${String(all.length).padStart(2)} 注 ${sum(all.map(pnl)) >= 0 ? '+' : ''}${sum(all.map(pnl)).toFixed(2).padStart(6)}  →  ${String(k.length).padStart(2)} 注 ${sum(k.map(pnl)) >= 0 ? '+' : ''}${sum(k.map(pnl)).toFixed(2).padStart(6)}`);
}
console.log('\n== 实盘 ==');
line('实盘全部', live);
line('实盘 R1 上线前', live.filter((b) => b.start < R1_LIVE));
line('实盘 R1 上线后', live.filter((b) => b.start >= R1_LIVE));

// How well the replay matches what the live system actually did.
const simBy = new Map(sim.map((b) => [b.start, b])), liveBy = new Map(live.map((b) => [b.start, b]));
const both = live.filter((b) => simBy.has(b.start)), sameSide = both.filter((b) => simBy.get(b.start).side === b.side);
const simOnly = (f) => sim.filter((b) => f(b) && !liveBy.has(b.start));
console.log(`\n== 回放与实盘对照 ==\n实盘 ${live.length} 笔里，回放也下注的 ${both.length} 笔（同方向 ${sameSide.length}），回放没下注的 ${live.length - both.length} 笔`);
console.log(`回放应下注、实盘没下的：R1 上线前 ${simOnly((b) => b.start < R1_LIVE).length} 轮；R1 上线后（且 R1 放行）${simOnly((b) => b.start >= R1_LIVE && keep(b)).length} 轮`);
const diff = both.map((b) => b.price - simBy.get(b.start).price);
if (diff.length) console.log(`同一轮实盘成交价 − 回放成交价：平均 ${(100 * mean(diff)).toFixed(1)}¢`);
line('只有实盘下注的轮次', live.filter((b) => !simBy.has(b.start)));
line('只有回放下注的轮次（不分 R1）', sim.filter((b) => !liveBy.has(b.start)));
line('两边都下注的轮次（实盘结果）', both);

// Rounds the replay would buy (R1 permitting) that the live system did not: what the market showed.
const r15by = new Map(load('15m.jsonl').map((r) => [r.start, r]));
const missed = sim.filter((b) => !liveBy.has(b.start) && (b.start < R1_LIVE || keep(b)));
console.log(`\n== 漏单 ${missed.length} 轮：盘面诊断（北京时间） ==`);
console.log('时间         方向 热门@150 回放成交  窗口内热门 最低/最高  1h热门@150  波动   结果');
for (const b of missed) {
  const r = r15by.get(b.start), up = b.side === 'Up' ? 1 : 0;
  const px = r.buys.filter(([t, u]) => t >= T && t < T + 20 && u === up).map(([, , p]) => p);
  const l1 = leanAt(r1h.get(Math.floor((b.start + T) / 3600) * 3600), b.start + T);
  const fav = Math.max(leanAt(r, b.start + T), 1 - leanAt(r, b.start + T));
  console.log(`${cst(b.start).slice(5, 16).replace('T', ' ')}  ${b.side === 'Up' ? '涨' : '跌'}   ${(100 * fav).toFixed(0).padStart(3)}¢     ${(100 * b.price).toFixed(1).padStart(5)}¢   ${px.length ? `${(100 * Math.min(...px)).toFixed(0)}¢/${(100 * Math.max(...px)).toFixed(0)}¢` : '无成交'}`.padEnd(60) +
    `   ${(100 * Math.max(l1, 1 - l1)).toFixed(0)}¢（${l1 > 0.5 ? '涨' : '跌'}）  ${b.vol.toFixed(2)}  ${b.win ? '赢' : '输'}`);
}
fs.writeFileSync(path.join(DIR, 'missed-rounds.json'), JSON.stringify(missed.map((b) => b.start)));
