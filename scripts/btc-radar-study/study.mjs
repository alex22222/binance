// Reconstructs the radar's daily score with the live model
// (src/btc-radar-model.mjs) and tests it against what BTC did afterwards:
//   A. 2024-11-08 on: Fed (Polymarket price history), Treasury, gold and BTC
//      technicals, the four factors with usable history;
//   B. multi-year: Treasury, gold and technicals only, plus each of them alone
//      over its own longest window.
// Usage: node scripts/btc-radar-study/study.mjs [--radar-history=state/btc-radar/history.json]
// Inputs come from ./data (fetch.mjs). Factor inputs use OKX Hong Kong-time
// daily candles like the live radar, the price at the 08:43 snapshot is the
// UTC close 43 minutes earlier, and forward returns use UTC closes like the
// page. The derivatives factor (funding, open interest, sentiment: no usable
// history) is held at 50, and so is the Fed factor in part B.
import { readFileSync } from "node:fs";
import { evaluateBtcRadar } from "../../src/btc-radar-model.mjs";
import { parseTreasuryCsv } from "../../src/btc-radar-sources.mjs";

const data = (name) => JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url), "utf8"));
const fed = data("polymarket-fed.json");
const closeOn = (rows) => new Map(rows.map(({ date, close }) => [date, close]));
const btcUtc = closeOn(data("btc-utc.json"));
const btcHkt = closeOn(data("btc-hkt.json"));
const goldUtc = closeOn(data("xaut-utc.json"));
const goldHkt = closeOn(data("xaut-hkt.json"));
const treasury = data("treasury.json").flatMap(parseTreasuryCsv).sort((left, right) => right.date.localeCompare(left.date));
const DAY = 86_400_000;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const END = data("btc-utc.json").at(-1).date;

// Price of a market at the snapshot time: its last daily point, if fresh.
function priceAt(history, time) {
  let point = null;
  for (const candidate of history) if (candidate.t * 1000 <= time) point = candidate;
  return point && time - point.t * 1000 <= 3 * DAY ? point.p : null;
}
function meeting(event, time) {
  let hike = 0, cut = 0, seen = 0;
  for (const market of event.markets) {
    const yes = priceAt(market.history, time);
    if (yes === null) continue;
    seen += 1;
    const label = `${market.groupItemTitle || ""} ${market.question || ""}`.toLowerCase();
    if (/\bincrease/.test(label)) hike += yes;
    else if (/\bdecrease/.test(label)) cut += yes;
  }
  return seen ? { hike: Number(hike.toFixed(6)), cut: Number(cut.toFixed(6)) } : null;
}
// Same markets and fallbacks as fedExpectations() in src/btc-radar-sources.mjs,
// matched by meaning because historical titles differ in wording.
export function fedAt(date) {
  const time = Date.parse(`${date}T00:43:00Z`);
  const meetings = fed.filter((event) => /^Fed decision in [A-Za-z]+\?$/i.test(event.title) && Date.parse(event.endDate) > time)
    .sort((left, right) => Date.parse(left.endDate) - Date.parse(right.endDate));
  const next = meetings[0] && meeting(meetings[0], time);
  if (!next) return null;
  const following = meetings[1] && meeting(meetings[1], time);
  const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric" }).format(time));
  const another = fed.find((event) => event.title === `Another Fed rate hike in ${year}?`);
  const yearHike = fed.find((event) => event.title === `Fed rate hike in ${year}?`);
  let hikeYes = another ? priceAt(another.markets[0].history, time) : null;
  if (hikeYes === null && yearHike) {
    const yes = priceAt(yearHike.markets[0].history, time);
    if (yes !== null && yes < 0.95) hikeYes = yes; // once a hike is priced in, the market no longer asks about another
  }
  const cuts = fed.find((event) => event.title === `How many Fed rate cuts in ${year}?`
    || (event.title === "How many Fed rate cuts this year?" && event.endDate.startsWith(String(year))));
  const zero = cuts?.markets.find((market) => /^0\b/.test(market.groupItemTitle || ""));
  let noCutYes = zero ? priceAt(zero.history, time) : null;
  if (noCutYes === null && zero?.history.length && zero.history.at(-1).t * 1000 < time && zero.history.at(-1).p < 0.05) noCutYes = 0; // resolved: a cut happened
  return {
    next_meeting: meetings[0].endDate.slice(0, 7),
    p_hike_next: next.hike, p_cut_next: next.cut,
    p_hike_2026_any: hikeYes ?? Math.max(next.hike, following?.hike ?? 0),
    p_cut_2026_any: noCutYes === null ? Math.max(next.cut, following?.cut ?? 0) : Number((1 - noCutYes).toFixed(6))
  };
}

