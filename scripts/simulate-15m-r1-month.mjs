// One month of the live 15m strategy (counter-1h + R1 volatility skip), $1 per bet, $100 bankroll.
// Historical days: the weekend 15m/1h backtest (2026-04-04 .. 10-05) via bets.json from
// analyze-15m-conditions.mjs; a window = 30 observed sample dates, not a calendar month.
// Live wallet bets are shown alongside. Dates absent from the source are not assumed to be zero-bet days.
import fs from 'node:fs';
import path from 'node:path';
import { researchArtifactPath } from '../src/polymarket-updown.mjs';

const C = researchArtifactPath('15m-conditions');
const { hist, live } = JSON.parse(fs.readFileSync(path.join(C, 'bets.json'), 'utf8'));
const FEE = 0.07, FUTURE = 0.01, VOL_MAX = 4.16, BANK = 100, DAYS = 30, SIMS = 10000;
const pnl = (b) => (b.win ? 1 / b.price : 0) - 1 - FEE * (1 - b.price) - FUTURE;
const etDay = (t) => new Date((t - 4 * 3600) * 1000).toISOString().slice(0, 10);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
let seed = 11;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// Path of a month: final profit, worst drawdown from a running peak, lowest bankroll.
function run(days) {
  let bank = BANK, peak = BANK, dd = 0, low = BANK, n = 0;
  for (const day of days) for (const p of day) { bank += p; n++; peak = Math.max(peak, bank); dd = Math.max(dd, peak - bank); low = Math.min(low, bank); }
  return { profit: bank - BANK, dd, low, n };
}
function summary(name, results) {
  if (!results.length) return void console.log(`${name.padEnd(30)} 样本不足，无法估算`);
  const P = results.map((r) => r.profit);
  console.log(`${name.padEnd(30)} 每月注数 ${Math.round(mean(results.map((r) => r.n))).toString().padStart(4)}  ` +
    `平均 ${mean(P) >= 0 ? '+' : ''}$${mean(P).toFixed(1)}  中位 $${q(P, 0.5).toFixed(1)}  ` +
    `90%区间 [$${q(P, 0.05).toFixed(1)}, $${q(P, 0.95).toFixed(1)}]  亏损月 ${(100 * mean(P.map((p) => +(p < 0)))).toFixed(0)}%  ` +
    `最大回撤中位 $${q(results.map((r) => r.dd), 0.5).toFixed(1)}（最差5% $${q(results.map((r) => r.dd), 0.95).toFixed(1)}）  最低余额(最差1%) $${q(results.map((r) => r.low), 0.01).toFixed(1)}`);
}

for (const [label, keep] of [['反 1 小时（不过滤）', () => true], ['反 1 小时 + R1（现策略）', (b) => b.vol60 <= VOL_MAX]]) {
  const bets = hist.filter((b) => b.counter && keep(b)).sort((a, b) => a.start - b.start);
  const byDay = new Map([...new Set(hist.map((b) => etDay(b.start)))].sort().map((d) => [d, []]));
  for (const b of bets) byDay.get(etDay(b.start)).push(pnl(b));
  const days = [...byDay.values()];
  if (!days.length) { console.log(`\n# ${label}：无可用样本日，无法估算`); continue; }
  console.log(`\n# ${label}：历史 ${bets.length} 注 / ${days.length} 个样本日，每日 ${(bets.length / days.length).toFixed(1)} 注，每注 ${bets.length ? (100 * mean(bets.map(pnl))).toFixed(2) + '%' : '未知（无下注）'}`);
  console.log('30 个样本日不等于自然月；无源数据的日期不补零。');
  const rolling = [];
  for (let i = 0; i + DAYS <= days.length; i++) rolling.push(run(days.slice(i, i + DAYS)));
  summary('历史连续30个样本日（滚动窗口）', rolling);
  const boot = [];
  for (let s = 0; s < SIMS; s++) boot.push(run(Array.from({ length: DAYS }, () => days[Math.floor(rand() * days.length)])));
  summary('按样本日重抽样（1万次）', boot);
  // Split halves: does the result depend on which months you happen to run?
  const half = (f) => { const ds = days.filter((_, i) => f(i)); const r = []; if (!ds.length) return r; for (let s = 0; s < SIMS; s++) r.push(run(Array.from({ length: DAYS }, () => ds[Math.floor(rand() * ds.length)]))); return r; };
  summary('  只用前半段样本日', half((i) => i < days.length / 2));
  summary('  只用后半段样本日', half((i) => i >= days.length / 2));
}

// Live wallet bets (all days): rate and per-bet result, with and without R1.
const liveDays = new Set(live.map((b) => etDay(b.start))).size;
for (const [label, keep] of [['实盘（不过滤）', () => true], ['实盘若加 R1', (b) => b.vol60 <= VOL_MAX]]) {
  if (!liveDays) { console.log(`\n${label}：无可用样本日，无法估算`); continue; }
  const bets = live.filter(keep), perDay = bets.length / liveDays, per = mean(bets.map(pnl));
  const projected = bets.map(pnl).reduce((a, b) => a + b, 0) / liveDays * DAYS;
  console.log(`\n${label}：${bets.length} 注 / ${liveDays} 个样本日，每日 ${perDay.toFixed(1)} 注，每注 ${bets.length ? (100 * per).toFixed(2) + '%' : '未知（无下注）'} → 按此推算 30 个样本日约 ${Math.round(perDay * DAYS)} 注、${projected >= 0 ? '+' : ''}$${projected.toFixed(1)}`);
}
