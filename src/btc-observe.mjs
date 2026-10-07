// Observation mode for the candidate BTC signals in
// docs/2026-10-06-btc-strong-signal-research.md that did not hold up after
// 2021. Each completed UTC day is checked against every rule; triggers are
// recorded with their later returns but never pushed. A rule should only be
// considered for a push after OBSERVATION_MIN_EVENTS matured triggers from
// after the study beat random days of the same period. The study scripts in
// scripts/btc-signal-study run these same rules on the research history.

const DAY = 86_400_000;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);
const recent = (rows, index, length, pick) => rows.slice(Math.max(0, index - length + 1), index + 1).map(pick);
const dayMs = (date) => Date.parse(`${date}T00:00:00Z`);
const shiftDate = (date, days) => new Date(dayMs(date) + days * DAY).toISOString().slice(0, 10);

export const OBSERVATION_HORIZONS = Object.freeze([7, 30, 90]);
export const OBSERVATION_MIN_EVENTS = 10;

// `horizon` is the holding period the study judged each rule on; `evidence`
// is its post-2021 result.
export const OBSERVED_RULES = Object.freeze([
  {
    id: "A_LONG", label: "趋势延续 · 做多", direction: 1, cooldown: 14, horizon: 7,
    needs: ["trend", "r28", "funding7", "fng", "macro"],
    evidence: "2022 年后 7 天胜率 75%（随机 52%），p=0.16，不显著",
    test: (rows, i) => {
      const r = rows[i];
      return r.trend === 1 && r.r28 > 0 && r.funding7 < 0.30 && r.fng < 80 && r.macro >= 0;
    }
  },
  {
    id: "A_SHORT", label: "趋势延续 · 做空", direction: -1, cooldown: 14, horizon: 7,
    needs: ["trend", "r28", "funding7", "fng", "macro"],
    evidence: "2022 年后 7 天胜率 32%，比随机更差",
    test: (rows, i) => {
      const r = rows[i];
      return r.trend === -1 && r.r28 < 0 && r.funding7 > 0 && r.fng > 20 && r.macro <= 0;
    }
  },
  {
    id: "B_LONG", label: "极端反转 · 做多", direction: 1, cooldown: 14, horizon: 30,
    needs: ["fng", "funding7"],
    evidence: "2022 年后 30 天胜率 42%，p=0.92",
    test: (rows, i) => {
      const r = rows[i];
      if (!(Math.min(...recent(rows, i, 7, (x) => x.fng)) <= 20 && r.funding7 <= 0 && r.close > r.ma[20])) return false;
      return recent(rows, i - 1, 3, (x) => x.close <= x.ma[20]).some(Boolean);
    }
  },
  {
    id: "B_SHORT", label: "极端反转 · 做空", direction: -1, cooldown: 14, horizon: 30,
    needs: ["fng", "funding7"],
    evidence: "2018 年以来只出现 6 次，样本不足",
    test: (rows, i) => {
      const r = rows[i];
      if (!(Math.max(...recent(rows, i, 7, (x) => x.fng)) >= 80 && r.funding7 >= 0.30 && r.close < r.ma[20])) return false;
      return recent(rows, i - 1, 3, (x) => x.close >= x.ma[20]).some(Boolean);
    }
  },
  {
    id: "FUNDING_NEGATIVE", label: "30 日资金费率转负", direction: 1, cooldown: 30, horizon: 30,
    needs: ["funding7"],
    evidence: "2022 年后 30 天 p=0.33，90 天平均 −5%",
    test: (rows, i) => mean(recent(rows, i, 30, (x) => x.funding7)) < 0
  },
  {
    id: "FUNDING_HOT", label: "资金费率过热（≥30% 年化）", direction: -1, cooldown: 14, horizon: 30,
    needs: ["funding7"],
    evidence: "2022 年后很少出现，之后 30 天内没有跌超 20%",
    test: (rows, i) => rows[i].funding7 >= 0.30
  }
]);

// First days a rule turns on, each at least `cooldown` days after the one
// before (`last` is the index of an earlier trigger, if any).
export function ruleEvents(rows, rule, { from = 1, to = rows.length - 1, last = -Infinity } = {}) {
  const events = [];
  for (let i = Math.max(from, 1); i <= to; i += 1) {
    if (rule.test(rows, i) && !rule.test(rows, i - 1) && i - last >= rule.cooldown) {
      events.push(i);
      last = i;
    }
  }
  return events;
}

function asOfIndex(series, t) {
  let low = 0; let high = series.length - 1; let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (series[mid].t <= t) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found;
}

