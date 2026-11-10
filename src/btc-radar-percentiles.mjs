// Fixed ex-ante weights. This is a descriptive pressure model, not a fitted
// forecast. Missing data never gets a neutral 50 or redistributed weight.
export const BTC_RADAR_WEIGHTS = Object.freeze({ rates: 20, flow: 20, tech: 35, deriv: 20, gold: 5 });
const DAY = 86400000;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const valid = value => typeof value === "number" && Number.isFinite(value);
const stamp = row => Date.parse(row.availableAt || `${row.date}T00:00:00Z`);
const metricText = c => c.id === "yield2" ? `${c.value.toFixed(2)}%` :
  c.id === "yield10Change" ? `${(c.value * 100).toFixed(1)}bp` :
    c.id === "etf5" ? `${c.value.toLocaleString("en-US", { maximumFractionDigits: 0 })} USD` :
      `${(c.value * 100).toFixed(c.id === "funding3" ? 4 : c.id === "premium" ? 3 : 2)}%`;

export function percentileScore(value, rows = [], nowMs = Date.now(), { inverse = false, observationDate = null } = {}) {
  // Exclude today's observation and any later publication/revision. Keep one
  // observation per source date (weekend carry does not create new samples).
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const start = Date.parse(`${day}T00:00:00Z`) - 365 * DAY;
  const samples = [...new Map(rows.filter(row => valid(row.value) && row.date < (observationDate || day) &&
    Date.parse(`${row.date}T00:00:00Z`) >= start && stamp(row) <= nowMs).map(row => [row.date, row])).values()];
  const dates = samples.map(row => Date.parse(`${row.date}T00:00:00Z`));
  const span = dates.length ? (Math.max(...dates) - Math.min(...dates)) / DAY : 0;
  const enough = samples.length >= 180 && span >= 330;
  const percentile = valid(value) && enough
    ? 100 * (samples.filter(row => row.value < value).length + samples.filter(row => row.value === value).length / 2) / samples.length : null;
  return { score: percentile === null ? null : inverse ? 100 - percentile : percentile,
    n: samples.length, spanDays: span, reason: !valid(value) ? "VALUE_UNAVAILABLE" : enough ? null : "ONE_YEAR_WARMUP" };
}

const DEFINITIONS = [
  ["rates", "利率", [["yield2", "2年美债收益率", false], ["yield10Change", "10年收益率10交易日变化", false]], "美债指标的一年分位数均值；FOMC 合约仅作同卡参考，不与美债重复计分。"],
  ["flow", "资金流", [["etf5", "BTC现货ETF 5交易日净流入（USD）", true], ["stable7", "美元稳定币总供应7日变化", true], ["premium", "Coinbase/OKX 美元归一溢价", true]], "ETF流入、稳定币扩张、Coinbase正溢价越弱，压力越高；三项缺一不补中性值。"],
  ["tech", "短期动量与波动", [["momentum3", "BTC 3日收益", true], ["vol7", "7日实现波动率（年化）", true]], "短期下跌记为压力；波动压缩记为潜在突破风险，不等同于看空；不使用均线。"],
  ["deriv", "杠杆拥挤", [["funding3", "3日平均资金费率", false], ["oi7", "持仓量7日变化", false]], "资金费率和持仓量变化的一年分位数均值；舆情不再用手写系数。"],
  ["gold", "黄金 (XAUT)", [["gold10", "黄金10日收益", true]], "保留原方向假设：黄金走弱记为压力；降至5%，不据此推断实际利率。"]
];

export function scorePercentileFactors({ values = {}, history = {}, nowMs = Date.now(), asOf = {} } = {}) {
  const factors = DEFINITIONS.map(([key, name, definitions, rule]) => {
    const components = definitions.map(([id, label, inverse]) => ({ id, label, value: values[id] ?? null,
      asOf: asOf[id] || null, inverse, ...percentileScore(values[id], history[id], nowMs, { inverse, observationDate: asOf[id] }) }));
    const ready = components.every(c => c.score !== null);
    return { key, name, weight: BTC_RADAR_WEIGHTS[key], score: ready ? mean(components.map(c => c.score)) : null,
      components, rule, metrics: components.map(c => [c.label,
        valid(c.value) ? `${metricText(c)} · 压力分位 ${c.score === null ? "未就绪" : c.score.toFixed(1)} · n=${c.n}${c.asOf ? ` · ${c.asOf}` : ""}` : "当前未核实"]),
      note: ready ? "相对过去一年已知数据的位置，不是未来下跌概率。" : `评分未就绪：${components.filter(c => c.score === null).map(c => `${c.label}（${c.reason === "ONE_YEAR_WARMUP" ? "一年历史不足" : "数据缺失或过时"}）`).join("；")}` };
  });
  return { factors, score: factors.every(f => f.score !== null) ? factors.reduce((sum, f) => sum + f.score * f.weight / 100, 0) : null };
}