const NEUTRAL_FED = { next_meeting: "-", p_hike_next: 0, p_cut_next: 0, p_hike_2026_any: 0, p_cut_2026_any: 0 };
const NEUTRAL_RATES = Array.from({ length: 11 }, () => ({ date: "-", y2: 4.5, y10: 4.5 }));
// The live inputs at 08:43 Hong Kong time on `date`: the current price (the
// in-progress candle) followed by completed Hong Kong-time daily closes.
function closes(utc, hkt, date, count) {
  const values = [utc.get(addDays(date, -1)), ...Array.from({ length: count - 1 }, (_, index) => hkt.get(addDays(date, -1 - index)))];
  return values.every((value) => value > 0) ? values : null;
}
function scoreAt(date, { fed: withFed = true, gold: withGold = true, rates: withRates = true } = {}) {
  const btcCloses = closes(btcUtc, btcHkt, date, 60);
  const goldCloses = withGold ? closes(goldUtc, goldHkt, date, 15) : Array(15).fill(1);
  const rates = withRates ? treasury.filter((row) => row.date <= addDays(date, -1)).slice(0, 11) : NEUTRAL_RATES;
  const fedInput = withFed ? fedAt(date) : NEUTRAL_FED;
  if (!btcCloses || !goldCloses || rates.length < 11 || !fedInput) return null;
  const snapshot = evaluateBtcRadar({
    ts: date, price: btcCloses[0], btc_closes: btcCloses, gold_closes: goldCloses,
    funding: [0.0001], oi_7d_change_pct: 0, sentiment: null, poly_week: null, poly_month: null,
    fed: fedInput, treasury: rates, position: null
  });
  return { date, score: snapshot.score, price: btcCloses[0], f: Object.fromEntries(snapshot.factors.filter(({ weight }) => weight > 0).map(({ key, score }) => [key, score])) };
}
const forward = (row, days) => {
  const close = btcUtc.get(addDays(row.date, days - 1));
  return close > 0 ? close / row.price - 1 : null;
};
function series(from, options) {
  const rows = [];
  for (let date = from; date <= END; date = addDays(date, 1)) {
    const row = scoreAt(date, options);
    if (row) rows.push(row);
  }
  return rows;
}

function rank(values) {
  const order = values.map((value, index) => [value, index]).sort((left, right) => left[0] - right[0]);
  const result = [];
  for (let start = 0; start < order.length;) {
    let end = start;
    while (end + 1 < order.length && order[end + 1][0] === order[start][0]) end += 1;
    for (let index = start; index <= end; index += 1) result[order[index][1]] = (start + end) / 2;
    start = end + 1;
  }
  return result;
}
function pearson(x, y) {
  const mx = x.reduce((sum, value) => sum + value, 0) / x.length, my = y.reduce((sum, value) => sum + value, 0) / y.length;
  let cov = 0, vx = 0, vy = 0;
  x.forEach((value, index) => { cov += (value - mx) * (y[index] - my); vx += (value - mx) ** 2; vy += (y[index] - my) ** 2; });
  return cov / Math.sqrt(vx * vy);
}
const spearman = (pairs) => pairs.length > 2 ? pearson(rank(pairs.map(([x]) => x)), rank(pairs.map(([, y]) => y))) : null;
// Circular block bootstrap keeps the overlap of N-day windows inside each block.
function bootstrap(pairs, block, draws = 2000) {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const values = [];
  for (let draw = 0; draw < draws; draw += 1) {
    const sample = [];
    while (sample.length < pairs.length) {
      const start = Math.floor(random() * pairs.length);
      for (let offset = 0; offset < block && sample.length < pairs.length; offset += 1) sample.push(pairs[(start + offset) % pairs.length]);
    }
    values.push(spearman(sample));
  }
  values.sort((left, right) => left - right);
  return [values[Math.floor(draws * 0.025)], values[Math.floor(draws * 0.975)]];
}
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const BANDS = [["<40", -Infinity, 40], ["40–55", 40, 55], ["55–70", 55, 70], ["≥70", 70, Infinity]];

