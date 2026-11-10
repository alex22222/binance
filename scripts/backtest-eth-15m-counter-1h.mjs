// The live 15m strategy (favorite at +150s, 60-97c, only against the concurrent 1h favorite, R1
// high-volatility skip) backtested on another coin, next to the BTC weekend backtest.
// Data: fetch-eth-updown-rounds.mjs (all days 2026-04-04..10-20) and the BTC weekend set.
// Usage: ASSET=eth|xrp|sol node scripts/backtest-eth-15m-counter-1h.mjs
import fs from 'node:fs';
import path from 'node:path';
import { isEtWeekend, researchArtifactPath } from '../src/polymarket-updown.mjs';

const A = researchArtifactPath();
const ASSET = process.env.ASSET ?? 'eth', COIN = ASSET.toUpperCase(), DIR = path.join(A, `${ASSET}-updown`);
const T = 150, FEE = 0.07, FUTURE = 0.01, BANK = 100, DAYS = 30, SIMS = 10000;
const TRAIN_END = Date.UTC(2026, 6, 4, 4) / 1000, BTC_END = Date.UTC(2026, 9, 5, 4) / 1000;
const pnl = (b) => (b.win ? 1 / b.price : 0) - 1 - FEE * (1 - b.price) - FUTURE;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const etDay = (t) => new Date((t - 4 * 3600) * 1000).toISOString().slice(0, 10);
let seed = 5;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function klines(dir) {
  const K = new Map();
  for (const f of fs.readdirSync(dir).sort()) for (const k of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) K.set(k[0], k);
  return K;
}
// R1 volatility exactly as the live code: stdev of ln(close/open) over the 60 candles ending at start+60.
function vol60(K, start) {
  const r = [];
  for (let m = start + 60 - 59 * 60; m <= start + 60; m += 60) { const c = K.get(m); if (!c) return null; r.push(Math.log(c[4] / c[1])); }
  return sd(r) * 1e4;
}
const load = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => !r.missing && r.winner);
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
function bets(dir, K, BK) {
  const r15 = load(path.join(dir, '15m.jsonl')), r1h = new Map(load(path.join(dir, '1h.jsonl')).map((r) => [r.start, r]));
  const out = [];
  for (const r of r15) {
    const t = r.start + T, lean = leanAt(r, t), side = sideOf(lean);
    if (!side) continue;
    const fav = Math.max(lean, 1 - lean);
    if (fav < 0.6 || fav > 0.97) continue;
    const up = side === 'Up' ? 1 : 0, price = vwap(r.buys, up, T, T + 20) ?? vwap(r.buys, up, T, T + 60);
    if (price == null) continue;
    const hour = r1h.get(Math.floor(t / 3600) * 3600), s1h = hour ? sideOf(leanAt(hour, t)) : null;
    if (!s1h || s1h === side) continue; // only against the concurrent 1h favorite
    out.push({ start: r.start, side, price, win: r.winner === side, weekend: isEtWeekend(r.start), vol: vol60(K, r.start), btcVol: vol60(BK, r.start) });
  }
  return out.filter((b) => b.vol != null).sort((a, b) => a.start - b.start);
}

const BK = klines(path.join(A, '15m-conditions', 'klines'));
const eth = bets(DIR, klines(path.join(DIR, 'klines')), BK);
const btc = bets(path.join(A, 'weekend-favorite-timing'), BK, BK);
const cutOf = (xs) => q(xs.filter((b) => b.weekend && b.start < TRAIN_END).map((b) => b.vol), 2 / 3);
const ETH_CUT = cutOf(eth), BTC_CUT = 4.16;
console.log(`${COIN} 反 1 小时下注 ${eth.length} 注（周末 ${eth.filter((b) => b.weekend).length}）；${COIN} 训练期波动上三分位 ${ETH_CUT.toFixed(2)} bp/分（BTC 为 4.16）`);

