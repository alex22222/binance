// Robustness of the one component that replicated: the slow moving-average regime.
// Every variant is printed; the plain 200-day rule was fixed before this run.
import { btcTrendHistory } from "../../src/btc-trend.mjs";
import { at, dayIndex, days, mean, median, pct, price } from "./data.mjs";

const END = days.length - 1;
const idx = (day) => dayIndex.get(day);
const fwd = (i, h) => (i + 1 + h <= END ? price[i + 1 + h] / price[i + 1] - 1 : Number.NaN);
const valid = (values) => values.filter((value) => Number.isFinite(value));
const variance = (values) => { const m = mean(values); return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1); };
const sma = (i, n) => mean(price.slice(i - n + 1, i + 1));
const PERIODS = [["2014-08~2017", idx("2014-11-01"), idx("2017-12-31")], ["2018~2021", idx("2018-01-01"), idx("2021-12-31")], ["2022~至今", idx("2022-01-01"), END]];

function run(inMarket, from, to, fee = 0.001) {
  let equity = 1; let peak = 1; let maxDrawdown = 0; let held = 0; let trades = 0; const daily = [];
  for (let i = from + 2; i <= to; i += 1) {
    const target = inMarket(i - 2) ? 1 : 0;
    let r = 0;
    if (target !== held) { r -= fee; trades += 1; held = target; }
    r += held * (price[i] / price[i - 1] - 1);
    equity *= 1 + r; daily.push(r); peak = Math.max(peak, equity); maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  return { cagr: equity ** (365 / daily.length) - 1, sharpe: (mean(daily) * 365) / (Math.sqrt(variance(daily)) * Math.sqrt(365)), maxDrawdown, trades, years: daily.length / 365 };
}
const line = (name, r) => `${name.padEnd(20)} 年化 ${pct(r.cagr).padStart(7)} | 夏普 ${r.sharpe.toFixed(2)} | 最大回撤 ${pct(r.maxDrawdown).padStart(6)} | 换仓 ${(r.trades / r.years).toFixed(1)} 次/年`;

// Stateful rules with confirmation must be evaluated in order.
function confirmed(n, days2) { const cache = new Map(); let state = false; return (i) => { if (cache.has(i)) return cache.get(i); const above = [...Array(days2).keys()].every((k) => price[i - k] > sma(i - k, n)); const below = [...Array(days2).keys()].every((k) => price[i - k] < sma(i - k, n)); if (above) state = true; else if (below) state = false; cache.set(i, state); return state; }; }

const trendStates = btcTrendHistory(days.map((date, i) => ({ date, close: price[i] })));

console.log("# 均线长度与确认方式（现货多/空仓，0.1% 手续费，次日执行）");
for (const [label, from, to] of PERIODS) {
  console.log(`## ${label}`);
  console.log(line("买入持有", run(() => true, from, to)));
  for (const n of [100, 150, 200, 250]) console.log(line(`MA${n}`, run((i) => price[i] > sma(i, n), from, to)));
  const c2 = confirmed(200, 2); for (let i = from - 5; i <= to; i += 1) c2(i);
  console.log(line("MA200 连续2日确认", run(c2, from, to)));
  // The production rule (src/btc-trend.mjs), carried over the whole history.
  console.log(line("MA200 ±3% 缓冲带", run((i) => trendStates[i - 199]?.state === "LONG", from, to)));
}

console.log("\n# MA200 穿越事件（首次穿越 + 30 天冷却；次日收盘入场）");
let seed = 11;
const random = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
for (const [label, from, to] of PERIODS) {
  for (const [name, test] of [["上穿", (i) => price[i] > sma(i, 200)], ["下穿", (i) => price[i] < sma(i, 200)]]) {
    const events = []; let last = -Infinity;
    for (let i = from; i <= to; i += 1) if (test(i) && !test(i - 1) && i - last >= 30) { events.push(i); last = i; }
    const cells = [30, 90].map((h) => {
      const values = valid(events.map((i) => fwd(i, h)));
      const pool = valid(Array.from({ length: to - from + 1 }, (_, k) => fwd(from + k, h)));
      const sign = name === "上穿" ? 1 : -1; let hits = 0;
      for (let draw = 0; draw < 10_000; draw += 1) { let sum = 0; for (let k = 0; k < values.length; k += 1) sum += pool[Math.floor(random() * pool.length)]; if (sign * sum / values.length >= sign * mean(values)) hits += 1; }
      return `${h}天 上涨率 ${Math.round(values.filter((v) => v > 0).length / values.length * 100)}% 均值 ${pct(mean(values))} 中位 ${pct(median(values))}（随机 ${pct(mean(pool))}，p=${(hits / 10_000).toFixed(2)}）`;
    });
    console.log(`${label} ${name} ${events.length} 次：${cells.join("；")}`);
  }
}

let since = END; while (since > 0 && (price[since - 1] > sma(since - 1, 200)) === (price[END] > sma(END, 200))) since -= 1;
console.log(`\n今天 ${days[END]}：价格 ${Math.round(price[END])}，MA200 ${Math.round(sma(END, 200))}（${pct(price[END] / sma(END, 200) - 1)}），自 ${days[since]} 起处于${price[END] > sma(END, 200) ? "上方" : "下方"}`);