const PERIODS = [["2022H2", "2022-07", "2023-01"], ["2023", "2023", "2024"], ["2024", "2024", "2025"], ["2025", "2025", "2026"], ["2026", "2026", "2027"]];
// Score of a row: the model composite, or a weighted mean of chosen factors.
function evaluate(rows, value) {
  const result = { period: [rows[0].date, rows.at(-1).date], days: rows.length, horizons: {} };
  for (const days of [7, 30]) {
    const pairs = rows.map((row) => [value(row), forward(row, days), row]).filter(([, change]) => change !== null);
    const phases = Array.from({ length: days }, (_, phase) => spearman(pairs.filter((_, index) => index % days === phase)));
    const sorted = pairs.map(([score]) => score).sort((left, right) => left - right);
    const cut = (share) => sorted[Math.floor(share * (sorted.length - 1))];
    const edges = [-Infinity, cut(0.2), cut(0.4), cut(0.6), cut(0.8), Infinity];
    result.horizons[`${days}d`] = {
      n: pairs.length, spearman: spearman(pairs), bootstrap95: bootstrap(pairs, days),
      nonOverlappingMean: mean(phases), independentWindows: Math.floor(pairs.length / days), baseline: mean(pairs.map(([, change]) => change)),
      bands: BANDS.map(([label, low, high]) => {
        const values = pairs.filter(([score]) => score >= low && score < high).map(([, change]) => change);
        return { band: label, days: values.length, mean: mean(values), downShare: values.length ? values.filter((change) => change < 0).length / values.length : null };
      }),
      quintiles: edges.slice(0, -1).map((low, index) => {
        const values = pairs.filter(([score]) => score > low && score <= edges[index + 1]).map(([, change]) => change);
        return { range: [index ? low : sorted[0], edges[index + 1] === Infinity ? sorted.at(-1) : edges[index + 1]], days: values.length, mean: mean(values),
          downShare: values.length ? values.filter((change) => change < 0).length / values.length : null };
      }),
      periods: Object.fromEntries(PERIODS.map(([label, from, to]) => {
        const subset = pairs.filter(([, , row]) => row.date >= from && row.date < to);
        return [label, subset.length > 30 ? { n: subset.length, spearman: spearman(subset), mean: mean(subset.map(([, change]) => change)) } : null];
      }).filter(([, entry]) => entry))
    };
  }
  return result;
}
const weighted = (weights) => (row) => Object.entries(weights).reduce((sum, [key, weight]) => sum + row.f[key] * weight, 0) / Object.values(weights).reduce((sum, weight) => sum + weight, 0);
const saturation = (rows, key) => rows.filter((row) => row.f[key] === 0 || row.f[key] === 100).length / rows.length;

const partA = series("2024-11-08");
const threeRows = series("2022-08-01", { fed: false });
const techRows = series("2017-12-10", { fed: false, gold: false, rates: false });
const ustRows = series("2017-12-10", { fed: false, gold: false });
const goldRows = series("2022-08-01", { fed: false, rates: false });
const report = {
  A_fourFactors: { ...evaluate(partA, (row) => row.score), note: "model composite; derivatives held at 50",
    factors: Object.fromEntries(["fed", "ust", "gold", "tech"].map((key) => [key, evaluate(partA, (row) => row.f[key]).horizons["30d"].spearman])) },
  B_threeFactors: evaluate(threeRows, weighted({ ust: 20, gold: 10, tech: 15 })),
  B_tech: { ...evaluate(techRows, (row) => row.f.tech), saturated: saturation(techRows, "tech") },
  B_ust: { ...evaluate(ustRows, (row) => row.f.ust), saturated: saturation(ustRows, "ust") },
  B_gold: { ...evaluate(goldRows, (row) => row.f.gold), saturated: saturation(goldRows, "gold") }
};
// Fidelity: reconstructed factor scores against the live radar's own records.
const historyArgument = process.argv.find((value) => value.startsWith("--radar-history="));
if (historyArgument) {
  const history = JSON.parse(readFileSync(historyArgument.split("=")[1], "utf8"));
  const recorded = new Map();
  for (const entry of history) {
    const date = entry.ts.slice(0, 10);
    if (Number(entry.ts.slice(11, 13)) >= 8 && !recorded.has(date)) recorded.set(date, entry.f);
  }
  const compared = partA.filter((row) => recorded.has(row.date));
  report.fidelity = { days: compared.length, meanAbsError: Object.fromEntries(["fed", "ust", "gold", "tech"].map((key) =>
    [key, mean(compared.map((row) => Math.abs(row.f[key] - recorded.get(row.date)[key])))])),
    worst: compared.map((row) => ({ date: row.date, ...Object.fromEntries(["fed", "ust", "gold", "tech"].map((key) => [key, `${row.f[key]}/${recorded.get(row.date)[key]}`])) })).slice(-6) };
}

console.log(JSON.stringify(report, (key, value) => typeof value === "number" && !Number.isInteger(value) ? Number(value.toFixed(4)) : value, 2));
for (const [name, entry] of Object.entries(report).filter(([key]) => key !== "fidelity")) {
  console.error(`${name} ${entry.period.join("→")} (${entry.days}d): ` + ["7d", "30d"].map((key) => {
    const horizon = entry.horizons[key];
    return `${key} ρ ${horizon.spearman.toFixed(2)} [${horizon.bootstrap95.map((value) => value.toFixed(2)).join(", ")}]`;
  }).join("; "));
}
