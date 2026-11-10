// Weekly review of the live 15m strategy from the Future wallet's real buys (Beijing time week).
// Same per-$1 PnL model as the backtests: Polymarket taker fee 0.07*(1-p) and Future 1%.
// R1 went live on the idle machine with the 2026-10-22 21:00 CST round.
// Usage: node scripts/analyze-15m-week.mjs [weekStartCST=2026-10-19]
import fs from 'node:fs';
import path from 'node:path';
import { researchArtifactPath } from '../src/polymarket-updown.mjs';

const C = researchArtifactPath('15m-conditions');
const WEEK = Date.parse(`${process.argv[2] ?? '2026-10-19'}T00:00:00+08:00`) / 1000;
const R1_LIVE = Date.parse('2026-10-22T21:00:00+08:00') / 1000;
const FEE = 0.07, FUTURE = 0.01, VOL_MAX = 4.16;
const pnl = (b) => (b.win ? 1 / b.price : 0) - 1 - FEE * (1 - b.price) - FUTURE;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const cst = (t) => new Date((t + 8 * 3600) * 1000).toISOString();

const K = new Map();
for (const f of fs.readdirSync(path.join(C, 'klines'))) for (const k of JSON.parse(fs.readFileSync(path.join(C, 'klines', f), 'utf8'))) K.set(k[0], k);
const vol60 = (s) => { const r = []; for (let m = s + 60 - 59 * 60; m <= s + 60; m += 60) { const c = K.get(m); if (!c) return null; r.push(Math.log(c[4] / c[1])); } return sd(r) * 1e4; };

const trades = JSON.parse(fs.readFileSync(path.join(C, 'wallet-trades.json'), 'utf8'));
const outcomes = JSON.parse(fs.readFileSync(path.join(C, 'outcomes.json'), 'utf8'));
const bets = trades.filter((t) => t.side === 'BUY' && /^btc-updown-15m-\d+$/.test(t.slug)
  && +t.slug.split('-').pop() >= WEEK && +t.slug.split('-').pop() < WEEK + 7 * 86400)
  .map((t) => { const start = +t.slug.split('-').pop(); return { start, side: t.outcome, price: +t.price, usd: t.size * t.price,
    win: outcomes[t.slug] ? outcomes[t.slug] === t.outcome : null, entry: t.timestamp - start, vol: vol60(start) }; })
  .sort((a, b) => a.start - b.start);
const settled = bets.filter((b) => b.win != null);

const line = (label, bs) => {
  if (!bs.length) return console.log(`${label.padEnd(20)} 0 注`);
  const p = bs.map(pnl), w = mean(bs.map((b) => +b.win)), pr = mean(bs.map((b) => b.price));
  console.log(`${label.padEnd(20)} ${String(bs.length).padStart(3)} 注  胜 ${(100 * w).toFixed(1).padStart(5)}%  均价 ${pr.toFixed(3)}  胜率-价格 ${(100 * (w - pr)).toFixed(1).padStart(5)}  每注 ${(100 * mean(p)).toFixed(1).padStart(6)}%  合计 ${sum(p) >= 0 ? '+' : ''}$${sum(p).toFixed(2)}`);
};
console.log(`本周（北京时间 ${cst(WEEK).slice(0, 10)} 起，至 ${cst(WEEK + 7 * 86400).slice(0, 10)} 00:00 前）15 分钟盘买入 ${bets.length} 笔，已结算 ${settled.length}；入场时间 第${Math.min(...bets.map((b) => b.entry))}–${Math.max(...bets.map((b) => b.entry))} 秒`);
line('全部', settled);
line('R1 上线前', settled.filter((b) => b.start < R1_LIVE));
line('R1 上线后', settled.filter((b) => b.start >= R1_LIVE));
console.log('\n按天（北京时间）');
for (const d of [...new Set(settled.map((b) => cst(b.start).slice(0, 10)))]) line(`  ${d}`, settled.filter((b) => cst(b.start).slice(0, 10) === d));
console.log('\n按买入价');
for (const [lo, hi] of [[0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 0.98]]) line(`  ${lo.toFixed(2)}–${hi.toFixed(2)}`, settled.filter((b) => b.price >= lo && b.price < hi));
console.log('\n按时段（美东）');
for (const [lo, hi] of [[0, 6], [6, 12], [12, 18], [18, 24]]) line(`  ${String(lo).padStart(2, '0')}–${hi} ET`, settled.filter((b) => { const h = new Date((b.start - 4 * 3600) * 1000).getUTCHours(); return h >= lo && h < hi; }));
const pre = settled.filter((b) => b.start < R1_LIVE && b.vol != null);
console.log('\nR1 上线前的下注，若当时已有 R1（波动 >4.16 跳过）');
line('  R1 会保留', pre.filter((b) => b.vol <= VOL_MAX));
line('  R1 会跳过', pre.filter((b) => b.vol > VOL_MAX));
let bank = 0, peak = 0, dd = 0, run = 0, worst = 0;
for (const b of settled) { bank += pnl(b); peak = Math.max(peak, bank); dd = Math.max(dd, peak - bank); run = b.win ? 0 : run + 1; worst = Math.max(worst, run); }
console.log(`\n本周资金曲线：最终 ${bank >= 0 ? '+' : ''}$${bank.toFixed(2)}，最大回撤 $${dd.toFixed(2)}，最长连输 ${worst} 笔`);
console.log('\n逐笔（北京时间）');
for (const b of bets) console.log(`  ${cst(b.start).slice(5, 16).replace('T', ' ')}  买${b.side === 'Up' ? '涨' : '跌'} @${b.price.toFixed(2)}  波动 ${b.vol?.toFixed(2) ?? '—'}  ${b.win == null ? '待结算' : b.win ? '赢' : '输'}  ${b.win == null ? '' : (pnl(b) >= 0 ? '+' : '') + pnl(b).toFixed(2)}`);