// Raw dated inputs, not historical factor scores. Dates label the observation;
// availableAt is when it can enter a decision. Historical studies using today's
// revised data must separately disclose that they are not point-in-time archives.
export function buildPercentileHistory({ btc = [], gold = [], treasury = [], etf = [], stablecoin = [], coinbase = [], usdt = [], funding = [], openInterest = [] } = {}) {
  const history = {};
  const add = (id, date, value, lag = 1) => {
    if (!valid(value)) return;
    (history[id] ||= []).push({ date, value, availableAt: new Date(Date.parse(`${date}T00:00:00Z`) + lag * DAY).toISOString() });
  };
  const sorted = rows => [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const returns = (rows, n, id) => {
    rows = sorted(rows);
    for (let i = n; i < rows.length; i++) {
      if ((Date.parse(rows[i].date) - Date.parse(rows[i - n].date)) / DAY !== n) continue;
      if (rows[i].close > 0 && rows[i - n].close > 0) add(id, rows[i].date, rows[i].close / rows[i - n].close - 1);
    }
  };
  returns(btc, 3, "momentum3");
  returns(gold, 10, "gold10");
  btc = sorted(btc);
  for (let i = 7; i < btc.length; i++) {
    const window = btc.slice(i - 7, i + 1);
    if ((Date.parse(window.at(-1).date) - Date.parse(window[0].date)) / DAY !== 7 || window.some(r => !(r.close > 0))) continue;
    const changes = window.slice(1).map((row, j) => Math.log(row.close / window[j].close));
    const average = mean(changes);
    add("vol7", btc[i].date, Math.sqrt(mean(changes.map(x => (x - average) ** 2)) * 365));
  }
  treasury = sorted(treasury);
  for (let i = 0; i < treasury.length; i++) {
    add("yield2", treasury[i].date, treasury[i].y2);
    if (i >= 10 && Date.parse(treasury[i].date) - Date.parse(treasury[i - 10].date) <= 20 * DAY)
      add("yield10Change", treasury[i].date, treasury[i].y10 - treasury[i - 10].y10);
  }
  etf = sorted(etf);
  for (let i = 4; i < etf.length; i++) {
    const rows = etf.slice(i - 4, i + 1);
    if (Date.parse(rows.at(-1).date) - Date.parse(rows[0].date) <= 10 * DAY && rows.every(r => valid(r.flowUsd)))
      add("etf5", etf[i].date, rows.reduce((sum, r) => sum + r.flowUsd, 0), 2);
  }
  stablecoin = sorted(stablecoin);
  const supplies = new Map(stablecoin.map(r => [r.date, r.supply]));
  for (const row of stablecoin) {
    const past = supplies.get(new Date(Date.parse(row.date) - 7 * DAY).toISOString().slice(0, 10));
    if (past > 0 && row.supply > 0) add("stable7", row.date, row.supply / past - 1);
  }
  const btcOn = new Map(btc.map(r => [r.date, r.close]));
  const dollarOn = new Map(usdt.map(r => [r.date, r.close]));
  for (const row of coinbase) {
    const referenceUsd = btcOn.get(row.date) * dollarOn.get(row.date);
    if (referenceUsd > 0 && row.close > 0) add("premium", row.date, row.close / referenceUsd - 1);
  }
  // Three complete UTC days; repeated 8h entries are not independent days.
  const fundingDays = new Map();
  for (const row of funding) {
    if (!valid(row.rate) || !valid(row.ts)) continue;
    const date = new Date(row.ts).toISOString().slice(0, 10);
    const rates = fundingDays.get(date) || new Map();
    rates.set(row.ts, row.rate); fundingDays.set(date, rates);
  }
  const dailyFunding = [...fundingDays].filter(([, rows]) => rows.size >= 3)
    .map(([date, rows]) => ({ date, close: mean([...rows.values()]) }));
  const dailyOn = new Map(dailyFunding.map(r => [r.date, r.close]));
  for (const row of dailyFunding) {
    const values = [0, 1, 2].map(n => dailyOn.get(new Date(Date.parse(row.date) - n * DAY).toISOString().slice(0, 10)));
    if (values.every(valid)) add("funding3", row.date, mean(values));
  }
  returns(openInterest.map(r => ({ date: r.date, close: r.value })), 7, "oi7");
  for (const rows of Object.values(history)) rows.sort((a, b) => a.date.localeCompare(b.date));
  return history;
}

export function percentileInputsAt(history, nowMs) {
  const values = {}, asOf = {};
  for (const [id, rows] of Object.entries(history)) {
    const latest = rows.filter(r => stamp(r) <= nowMs).sort((a, b) => stamp(a) - stamp(b)).at(-1);
    const maxAge = ["yield2", "yield10Change", "etf5"].includes(id) ? 7 * DAY : 2 * DAY;
    values[id] = latest && nowMs - stamp(latest) <= maxAge ? latest.value : null;
    asOf[id] = latest?.date || null;
  }
  return { values, asOf, history, nowMs };
}
