// Evaluate a few fixed skip rules for the 15m counter-1h strategy on bets.json from
// analyze-15m-conditions.mjs. Cut points are training-period terciles of the counter-1h bets.
// Reports per-bet and total results, a bootstrap 90% interval of the per-bet gain on
// validation+live, and a permutation p-value (random skips of the same count).
import fs from 'node:fs';
import path from 'node:path';
import { researchArtifactPath } from '../src/polymarket-updown.mjs';

const C = researchArtifactPath('15m-conditions');
const { hist, live } = JSON.parse(fs.readFileSync(path.join(C, 'bets.json'), 'utf8'));
const FEE = 0.07, FUTURE = 0.01;
const pnl = (b) => (b.win ? 1 / b.price : 0) - 1 - FEE * (1 - b.price) - FUTURE;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sum = (a) => a.reduce((x, y) => x + y, 0);
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const counter = hist.filter((b) => b.counter);
const train = counter.filter((b) => b.set === 'train'), test = counter.filter((b) => b.set === 'test');
const cut = (key, q) => { const xs = train.map((b) => b[key]).sort((x, y) => x - y); return xs[Math.floor(q * xs.length)]; };
const VOL_HI = cut('vol60', 2 / 3), VOL_LO = cut('vol60', 1 / 3), TREND_HI = cut('trend15', 2 / 3), FLOW_HI = cut('takerFlow', 2 / 3);
console.log(`训练期分界：波动 ${VOL_LO.toFixed(2)} / ${VOL_HI.toFixed(2)} bp/分；开盘前15分钟顺向走势 ${TREND_HI.toFixed(2)} bp；主动买入偏向 ${FLOW_HI.toFixed(2)}`);

const RULES = {
  '现策略（不过滤）': () => true,
  'R1 跳过高波动': (b) => b.vol60 < VOL_HI,
  'R2 跳过“追涨杀跌”（开盘前15分钟已顺向走）': (b) => b.trend15 < TREND_HI,
  'R3 跳过主动买盘已顺向偏多': (b) => b.takerFlow < FLOW_HI,
  'R1+R2': (b) => b.vol60 < VOL_HI && b.trend15 < TREND_HI,
  'R1+R2+R3': (b) => b.vol60 < VOL_HI && b.trend15 < TREND_HI && b.takerFlow < FLOW_HI,
  '只做中等波动': (b) => b.vol60 >= VOL_LO && b.vol60 < VOL_HI,
};

const line = (bets, all) => {
  const p = bets.map(pnl);
  return `${String(bets.length).padStart(4)}/${String(all.length).padEnd(4)} 胜${(100 * mean(bets.map((b) => +b.win))).toFixed(1).padStart(5)}% 每注${(100 * mean(p)).toFixed(1).padStart(5)}% 合计${sum(p).toFixed(1).padStart(6)}`;
};
// Gain of the kept bets over all bets in the same set, plus resampling checks.
function check(keep, sets) {
  const all = sets.flat(), kept = all.filter(keep), skip = all.length - kept.length;
  const gain = mean(kept.map(pnl)) - mean(all.map(pnl));
  const boots = [];
  for (let i = 0; i < 2000; i++) {
    const s = Array.from({ length: all.length }, () => all[Math.floor(rand() * all.length)]);
    const k = s.filter(keep);
    if (k.length) boots.push(mean(k.map(pnl)) - mean(s.map(pnl)));
  }
  boots.sort((x, y) => x - y);
  let beat = 0;
  const p = all.map(pnl);
  for (let i = 0; i < 2000; i++) {
    const idx = new Set();
    while (idx.size < skip) idx.add(Math.floor(rand() * all.length));
    const g = mean(p.filter((_, j) => !idx.has(j))) - mean(p);
    if (g >= gain) beat++;
  }
  return `提升 ${(100 * gain).toFixed(1).padStart(5)}/注  90%区间 [${(100 * boots[100]).toFixed(1)}, ${(100 * boots[1899]).toFixed(1)}]  随机跳过同样多次能达到的概率 p=${(beat / 2000).toFixed(3)}`;
}

console.log(`\n${'规则'.padEnd(34)} ${'训练 (保留/全部, 胜率, 每注, 合计$)'.padEnd(48)} ${'验证'.padEnd(48)} 实盘`);
for (const [name, keep] of Object.entries(RULES))
  console.log(`${name.padEnd(30)} ${line(train.filter(keep), train)} | ${line(test.filter(keep), test)} | ${line(live.filter(keep), live)}`);

console.log('\n样本外检验（验证期 + 实盘，分界只来自训练期）：');
for (const [name, keep] of Object.entries(RULES).slice(1))
  console.log(`${name.padEnd(30)} ${check(keep, [test, live])}`);

// Same rules on the plain 15m favorite (no 1h filter), as a robustness check on 3x more bets.
const base = hist, bt = base.filter((b) => b.set === 'train'), bv = base.filter((b) => b.set === 'test');
console.log('\n稳健性：同样分界套到全部 15 分钟热门（不看 1 小时）：');
for (const [name, keep] of Object.entries(RULES))
  console.log(`${name.padEnd(30)} 训练 ${line(bt.filter(keep), bt)} | 验证 ${line(bv.filter(keep), bv)}`);

// Live bets by weekday/weekend and by hour-of-day (ET), descriptive only.
console.log('\n实盘按周末/工作日：');
for (const [n, f] of [['周末', (b) => b.weekend], ['工作日', (b) => !b.weekend]]) console.log(`  ${n} ${line(live.filter(f), live)}`);
