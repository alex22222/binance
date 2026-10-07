import { OBSERVED_RULES } from "../../src/btc-observe.mjs";
import { DAY, at, clamp, dayIndex, days, iso, mean, median, ms, pct, price, rows, sign } from "./data.mjs";

// ---- Pre-registered rules.
// Pre-registered rules, shared with the radar's observation mode
// (src/btc-observe.mjs). A: trend continuation — all four moving averages and
// 4-week momentum agree, positioning not overheated against the trade, sentiment
// not at the opposite extreme, macro (dollar + real yields, 3-month change) not
// against it. B: extreme reversal — capitulation (or euphoria) plus crowded
// positioning, confirmed by price reclaiming (or losing) the 20-day average.
const SHARED = OBSERVED_RULES.filter(({ id }) => /^[AB]_/.test(id));
const RULES = Object.fromEntries(SHARED.map((rule) => [rule.id, (i) => rule.test(rows, i)]));
const DIRECTION = Object.fromEntries(SHARED.map((rule) => [rule.id, rule.direction]));

const START = dayIndex.get("2018-02-08");
const END = days.length - 1;
const PERIODS = [
  ["全样本", START, END],
  ["2018-02~2021-12", START, dayIndex.get("2021-12-31")],
  ["2022-01~至今", dayIndex.get("2022-01-01"), END]
];

// ---- Event study: first day a rule turns on, 14-day cooldown, entry at next day's close.
function events(rule, from, to, cooldown = 14) {
  const list = []; let last = -Infinity;
  for (let i = Math.max(from, 1); i <= to; i += 1) {
    if (RULES[rule](i) && !RULES[rule](i - 1) && i - last >= cooldown) { list.push(i); last = i; }
  }
  return list;
}
const forward = (i, h) => (i + 1 + h <= END ? price[i + 1 + h] / price[i + 1] - 1 : Number.NaN);
let seed = 20261006;
const random = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function bootstrapP(observed, count, from, to, h, direction) {
  const pool = []; for (let i = from; i <= to; i += 1) { const f = forward(i, h); if (!Number.isNaN(f)) pool.push(direction * f); }
  let hits = 0; const draws = 10_000;
  for (let draw = 0; draw < draws; draw += 1) {
    let sum = 0; for (let k = 0; k < count; k += 1) sum += pool[Math.floor(random() * pool.length)];
    if (sum / count >= observed) hits += 1;
  }
  return { p: hits / draws, base: mean(pool), baseHit: pool.filter((value) => value > 0).length / pool.length };
}

console.log("# 事件研究（信号首日 + 14 天冷却；次日收盘入场；方向调整后收益）\n");
for (const [label, from, to] of PERIODS) {
  console.log(`## ${label}（${days[from]} ~ ${days[to]}）`);
  console.log("规则 | 次数 | 持有 | 胜率 | 平均 | 中位数 | 同期随机天平均 | 随机胜率 | p 值");
  for (const rule of Object.keys(RULES)) {
    const list = events(rule, from, to);
    for (const h of [7, 30]) {
      const values = list.map((i) => DIRECTION[rule] * forward(i, h)).filter((value) => !Number.isNaN(value));
      if (!values.length) { console.log(`${rule} | 0 | ${h}d | - | - | - | - | - | -`); continue; }
      const observed = mean(values);
      const { p, base, baseHit } = bootstrapP(observed, values.length, from, to, h, DIRECTION[rule]);
      console.log(`${rule} | ${values.length} | ${h}d | ${(values.filter((v) => v > 0).length / values.length * 100).toFixed(0)}% | ${pct(observed)} | ${pct(median(values))} | ${pct(base)} | ${(baseHit * 100).toFixed(0)}% | ${p.toFixed(3)}`);
    }
  }
  console.log("");
}