// One row per completed UTC day, built the way scripts/btc-signal-study/data.mjs
// builds its research rows: moving averages include the day's close, funding is
// the annualized mean of the 8-hour rates settled in the 7 days ending at the
// next midnight, and FRED values are read one day late.
// closes: [{ date, close }] oldest first; fearGreed: [{ date, value }];
// funding: [{ ts, rate }]; dollar, realYield: [{ date, value }].
export function observationRows({ closes, fearGreed = [], funding = [], dollar = [], realYield = [] }) {
  const prices = closes.map(({ close }) => close);
  const fng = new Map(fearGreed.map(({ date, value }) => [date, value]));
  const events = [...funding].sort((left, right) => left.ts - right.ts);
  const series = (points) => points.map(({ date, value }) => ({ t: dayMs(date), value })).sort((left, right) => left.t - right.t);
  const dollarSeries = series(dollar);
  const realSeries = series(realYield);
  const change = (points, lag, relative) => {
    const now = asOfIndex(points, lag);
    const before = asOfIndex(points, lag - 91 * DAY);
    if (now < 0 || before < 0) return Number.NaN;
    return relative ? points[now].value / points[before].value - 1 : points[now].value - points[before].value;
  };
  return closes.map(({ date, close }, index) => {
    const t = dayMs(date);
    const ma = Object.fromEntries([20, 50, 100, 200].map((length) => [
      length, index + 1 < length ? Number.NaN : mean(prices.slice(index - length + 1, index + 1))
    ]));
    const rates7 = events.filter(({ ts }) => ts > t + DAY - 7 * DAY && ts <= t + DAY).map(({ rate }) => rate);
    const dollarChange = change(dollarSeries, t - DAY, true);
    const realChange = change(realSeries, t - DAY, false);
    return {
      date,
      close,
      ma,
      trend: mean([20, 50, 100, 200].map((length) => sign(close - ma[length]))),
      r28: index >= 28 ? close / prices[index - 28] - 1 : Number.NaN,
      funding7: rates7.length >= 15 ? mean(rates7) * 3 * 365 : Number.NaN,
      fng: fng.get(date) ?? Number.NaN,
      macro: Number.isNaN(dollarChange) || Number.isNaN(realChange) ? Number.NaN : (sign(-dollarChange) + sign(-realChange)) / 2,
      dollarChange,
      realChange
    };
  });
}

// Deterministic so the page shows the same p-value until the data changes.
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One-sided: the chance that as many random days of the same period average at
// least as much as the triggers did.
function bootstrapP(values, pool, seed) {
  const random = seededRandom(seed);
  const observed = mean(values);
  let hits = 0;
  for (let draw = 0; draw < 10_000; draw += 1) {
    let sum = 0;
    for (let k = 0; k < values.length; k += 1) sum += pool[Math.floor(random() * pool.length)];
    if (sum / values.length >= observed) hits += 1;
  }
  return hits / 10_000;
}

const round = (value, places = 5) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(places)));

