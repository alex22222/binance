// Combines the two components that replicated (slow trend, macro regime). All
// variants tried are printed; none were tuned. Signals at day-end, executed at the
// next day's close; spot long/flat pays 0.1% per side, the long/short perp variant
// pays 0.05% per side plus funding (zero before BitMEX history starts).
import { at, dayIndex, days, mean, pct, price } from "./data.mjs";

const END = days.length - 1;
const idx = (day) => dayIndex.get(day);
const fwd = (i, h) => (i + 1 + h <= END ? price[i + 1 + h] / price[i + 1] - 1 : Number.NaN);
const valid = (values) => values.filter((value) => Number.isFinite(value));
const variance = (values) => { const m = mean(values); return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1); };

const trend = (i) => Math.sign(at(i).P - at(i).ma[200]);
const macro = (i) => at(i).macro;
export const STATE = (i) => {
  if (trend(i) > 0 && macro(i) === 1) return "STRONG_LONG";
  if (trend(i) < 0 && macro(i) === -1) return "STRONG_SHORT";
  return trend(i) > 0 ? "TREND_UP" : "TREND_DOWN";
};

function run(positionFor, from, to, { fee, perp }) {
  let equity = 1; let peak = 1; let maxDrawdown = 0; let held = 0; let trades = 0; let exposure = 0; const daily = [];
  for (let i = from + 2; i <= to; i += 1) {
    const target = positionFor(i - 2);
    let r = 0;
    if (target !== held) { r -= fee * Math.abs(target - held); trades += 1; held = target; }
    r += held * (price[i] / price[i - 1] - 1);
    if (perp) r -= held * (Number.isFinite(at(i).fundingDay) ? at(i).fundingDay : 0);
    exposure += Math.abs(held); equity *= 1 + r; daily.push(r);
    peak = Math.max(peak, equity); maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const sharpe = (mean(daily) * 365) / (Math.sqrt(variance(daily)) * Math.sqrt(365));
  return `年化 ${pct(equity ** (365 / daily.length) - 1).padStart(7)} | 夏普 ${sharpe.toFixed(2)} | 最大回撤 ${pct(maxDrawdown).padStart(6)} | 持仓 ${String(Math.round(exposure / daily.length * 100)).padStart(3)}% | 交易 ${trades}`;
}

const PERIODS = [["2014-08~2017", idx("2014-08-01"), idx("2017-12-31")], ["2018~2021", idx("2018-01-01"), idx("2021-12-31")], ["2022~至今", idx("2022-01-01"), END]];
const VARIANTS = [
  ["买入持有", () => 1, { fee: 0.001, perp: false }],
  ["S1 价格>MA200 多/空仓", (i) => (trend(i) > 0 ? 1 : 0), { fee: 0.001, perp: false }],
  ["S2 S1 且宏观非双逆风", (i) => (trend(i) > 0 && macro(i) > -1 ? 1 : 0), { fee: 0.001, perp: false }],
  ["S3 只在强多（趋势+宏观顺风）", (i) => (STATE(i) === "STRONG_LONG" ? 1 : 0), { fee: 0.001, perp: false }],
  ["S4 S2 + 强空时做空（永续）", (i) => (trend(i) > 0 && macro(i) > -1 ? 1 : STATE(i) === "STRONG_SHORT" ? -1 : 0), { fee: 0.0005, perp: true }]
];
console.log("# 组合回测");
for (const [label, from, to] of PERIODS) {
  console.log(`## ${label}`);
  for (const [name, rule, costs] of VARIANTS) console.log(`${name.padEnd(22)} ${run(rule, from, to, costs)}`);
}

console.log("\n# 各状态之后的收益（按天统计；括号内为独立段数）");
for (const [label, from, to] of PERIODS) {
  const cells = ["STRONG_LONG", "TREND_UP", "TREND_DOWN", "STRONG_SHORT"].map((state) => {
    const members = []; let episodes = 0;
    for (let i = from; i <= to; i += 1) if (STATE(i) === state) { members.push(i); if (STATE(i - 1) !== state) episodes += 1; }
    const r30 = valid(members.map((i) => fwd(i, 30))); const r90 = valid(members.map((i) => fwd(i, 90)));
    return `${state} ${members.length}天(${episodes}段) 30天 ${pct(mean(r30))} 上涨率 ${Math.round(r30.filter((v) => v > 0).length / r30.length * 100)}% / 90天 ${pct(mean(r90))}`;
  });
  console.log(`${label}：\n  ${cells.join("\n  ")}`);
}

const transitions = [];
for (let i = idx("2014-08-01") + 1; i <= END; i += 1) if (STATE(i) !== STATE(i - 1) && (STATE(i).startsWith("STRONG") || STATE(i - 1).startsWith("STRONG"))) transitions.push(i);
const perYear = transitions.length / ((END - idx("2014-08-01")) / 365);
console.log(`\n强信号进入/退出共 ${transitions.length} 次，约每年 ${perYear.toFixed(1)} 次；最近：${transitions.slice(-6).map((i) => `${days[i]} ${STATE(i - 1)}→${STATE(i)}`).join("；")}`);
console.log(`今天 ${days[END]}：${STATE(END)}（MA200 ${Math.round(at(END).ma[200])}，美元3月 ${pct(at(END).dollarChange)}，实际利率3月 ${at(END).realChange.toFixed(2)}pp）`);