// ---- Strategy simulation.
const FEE = 0.0005; // taker per side
function simulate(positionFor, from, to, { delay = 1 } = {}) {
  // positionFor(i, current) -> desired position at the end of day i (-1, 0, 1).
  const desired = new Array(rows.length).fill(0);
  let current = 0;
  for (let i = from; i <= to; i += 1) { current = positionFor(i, current); desired[i] = current; }
  let equity = 1; let peak = 1; let maxDrawdown = 0; let held = 0; let trades = 0; let exposure = 0;
  const daily = [];
  for (let i = from + 1; i <= to; i += 1) {
    // Decided at the end of day i-1-delay, so it earns day i's return.
    const target = i - 1 - delay >= from ? desired[i - 1 - delay] : 0;
    let r = 0;
    if (target !== held) { r -= FEE * Math.abs(target - held); trades += 1; held = target; }
    r += held * (price[i] / price[i - 1] - 1) - held * at(i).fundingDay;
    if (held) exposure += 1;
    equity *= 1 + r; daily.push(r);
    peak = Math.max(peak, equity); maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const years = daily.length / 365;
  const volatility = Math.sqrt(mean(daily.map((r) => r * r)) - mean(daily) ** 2) * Math.sqrt(365);
  return { cagr: equity ** (1 / years) - 1, sharpe: (mean(daily) * 365) / volatility, maxDrawdown, trades, exposure: exposure / daily.length, total: equity - 1 };
}
const STRATEGIES = {
  "买入持有": () => 1,
  "MA200 多/空仓": (i) => (at(i).P > at(i).ma[200] ? 1 : 0),
  "均线全多/全空（无过滤）": (i) => (at(i).trend === 1 ? 1 : at(i).trend === -1 ? -1 : 0),
  "强信号 A（趋势延续）": (() => {
    return (i, current) => {
      if (RULES.A_LONG(i)) return 1;
      if (RULES.A_SHORT(i)) return -1;
      if (current === 1 && at(i).trend < 0.5) return 0;
      if (current === -1 && at(i).trend > -0.5) return 0;
      return current;
    };
  })(),
  "强信号 A+B": (() => {
    let mode = null; let until = 0;
    return (i, current) => {
      if (RULES.A_LONG(i)) { mode = "A"; return 1; }
      if (RULES.A_SHORT(i)) { mode = "A"; return -1; }
      if (current === 0 && RULES.B_LONG(i)) { mode = "B"; until = i + 30; return 1; }
      if (current === 0 && RULES.B_SHORT(i)) { mode = "B"; until = i + 30; return -1; }
      if (mode === "B" && i >= until) { mode = null; return 0; }
      if (mode === "A" && current === 1 && at(i).trend < 0.5) { mode = null; return 0; }
      if (mode === "A" && current === -1 && at(i).trend > -0.5) { mode = null; return 0; }
      return current;
    };
  })()
};
console.log("# 策略回测（含 0.05% 单边手续费与资金费；默认次日执行）\n");
for (const [label, from, to] of PERIODS) {
  console.log(`## ${label}`);
  console.log("策略 | 年化 | 夏普 | 最大回撤 | 持仓时间 | 换手次数 | 同日执行年化");
  for (const [name, rule] of Object.entries(STRATEGIES)) {
    const slow = simulate(rule, from, to, { delay: 1 });
    const fast = simulate(rule, from, to, { delay: 0 });
    console.log(`${name} | ${pct(slow.cagr)} | ${slow.sharpe.toFixed(2)} | ${pct(slow.maxDrawdown)} | ${(slow.exposure * 100).toFixed(0)}% | ${slow.trades} | ${pct(fast.cagr)}`);
  }
  console.log("");
}

// ---- Current radar rules, reconstructed where history exists (tech, ust, gold, funding part of deriv).
function radarLite(i) {
  const r = at(i);
  const parts = [];
  const tech = clamp(50 - 300 * (r.P / r.ma[20] - 1) - 100 * (r.P / r.ma[50] - 1) - 2 * r.move7 * 100);
  parts.push([tech, 15]);
  if (!Number.isNaN(r.y10change)) parts.push([clamp(50 + r.y10change + (r.y10 - 4.5) * 15), 20]);
  if (!Number.isNaN(r.gold10)) parts.push([clamp(50 - 5 * r.gold10), 10]);
  if (!Number.isNaN(r.funding1bps)) parts.push([clamp(50 + (r.funding1bps - 1) * 8), 10]);
  const weight = parts.reduce((sum, [, w]) => sum + w, 0);
  return { score: parts.reduce((sum, [s, w]) => sum + s * w, 0) / weight, tech };
}
function spearman(xs, ys) {
  const rank = (values) => { const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const ranks = new Array(values.length); order.forEach(([, i], r) => { ranks[i] = r; }); return ranks; };
  const rx = rank(xs); const ry = rank(ys); const mx = mean(rx); const my = mean(ry);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < xs.length; i += 1) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
console.log("# 现有雷达评分（可复原部分：技术面、美债、黄金、资金费率）对未来 30 天收益的区分度\n");
for (const [label, from, to] of PERIODS) {
  const xs = []; const ys = []; const techs = [];
  for (let i = from; i <= to; i += 1) { const f = forward(i, 30); if (Number.isNaN(f)) continue; const { score, tech } = radarLite(i); xs.push(score); techs.push(tech); ys.push(f); }
  const order = xs.map((x, k) => [x, ys[k]]).sort((a, b) => a[0] - b[0]);
  const fifth = Math.floor(order.length / 5);
  const buckets = [0, 1, 2, 3, 4].map((b) => order.slice(b * fifth, b === 4 ? order.length : (b + 1) * fifth));
  console.log(`## ${label}：Spearman(评分, 未来30天) = ${spearman(xs, ys).toFixed(3)}；只看技术面 = ${spearman(techs, ys).toFixed(3)}`);
  console.log(`五分位（低压力→高压力）未来 30 天平均：${buckets.map((bucket) => `${bucket[0][0].toFixed(0)}-${bucket.at(-1)[0].toFixed(0)}分 ${pct(mean(bucket.map(([, y]) => y)))}`).join(" | ")}`);
}

// ---- Where the rules stand today.
const last = END;
const now = at(last);
console.log(`\n# 最新（${now.day}）`);
console.log(JSON.stringify({
  price: Math.round(now.P), trend: now.trend, r28: pct(now.r28), funding7: pct(now.funding7), fng: now.fng,
  dollar3m: pct(now.dollarChange), realYield3m: `${now.realChange.toFixed(2)}pp`, macro: now.macro, mvrv: now.mvrv.toFixed(2),
  rules: Object.fromEntries(Object.keys(RULES).map((rule) => [rule, RULES[rule](last)])),
  lastEvents: Object.fromEntries(Object.keys(RULES).map((rule) => [rule, days[events(rule, START, END).at(-1)] ?? null]))
}));