const line = (bs) => {
  if (bs.length < 15) return `n ${bs.length}`.padEnd(44);
  const p = bs.map(pnl), m = mean(p);
  return `${String(bs.length).padStart(4)}注 胜${(100 * mean(bs.map((b) => +b.win))).toFixed(1).padStart(5)}% 价${mean(bs.map((b) => b.price)).toFixed(3)} 每注${(100 * m).toFixed(2).padStart(6)}% t${(m / (sd(p) / Math.sqrt(p.length))).toFixed(2).padStart(5)}`;
};
const RULES = {
  '不过滤': () => true,
  'R1·自身阈值': (b) => b.vol <= ETH_CUT,
  'R1·用 BTC 的 4.16': (b) => b.vol <= BTC_CUT,
  'R1·按 BTC 波动（与实盘同一数据）': (b) => Number.isFinite(b.btcVol) && b.btcVol <= BTC_CUT,
};
const SETS = {
  '周末 4–6 月（训练）': (b) => b.weekend && b.start < TRAIN_END,
  '周末 7–10/4（验证）': (b) => b.weekend && b.start >= TRAIN_END && b.start < BTC_END,
  '工作日 4–10/4': (b) => !b.weekend && b.start < BTC_END,
  '10/5 之后全部日子': (b) => b.start >= BTC_END,
};
console.log(`\n=== ${COIN} ===`);
for (const [rule, keep] of Object.entries(RULES)) {
  console.log(`\n${rule}`);
  for (const [name, f] of Object.entries(SETS)) console.log(`  ${name.padEnd(18)} ${line(eth.filter((b) => f(b) && keep(b)))}`);
}
console.log('\n=== BTC 对照（周末） ===');
for (const [rule, keep] of [['不过滤', () => true], ['R1 4.16（现策略）', (b) => b.vol <= BTC_CUT]])
  for (const [name, f] of Object.entries(SETS).slice(0, 2)) console.log(`  ${rule.padEnd(12)} ${name.padEnd(18)} ${line(btc.filter((b) => f(b) && keep(b)))}`);

// Keep the observed pre-R1 date universe, including days where this rule makes no bets.
function month(bs, label, keep = () => true) {
  const byDay = new Map(bs.map((b) => [etDay(b.start), []]));
  for (const b of bs.filter(keep)) byDay.get(etDay(b.start)).push(pnl(b));
  const days = [...byDay.values()], res = [];
  if (!days.length) return void console.log(`${label}: 无可用样本日，无法估算`);
  for (let s = 0; s < SIMS; s++) {
    let bank = BANK, peak = BANK, dd = 0, n = 0;
    for (let d = 0; d < DAYS; d++) for (const p of days[Math.floor(rand() * days.length)]) { bank += p; n++; peak = Math.max(peak, bank); dd = Math.max(dd, peak - bank); }
    res.push({ profit: bank - BANK, dd, n });
  }
  const P = res.map((r) => r.profit);
  console.log(`${label.padEnd(28)} ${days.length}个样本日 每月约${Math.round(mean(res.map((r) => r.n)))}注  平均 ${mean(P) >= 0 ? '+' : ''}$${mean(P).toFixed(1)}  90%区间 [$${q(P, 0.05).toFixed(1)}, $${q(P, 0.95).toFixed(1)}]  亏损月 ${(100 * mean(P.map((p) => +(p < 0)))).toFixed(0)}%  回撤中位 $${q(res.map((r) => r.dd), 0.5).toFixed(1)}`);
}
console.log('\n=== $100 本金、每注 $1、30 个样本日重抽样（非自然月；无源数据的日期不补零） ===');
for (const [rule, keep] of Object.entries(RULES)) month(eth, `${COIN} ${rule}`, keep);
month(eth.filter((b) => b.start >= TRAIN_END), `${COIN} R1自身阈值·只用样本外`, (b) => b.vol <= ETH_CUT);

// Running BTC and ETH together: are the same round's results correlated?
const ethBy = new Map(eth.filter((b) => b.vol <= ETH_CUT).map((b) => [b.start, b]));
const pairs = btc.filter((b) => b.vol <= BTC_CUT && ethBy.has(b.start)).map((b) => [pnl(b), pnl(ethBy.get(b.start))]);
if (pairs.length > 30) {
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  const cov = mean(pairs.map(([x, y]) => (x - mx) * (y - my))), r = cov / (sd(pairs.map((p) => p[0])) * sd(pairs.map((p) => p[1])));
  const same = mean(pairs.map(([x, y]) => +((x > 0) === (y > 0))));
  console.log(`\n同一轮 BTC 与 ${COIN} 都下注：${pairs.length} 轮，盈亏相关系数 ${r.toFixed(2)}，同赢同输比例 ${(100 * same).toFixed(0)}%`);
}
fs.writeFileSync(path.join(DIR, 'bets.json'), JSON.stringify({ bets: eth, cut: ETH_CUT }));