// Advances the stored record with newly completed days and returns the page
// summary. `previous` is null on the first run, which also logs triggers
// already inside the data window, marked as before the observation start.
// Each rule remembers the last day it fully evaluated, so a day whose inputs
// were still missing is checked again on the next run.
export function updateObservations(previous, rows) {
  if (!rows.length) return { record: previous, summary: null };
  const last = rows.length - 1;
  const startedAt = previous?.startedAt ?? rows[last].date;
  const indexOf = new Map(rows.map(({ date }, index) => [date, index]));
  const offset = (date) => Math.round((dayMs(date) - dayMs(rows[0].date)) / DAY);
  const closes = new Map(previous?.closes ?? []);
  for (const { date, close } of rows) if (date >= startedAt) closes.set(date, close);
  const priceOn = new Map([...rows.map(({ date, close }) => [date, close]), ...closes]);
  const events = (previous?.events ?? []).map((event) => ({ ...event, returns: { ...event.returns } }));
  const seen = new Set(events.map(({ rule, date }) => `${rule}:${date}`));
  const evaluated = { ...(previous?.evaluated ?? {}) };

  for (const rule of OBSERVED_RULES) {
    const ready = (row) => rule.needs.every((key) => Number.isFinite(row[key]));
    const lastEvent = events.filter((event) => event.rule === rule.id).map(({ date }) => date).sort().at(-1);
    const from = evaluated[rule.id] ? (indexOf.get(evaluated[rule.id]) ?? -1) + 1 : 1;
    for (const index of ruleEvents(rows, rule, { from, last: lastEvent ? offset(lastEvent) : -Infinity })) {
      const { date } = rows[index];
      if (seen.has(`${rule.id}:${date}`)) continue;
      seen.add(`${rule.id}:${date}`);
      events.push({
        rule: rule.id, date, direction: rule.direction, beforeStart: date < startedAt,
        entryDate: shiftDate(date, 1), entryClose: null, returns: {}, crash30: null
      });
    }
    for (let index = Math.max(from, 1); index <= last; index += 1) if (ready(rows[index])) evaluated[rule.id] = rows[index].date;
  }

  // Entry at the next day's close, as in the study.
  for (const event of events) {
    const entry = event.entryClose ?? priceOn.get(event.entryDate);
    if (entry === undefined) continue;
    event.entryClose = entry;
    for (const horizon of OBSERVATION_HORIZONS) {
      if (event.returns[horizon] != null) continue;
      const later = priceOn.get(shiftDate(event.entryDate, horizon));
      if (later !== undefined) event.returns[horizon] = round(later / entry - 1);
    }
    if (event.crash30 == null) {
      const path = Array.from({ length: 30 }, (_, k) => priceOn.get(shiftDate(event.entryDate, k + 1)));
      if (path.every((value) => value !== undefined)) event.crash30 = Math.min(...path) / entry - 1 <= -0.2;
    }
  }
  events.sort((left, right) => left.date.localeCompare(right.date) || left.rule.localeCompare(right.rule));

  // Random-day baseline: every day since the start, entered at the next close.
  const days = [...closes.keys()].sort();
  const baseline = (horizon) => days.flatMap((date) => {
    const entry = priceOn.get(shiftDate(date, 1));
    const later = priceOn.get(shiftDate(date, 1 + horizon));
    return entry === undefined || later === undefined ? [] : [later / entry - 1];
  });
  const baseCrash = days.flatMap((date) => {
    const entry = priceOn.get(shiftDate(date, 1));
    const path = Array.from({ length: 30 }, (_, k) => priceOn.get(shiftDate(date, k + 2)));
    return entry === undefined || path.some((value) => value === undefined) ? [] : [Math.min(...path) / entry - 1 <= -0.2];
  });

  const now = rows[last];
  const summary = {
    startedAt,
    asOf: now.date,
    minEvents: OBSERVATION_MIN_EVENTS,
    inputs: {
      trend: round(now.trend, 2),
      r28: round(now.r28),
      funding7: round(now.funding7),
      funding30: round(mean(recent(rows, last, 30, (x) => x.funding7))),
      fng: Number.isFinite(now.fng) ? now.fng : null,
      macro: Number.isFinite(now.macro) ? now.macro : null,
      dollarChange: round(now.dollarChange),
      realChange: round(now.realChange, 3)
    },
    rules: OBSERVED_RULES.map((rule, ruleIndex) => {
      const mine = events.filter((event) => event.rule === rule.id);
      const after = mine.filter((event) => !event.beforeStart);
      const values = after.map((event) => event.returns[rule.horizon]).filter((value) => value != null).map((value) => rule.direction * value);
      const pool = baseline(rule.horizon).map((value) => rule.direction * value);
      const crashes = after.map((event) => event.crash30).filter((value) => value != null);
      const ready = rule.needs.every((key) => Number.isFinite(now[key]));
      return {
        id: rule.id,
        label: rule.label,
        direction: rule.direction,
        horizon: rule.horizon,
        evidence: rule.evidence,
        today: ready ? rule.test(rows, last) : null,
        lastEvent: mine.length ? { date: mine.at(-1).date, beforeStart: mine.at(-1).beforeStart } : null,
        events: after.length,
        matured: values.length,
        hit: values.length ? round(values.filter((value) => value > 0).length / values.length, 3) : null,
        mean: values.length ? round(mean(values)) : null,
        base: pool.length ? round(mean(pool)) : null,
        p: values.length >= OBSERVATION_MIN_EVENTS && pool.length ? bootstrapP(values, pool, 7919 * (ruleIndex + 1)) : null,
        ...(rule.id === "FUNDING_HOT" ? {
          crashRate: crashes.length ? round(crashes.filter(Boolean).length / crashes.length, 3) : null,
          baseCrashRate: baseCrash.length ? round(baseCrash.filter(Boolean).length / baseCrash.length, 3) : null
        } : {})
      };
    })
  };
  const record = {
    startedAt,
    evaluated,
    events,
    closes: [...closes.entries()].sort(([left], [right]) => left.localeCompare(right))
  };
  return { record, summary };
}
