// Replicates published BTC return predictors on our data, splitting each into the
// paper's own sample and the period after it became public. Entries are one day
// after the signal; fees included where a strategy trades.
import { OBSERVED_RULES } from "../../src/btc-observe.mjs";
import { at, dayIndex, days, mean, median, pct, price, rows } from "./data.mjs";

const END = days.length - 1;
const idx = (day) => dayIndex.get(day);
const fwd = (i, h) => (i + 1 + h <= END ? price[i + 1 + h] / price[i + 1] - 1 : Number.NaN);
const variance = (values) => { const m = mean(values); return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1); };
const welch = (a, b) => (mean(a) - mean(b)) / Math.sqrt(variance(a) / a.length + variance(b) / b.length);
const valid = (values) => values.filter((value) => Number.isFinite(value));
let seed = 7;
const random = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function pValue(observedMean, count, from, to, h) {
  // One-sided: chance that `count` random entry days in the same period average at least as much.
  const pool = valid(Array.from({ length: to - from + 1 }, (_, k) => fwd(from + k, h)));
  let hits = 0;
  for (let draw = 0; draw < 10_000; draw += 1) {
    let sum = 0; for (let k = 0; k < count; k += 1) sum += pool[Math.floor(random() * pool.length)];
    if (sum / count >= observedMean) hits += 1;
  }
  return { p: hits / 10_000, base: mean(pool) };
}
function firstDays(condition, from, to, cooldown) {
  const list = []; let last = -Infinity;
  for (let i = Math.max(from, 1); i <= to; i += 1) if (condition(i) && !condition(i - 1) && i - last >= cooldown) { list.push(i); last = i; }
  return list;
}
function spotStrategy(inMarket, from, to, fee = 0.001) {
  let equity = 1; let peak = 1; let maxDrawdown = 0; let held = 0; let trades = 0; let exposure = 0; const daily = [];
  for (let i = from + 2; i <= to; i += 1) {
    const target = inMarket(i - 2) ? 1 : 0; // decided at the end of i-2, executed at the close of i-1
    let r = 0;
    if (target !== held) { r -= fee; trades += 1; held = target; }
    r += held * (price[i] / price[i - 1] - 1);
    exposure += held; equity *= 1 + r; daily.push(r);
    peak = Math.max(peak, equity); maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const volatility = Math.sqrt(variance(daily)) * Math.sqrt(365);
  return `年化 ${pct(equity ** (365 / daily.length) - 1)} | 夏普 ${((mean(daily) * 365) / volatility).toFixed(2)} | 最大回撤 ${pct(maxDrawdown)} | 持仓 ${(exposure / daily.length * 100).toFixed(0)}% | 交易 ${trades}`;
}

// R1 — Liu & Tsyvinski (RFS 2021): last week's return predicts next week's (time-series momentum).
console.log("## R1 周度时间序列动量（Liu & Tsyvinski 2021；原样本至 2018）");
for (const [label, from, to] of [["2014-2018 原样本期", idx("2014-01-08"), idx("2018-12-31")], ["2019-至今 发表后", idx("2019-01-01"), END - 8]]) {
  const pairs = [];
  for (let i = from; i + 8 <= to; i += 7) pairs.push([price[i] / price[i - 7] - 1, price[i + 8] / price[i + 1] - 1]);
  pairs.sort((a, b) => a[0] - b[0]);
  const fifth = Math.floor(pairs.length / 5);
  const q = [0, 1, 2, 3, 4].map((k) => pairs.slice(k * fifth, k === 4 ? pairs.length : (k + 1) * fifth).map(([, next]) => next));
  const up = pairs.filter(([last]) => last > 0).map(([, next]) => next); const down = pairs.filter(([last]) => last <= 0).map(([, next]) => next);
  console.log(`${label}：${pairs.length} 周；下周收益按上周五分位（低→高）${q.map((values) => pct(mean(values))).join(" / ")}；最高-最低 ${pct(mean(q[4]) - mean(q[0]))}，t=${welch(q[4], q[0]).toFixed(2)}；上周涨后下周 ${pct(mean(up))} vs 上周跌后 ${pct(mean(down))}，t=${welch(up, down).toFixed(2)}`);
}

// R2 — Detzel et al. (FM 2021): price above its moving average forecasts returns; long/flat spot rules.
console.log("\n## R2 均线择时（Detzel 等 2021；现货，单边 0.1% 手续费，次日执行）");
for (const [label, from, to] of [["2014-2018 原样本期", idx("2014-08-01"), idx("2018-12-31")], ["2019-2021", idx("2019-01-01"), idx("2021-12-31")], ["2022-至今", idx("2022-01-01"), END]]) {
  console.log(`${label}`);
  console.log(`  买入持有        ${spotStrategy(() => true, from, to)}`);
  for (const length of [20, 50, 100, 200]) console.log(`  价格>MA${String(length).padEnd(3)}    ${spotStrategy((i) => at(i).P > at(i).ma[length], from, to)}`);
}

// R3 — Schmeling, Schrimpf & Todorov (BIS 2023 / Management Science): high carry predicts crashes.
console.log("\n## R3 资金费率过热 → 崩盘风险（BIS 2023）：未来 30 天内最大跌幅超过 20% 的概率");
const crash30 = (i) => { if (i + 31 > END) return Number.NaN; let low = Infinity; for (let k = i + 2; k <= i + 31; k += 1) low = Math.min(low, price[k]); return low / price[i + 1] - 1 <= -0.2 ? 1 : 0; };
const buckets = [["< 0", (f) => f < 0], ["0~10%", (f) => f >= 0 && f < 0.10], ["10~30%", (f) => f >= 0.10 && f < 0.30], ["≥ 30%", (f) => f >= 0.30]];
for (const [label, from, to] of [["2016-06~2021", idx("2016-06-01"), idx("2021-12-31")], ["2022-至今", idx("2022-01-01"), END]]) {
  const cells = buckets.map(([name, test]) => {
    const members = []; for (let i = from; i <= to; i += 1) { const f = at(i).funding7; if (Number.isFinite(f) && test(f)) members.push(i); }
    const crashes = valid(members.map(crash30)); const returns = valid(members.map((i) => fwd(i, 30)));
    const episodes = firstDays((i) => Number.isFinite(at(i).funding7) && test(at(i).funding7), from, to, 14).length;
    return `${name}: ${members.length} 天/${episodes} 段，崩盘率 ${(mean(crashes) * 100).toFixed(0)}%，30天均值 ${pct(mean(returns))}`;
  });
  console.log(`${label}（年化资金费率 7 日均值）：${cells.join(" | ")}`);
}

// R4 — K33 Research (2024): 30-day average funding turning negative preceded strong returns.
console.log("\n## R4 30 日平均资金费率转负（K33 2024）");
// The radar's observation mode runs this same rule (src/btc-observe.mjs).
const fundingNegative = OBSERVED_RULES.find(({ id }) => id === "FUNDING_NEGATIVE");
for (const [label, from, to] of [["2016-06~2021", idx("2016-07-01"), idx("2021-12-31")], ["2022-至今", idx("2022-01-01"), END]]) {
  const list = firstDays((i) => fundingNegative.test(rows, i), from, to, fundingNegative.cooldown);
  for (const h of [30, 90]) {
    const values = valid(list.map((i) => fwd(i, h)));
    if (!values.length) { console.log(`${label} ${h}d：无事件`); continue; }
    const { p, base } = pValue(mean(values), values.length, from, to, h);
    console.log(`${label} ${h}d：${values.length} 次，胜率 ${(values.filter((v) => v > 0).length / values.length * 100).toFixed(0)}%，平均 ${pct(mean(values))}，中位 ${pct(median(values))}，随机 ${pct(base)}，p=${p.toFixed(3)}；日期 ${list.map((i) => days[i]).join(",")}`);
  }
}

// R5 — Fear & Greed extremes (contrarian claim).
console.log("\n## R5 恐惧贪婪极值（首日 + 14 天冷却；方向：恐惧看涨、贪婪看跌）");
for (const [label, from, to] of [["2018-2021", idx("2018-02-08"), idx("2021-12-31")], ["2022-至今", idx("2022-01-01"), END]]) {
  for (const [name, test, direction] of [["极度恐惧 ≤20", (i) => at(i).fng <= 20, 1], ["极度贪婪 ≥80", (i) => at(i).fng >= 80, -1]]) {
    const list = firstDays(test, from, to, 14);
    const values = valid(list.map((i) => direction * fwd(i, 30)));
    if (!values.length) { console.log(`${label} ${name}：无事件`); continue; }
    const pool = valid(Array.from({ length: to - from + 1 }, (_, k) => direction * fwd(from + k, 30)));
    let hits = 0; for (let draw = 0; draw < 10_000; draw += 1) { let sum = 0; for (let k = 0; k < values.length; k += 1) sum += pool[Math.floor(random() * pool.length)]; if (sum / values.length >= mean(values)) hits += 1; }
    console.log(`${label} ${name}：${values.length} 次，方向正确率 ${(values.filter((v) => v > 0).length / values.length * 100).toFixed(0)}%，方向收益 ${pct(mean(values))}（随机 ${pct(mean(pool))}），p=${(hits / 10_000).toFixed(3)}`);
  }
}

// R6 — Macro: 3-month change in the broad dollar and 10y real yield.
console.log("\n## R6 宏观（美元指数 + 10 年期实际利率，3 个月变化方向）");
for (const [label, from, to] of [["2018-2021", idx("2018-02-08"), idx("2021-12-31")], ["2022-至今", idx("2022-01-01"), END]]) {
  const cells = [[1, "双降(顺风)"], [0, "分歧"], [-1, "双升(逆风)"]].map(([value, name]) => {
    const members = []; for (let i = from; i <= to; i += 1) if (Math.sign(at(i).macro) === value || (value === 0 && at(i).macro === 0)) members.push(i);
    return `${name} ${members.length} 天：30天 ${pct(mean(valid(members.map((i) => fwd(i, 30)))))}，90天 ${pct(mean(valid(members.map((i) => fwd(i, 90)))))}`;
  });
  console.log(`${label}：${cells.join(" | ")}`);
}
