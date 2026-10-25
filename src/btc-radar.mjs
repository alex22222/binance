import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BTC_RADAR_LEVELS, evaluateBtcRadar, evaluateRadarPosition, pyFixed, pyRound } from "./btc-radar-model.mjs";
import {
  BTC_RADAR_SOURCES,
  createOkxReadOnlyClient,
  loadBtcDailyCloses,
  loadBtcDailyRsi,
  loadBtcMarket,
  loadDcaPosition,
  loadAccountPositions,
  loadGridPositions,
  loadFearGreed,
  loadFearGreedHistory,
  loadFedExpectations,
  loadFundingHistory,
  loadFundingRates,
  loadGoldCloses,
  loadMacroSeries,
  loadOpenInterestChange,
  loadPolymarketMonth,
  loadPolymarketWeek,
  loadSentiment,
  loadTreasuryYields
} from "./btc-radar-sources.mjs";
import { observationRows, updateObservations } from "./btc-observe.mjs";
import { BTC_TREND_LABELS, btcTrendSummary } from "./btc-trend.mjs";
import { dashboardPublicOrigin } from "./dashboard-auth.mjs";
import { sendManagerFeishu } from "./fund-manager-delivery.mjs";
import { btcRadarFreshness } from "./btc-radar-risk.mjs";

export const BTC_RADAR_HISTORY_LIMIT = 180;
const HISTORY_RETENTION_MS = 60 * 86_400_000;

const PUBLIC_SOURCES = [
  ["btcMarket", "BTC 行情", loadBtcMarket],
  ["gold", "黄金", loadGoldCloses],
  ["funding", "资金费率", loadFundingRates],
  ["openInterest", "持仓量", loadOpenInterestChange],
  ["fed", "美联储利率预期", loadFedExpectations],
  ["treasury", "美债收益率", loadTreasuryYields]
];

// Displayed beside the factors but never scored.
const REFERENCE_SOURCES = [
  ["polyWeek", "Polymarket 本周", loadPolymarketWeek],
  ["polyMonth", "Polymarket 本月", loadPolymarketMonth],
  ["rsi", "BTC 日线 RSI", loadBtcDailyRsi],
  ["fearGreed", "恐惧贪婪指数", loadFearGreed],
  ["trend", "BTC 200 日均线", loadBtcDailyCloses]
];

// Observation mode only (src/btc-observe.mjs): recorded and shown, never
// scored or pushed. The daily closes come from the trend source above.
const OBSERVATION_SOURCES = [
  ["fearGreedHistory", "恐惧贪婪历史", loadFearGreedHistory],
  ["fundingHistory", "资金费率历史", loadFundingHistory],
  ["macro", "美元与实际利率", loadMacroSeries]
];

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

// Daily snapshots: the first evaluation at or after 08:00 Beijing time, just
// after the UTC daily close, is kept for that Beijing date beside the
// completed UTC daily closes, so each score can be set against what BTC did
// afterwards. Kept far longer than the four-hour history.
export const BTC_RADAR_DAILY_HOUR = 8;
export const BTC_RADAR_FORWARD_DAYS = Object.freeze([1, 7, 30]);
export const BTC_RADAR_MIN_SAMPLES = 20;
const DAILY_LIMIT = 1000;
const DAILY_CLOSE_CONTEXT_DAYS = 30;
const SCORE_BANDS = Object.freeze([["green", -Infinity, 40], ["yellow", 40, 55], ["orange", 55, 70], ["red", 70, Infinity]]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export function updateBtcRadarDaily(daily, entries, closes = []) {
  const snapshots = new Map((daily?.snapshots || []).map((row) => [row.date, row]));
  for (const entry of entries) {
    const date = String(entry.ts).slice(0, 10);
    if (!DATE.test(date) || !(Number(String(entry.ts).slice(11, 13)) >= BTC_RADAR_DAILY_HOUR) || snapshots.has(date)) continue;
    if (!Number.isFinite(entry.score) || !(entry.price > 0)) continue;
    snapshots.set(date, {
      date, ts: entry.ts, modelVersion: entry.modelVersion || "legacy", score: entry.score, level: entry.level, price: entry.price, f: entry.f,
      ...(entry.sourceErrors ? { staleSources: entry.sourceErrors.map(({ key }) => key) } : {})
    });
  }
  const byDate = new Map((daily?.closes || []).map(({ date, close }) => [date, close]));
  for (const { date, close } of closes) if (DATE.test(date) && close > 0) byDate.set(date, close);
  return {
    schemaVersion: 1,
    snapshots: [...snapshots.values()].sort((left, right) => left.date.localeCompare(right.date)).slice(-DAILY_LIMIT),
    closes: [...byDate].map(([date, close]) => ({ date, close })).sort((left, right) => left.date.localeCompare(right.date)).slice(-DAILY_LIMIT)
  };
}

// Spearman rank correlation with average ranks for ties.
function spearman(pairs) {
  const ranks = (values) => {
    const order = values.map((value, index) => [value, index]).sort((left, right) => left[0] - right[0]);
    const result = [];
    for (let start = 0; start < order.length;) {
      let end = start;
      while (end + 1 < order.length && order[end + 1][0] === order[start][0]) end += 1;
      for (let index = start; index <= end; index += 1) result[order[index][1]] = (start + end) / 2;
      start = end + 1;
    }
    return result;
  };
  const x = ranks(pairs.map(([score]) => score));
  const y = ranks(pairs.map(([, value]) => value));
  const mx = average(x);
  const my = average(y);
  const cov = x.reduce((sum, value, index) => sum + (value - mx) * (y[index] - my), 0);
  const spread = Math.sqrt(x.reduce((sum, value) => sum + (value - mx) ** 2, 0) * y.reduce((sum, value) => sum + (value - my) ** 2, 0));
  return spread ? cov / spread : null;
}

// The current version only stopped scoring Polymarket and reweighted the five
// unchanged factor formulas (0c79337), so a legacy day's saved factor scores
// give its current-version score exactly, rounded as the model rounds it.
const RESCORE_FROM_LEGACY = Object.freeze({ "pressure-v2-no-touch-probability": Object.freeze({ fed: 20, ust: 20, gold: 10, tech: 15, deriv: 10 }) });
function versionScore(row, modelVersion) {
  if (row.modelVersion === modelVersion) return row.score;
  const weights = row.modelVersion === "legacy" && RESCORE_FROM_LEGACY[modelVersion];
  if (!weights || !Object.keys(weights).every((key) => Number.isFinite(row.f?.[key]))) return null;
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  return pyRound(Object.entries(weights).reduce((sum, [key, weight]) => sum + row.f[key] * weight, 0) / total, 1);
}

// Forward return from the snapshot price to the UTC close about N days later:
// a snapshot on Beijing date D follows the close of UTC day D-1, so N days on
// is the close of UTC day D-1+N.
export function btcRadarDailyView(daily, modelVersion) {
  const closes = daily?.closes || [];
  const closeOn = new Map(closes.map(({ date, close }) => [date, close]));
  const scored = (daily?.snapshots || []).map((row) => [row, versionScore(row, modelVersion)]);
  const snapshots = scored.filter(([row, score]) => Number.isFinite(score) && row.price > 0)
    .map(([row, score]) => ({ ...row, score, level: SCORE_BANDS.find(([, low, high]) => score >= low && score < high)[0],
      ...(row.modelVersion === modelVersion ? {} : { modelVersion, rescoredFrom: { modelVersion: row.modelVersion, score: row.score } }),
      forward: Object.fromEntries(BTC_RADAR_FORWARD_DAYS.map((days) => {
        const close = closeOn.get(addDays(row.date, days - 1));
        return [days, close > 0 ? close / row.price - 1 : null];
      })) }));
  const horizons = BTC_RADAR_FORWARD_DAYS.map((days) => {
    const pairs = snapshots.filter((row) => row.forward[days] !== null).map((row) => [row.score, row.forward[days]]);
    return {
      days, matured: pairs.length, mean: average(pairs.map(([, value]) => value)),
      spearman: pairs.length >= BTC_RADAR_MIN_SAMPLES ? spearman(pairs) : null,
      bands: SCORE_BANDS.map(([level, low, high]) => {
        const values = pairs.filter(([score]) => score >= low && score < high).map(([, value]) => value);
        return { level, n: values.length, mean: average(values), downShare: values.length ? values.filter((value) => value < 0).length / values.length : null };
      })
    };
  });
  // Price context: 30 days before the first snapshot, or the last 90 days.
  const last = closes.at(-1)?.date;
  const start = snapshots[0] ? addDays(snapshots[0].date, -DAILY_CLOSE_CONTEXT_DAYS) : last ? addDays(last, -90) : null;
  return {
    dailyHour: BTC_RADAR_DAILY_HOUR, minSamples: BTC_RADAR_MIN_SAMPLES, modelVersion, snapshots, horizons,
    rescoredDays: snapshots.filter((row) => row.rescoredFrom).length,
    otherVersionDays: scored.filter(([, score]) => !Number.isFinite(score)).length,
    closes: start ? closes.filter(({ date }) => date >= start) : []
  };
}

export function beijingTimestamp(nowMs) {
  return `${new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 19)}+08:00`;
}

// A failed source reuses its last successful value and is reported as stale,
// matching the routine's rule; a required source that never succeeded fails
// the run, while an optional one is simply left out.
async function collectSource([key, label, load], previousInputs, context, stale, inputs, { optional = false, reportFailure = false } = {}) {
  try {
    inputs[key] = { value: await load(context), fetchedAt: new Date(context.nowMs).toISOString() };
  } catch (error) {
    const previous = previousInputs[key];
    if (!previous && optional) {
      if (reportFailure) stale.push({ key, label, since: null, error: error.message });
      return;
    }
    if (!previous) throw new Error(`${label}获取失败且没有可沿用的旧值：${error.message}`);
    if (btcRadarFreshness({ ts: previous.fetchedAt }, context.nowMs).expired) {
      if (!optional) throw new Error(`${label}旧值已过期，拒绝重新生成有效评分：${error.message}`);
      stale.push({ key, label, since: previous.fetchedAt, error: error.message });
      inputs[key] = { ...previous, expired: true }; // Keep evidence, never use it as a current reference.
      return;
    }
    inputs[key] = previous;
    stale.push({ key, label, since: previous.fetchedAt, error: error.message });
  }
}

function okxCredentials(environment) {
  const credentials = {
    apiKey: environment.OKX_API_KEY,
    secretKey: environment.OKX_API_SECRET,
    passphrase: environment.OKX_API_PASSPHRASE
  };
  return Object.values(credentials).every(Boolean) ? credentials : null;
}

const levelRank = (level) => BTC_RADAR_LEVELS.indexOf(level);

export function btcRadarAlertReasons(previous, current, events = []) {
  const reasons = [];
  if (previous && previous.modelVersion === current.modelVersion && levelRank(current.level) > levelRank(previous.level)) reasons.push(`综合等级升至${current.level_name}`);
  for (const now of current.positions || (current.position ? [current.position] : [])) {
    if (now.stale) continue;
    const before = now.id ? previous?.positions?.find((held) => held.id === now.id) : previous?.position || null;
    const label = current.positions ? `${now.source === "grid" ? "合约网格" : now.source === "account" ? "普通永续" : "马丁格尔"}${now.direction === "short" ? "空头" : "多头"}：` : "";
    if (now.level === "red") reasons.push(`${label}${now.risk_reason ? now.level_name : "持仓距止损不到 3%"}`);
    else if (before?.level === "green" && now.level === "orange") reasons.push(`${label}${now.risk_reason ? now.level_name : "持仓离止损不到 5%"}`);
    if (before && now.safety_filled > before.safety_filled) reasons.push(`${label}自动补仓增加到 ${now.safety_filled}/${now.safety_max}`);
    if (!(now.sl > 0) && (!before || before.sl > 0)) reasons.push(`${label}${now.source && now.source !== "dca" ? "固定价格止损未确认" : "持仓没有止损"}`);
  }
  for (const event of events) {
    reasons.push(event.type === "STRATEGY_ENDED"
      ? `合约马丁格尔 ${event.algoId} 已结束（${event.state}）`
      : `改为跟踪新的合约马丁格尔 ${event.algoId}`);
  }
  if (previous?.price > 0 && Math.abs(current.price / previous.price - 1) > 0.04) {
    reasons.push(`BTC 较上次评估变动 ${pyFixed((current.price / previous.price - 1) * 100, 1, { sign: true })}%`);
  }
  return reasons;
}

export function btcRadarAlertText(snapshot, reasons, environment = process.env) {
  const top = [...snapshot.factors].sort((left, right) => right.score * right.weight - left.score * left.weight).slice(0, 2);
  const position = snapshot.position;
  const distance = (value) => value == null ? "未确认" : `${pyFixed(value, 2, { sign: true })}%`;
  const lines = [
    `[BTC 风控雷达] ⚠️ 需要关注：${reasons.join("；")}`,
    `综合 ${pyFixed(snapshot.score, 0)} 分（${snapshot.level_name}），主要压力：${top.map(({ name }) => name).join("、")}`,
    position
      ? `现价 ${pyFixed(snapshot.price, 0, { grouping: true })}；距止损 ${distance(position.d_sl)}，距强平 ${distance(position.d_liq)}，距止盈 ${distance(position.d_tp)}`
      : `现价 ${pyFixed(snapshot.price, 0, { grouping: true })}；未接入持仓`
  ];
  if (snapshot.positions?.length) {
    lines.splice(2);
    lines.push(`BTC 现价 ${pyFixed(snapshot.price, 0, { grouping: true })}`);
    for (const held of snapshot.positions) {
      lines.push(`${held.source === "grid" ? "合约网格" : held.source === "account" ? "普通永续" : "马丁格尔"} · ${held.direction === "short" ? "做空" : "做多"}${held.stale ? "（旧数据）" : ""} · ${held.sz_btc} BTC；距止损 ${distance(held.d_sl)}，距强平 ${distance(held.d_liq)}，距止盈 ${distance(held.d_tp)}`);
    }
  } else if (position) lines.push(position.source && position.source !== "dca"
    ? `${position.source === "grid" ? "合约网格" : "普通永续"} · ${position.direction === "short" ? "做空" : "做多"} · 浮动盈亏 ${position.unrealized_pnl ?? "未确认"} USDT`
    : `策略总收益 ${position.total_pnl} USDT · 补仓 ${position.safety_filled}/${position.safety_max}`);
  const link = radarLink(environment);
  if (link) lines.push(link);
  return lines.join("\n");
}

function radarLink(environment) {
  try {
    const origin = new URL(dashboardPublicOrigin(environment));
    return origin.protocol === "https:" ? `看板：${origin.origin}/btc-radar` : null;
  } catch {
    return null; // No public dashboard link configured.
  }
}

// Pushed once for each switch between the long and avoid environments.
export function btcTrendAlertText(trend, snapshot, environment = process.env) {
  const band = pyFixed(trend.band * 100, 0);
  const references = [`雷达 ${pyFixed(snapshot.score, 0)} 分（${snapshot.level_name}）`];
  const { fearGreed, rsi14 } = snapshot.indicators || {};
  if (fearGreed) references.push(`恐惧贪婪 ${fearGreed.value}（${fearGreed.label}）`);
  if (rsi14) references.push(`日线 RSI ${rsi14.closed}`);
  const funding = snapshot.factors.find(({ key }) => key === "deriv")?.metrics?.[0];
  if (funding) references.push(funding.join(" "));
  const lines = [
    `[BTC 趋势状态] 切换为${BTC_TREND_LABELS[trend.state]}`,
    `${trend.date} 日收盘 ${pyFixed(trend.close, 0, { grouping: true })}，${trend.distance >= 0 ? "高于" : "低于"} 200 日均线 ${pyFixed(trend.average, 0, { grouping: true })} 约 ${pyFixed(Math.abs(trend.distance) * 100, 1)}%（切换线 ±${band}%）`,
    ...(trend.previous ? [`此前：${BTC_TREND_LABELS[trend.previous]}`] : []),
    `参考（回测中没有稳定预测力）：${references.join(" · ")}`,
    `规则：日收盘高于 200 日均线 ${band}% 以上为多头环境，低于 ${band}% 以下为回避环境。回避只表示不持有多头，不是做空信号。`
  ];
  const link = radarLink(environment);
  if (link) lines.push(link);
  return lines.join("\n");
}

const feishuConfigured = (environment) => Boolean(
  environment.FEISHU_WEBHOOK_URL || (environment.FEISHU_APP_ID && environment.FEISHU_APP_SECRET && environment.FEISHU_RECEIVE_ID)
);

export async function runBtcRadar({
  directory,
  environment = process.env,
  fetchImpl = fetch,
  nowMs = Date.now(),
  send = sendManagerFeishu
}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const paths = Object.fromEntries(["latest", "history", "inputs", "state", "observations", "daily"].map((name) => [name, join(directory, `${name}.json`)]));
  const [previous, history, previousInputs, state, observations, daily] = await Promise.all([
    readJson(paths.latest, null), readJson(paths.history, []), readJson(paths.inputs, {}), readJson(paths.state, {}),
    readJson(paths.observations, null),
    // An unreadable daily file must not stop the evaluation; it is left as is.
    readJson(paths.daily, null).catch(() => undefined)
  ]);
  const context = { fetchImpl, nowMs };
  if (!previousInputs.dcaPositions && previousInputs.position) {
    const legacy = previousInputs.position.value;
    const position = legacy ? { ...legacy, id: legacy.id || `dca:${state.trackedAlgoId || "legacy"}`,
      source: "dca", direction: legacy.direction || "long" } : null;
    previousInputs.dcaPositions = { fetchedAt: previousInputs.position.fetchedAt,
      value: { position, positions: position ? [position] : [], algoId: state.trackedAlgoId || null } };
  }
  const inputs = {};
  const stale = [];
  await Promise.all([
    ...PUBLIC_SOURCES.map((source) => collectSource(source, previousInputs, context, stale, inputs)),
    ...[...REFERENCE_SOURCES, ...OBSERVATION_SOURCES].map((source) => collectSource(source, previousInputs, context, stale, inputs, { optional: true }))
  ]);

  const credentials = okxCredentials(environment);
  let events = [];
  let algoId = state.trackedAlgoId || null;
  if (credentials) {
    const privateGet = createOkxReadOnlyClient({ ...credentials, fetchImpl });
    await collectSource(["sentiment", "OKX 舆情", () => loadSentiment(privateGet)], previousInputs, context, stale, inputs);
    await collectSource(["dcaPositions", "OKX 合约马丁格尔", async () => {
      const result = await loadDcaPosition(privateGet, {
        pinnedAlgoId: environment.BTC_RADAR_DCA_ALGO_ID || null,
        trackedAlgoId: state.trackedAlgoId || null,
        includeAll: true
      });
      events = result.events;
      algoId = result.algoId;
      return result;
    }], previousInputs, context, stale, inputs, { optional: true, reportFailure: true });
    await Promise.all([
      collectSource(["accountPositions", "OKX 普通永续", () => loadAccountPositions(privateGet)], previousInputs, context, stale, inputs, { optional: true, reportFailure: true }),
      collectSource(["gridPositions", "OKX 合约网格", () => loadGridPositions(privateGet)], previousInputs, context, stale, inputs, { optional: true, reportFailure: true })
    ]);
  }

  const positions = [
    ["dcaPositions", inputs.dcaPositions?.value.positions || []],
    ["accountPositions", inputs.accountPositions?.value || []],
    ["gridPositions", inputs.gridPositions?.value || []]
  ].flatMap(([key, held]) => held.map((position) => ({ ...position,
    fetchedAt: inputs[key].fetchedAt, stale: stale.some((source) => source.key === key) })));
  const primary = positions.find((held) => held.id === inputs.dcaPositions?.value.position?.id) || positions[0] || null;

  const snapshot = evaluateBtcRadar({
    ts: beijingTimestamp(nowMs),
    price: inputs.btcMarket.value.price,
    btc_closes: inputs.btcMarket.value.btc_closes,
    gold_closes: inputs.gold.value,
    funding: inputs.funding.value,
    oi_7d_change_pct: inputs.openInterest.value,
    sentiment: inputs.sentiment?.value ?? null,
    poly_week: inputs.polyWeek?.expired ? null : inputs.polyWeek?.value,
    poly_month: inputs.polyMonth?.expired ? null : inputs.polyMonth?.value,
    fed: inputs.fed.value,
    treasury: inputs.treasury.value,
    position: primary,
    sources: BTC_RADAR_SOURCES
  });
  snapshot.positions = positions.map((held) => evaluateRadarPosition(held, inputs.btcMarket.value.price));
  snapshot.indicators = {
    rsi14: inputs.rsi?.expired ? null : inputs.rsi?.value ?? null,
    fearGreed: inputs.fearGreed?.expired ? null : inputs.fearGreed?.value ?? null
  };
  snapshot.trend = inputs.trend && !inputs.trend.expired ? btcTrendSummary(inputs.trend.value) : null;
  snapshot.observation = null;
  if ([inputs.trend, inputs.fearGreedHistory, inputs.fundingHistory].every(source => source && !source.expired)) {
    const { record, summary } = updateObservations(observations, observationRows({
      closes: inputs.trend.value,
      fearGreed: inputs.fearGreedHistory.value,
      funding: inputs.fundingHistory.value,
      dollar: inputs.macro?.expired ? undefined : inputs.macro?.value.dollar,
      realYield: inputs.macro?.expired ? undefined : inputs.macro?.value.realYield
    }));
    await writeJson(paths.observations, record);
    snapshot.observation = summary;
  }
  snapshot.data_status = {
    okxConfigured: Boolean(credentials),
    algoId,
    sourceFetchedAt: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value.fetchedAt])),
    staleSources: stale.map(({ key, label, since }) => ({ key, label, since })),
    ...(stale.length ? { sourceErrors: stale.map(({ key, since, error }) => ({ key, since, error })) } : {})
  };

  const entry = {
    ts: snapshot.ts,
    modelVersion: snapshot.modelVersion,
    price: snapshot.price,
    score: snapshot.score,
    level: snapshot.level,
    f: Object.fromEntries(snapshot.factors.map(({ key, score }) => [key, score])),
    ...(snapshot.data_status.sourceErrors ? { sourceErrors: snapshot.data_status.sourceErrors } : {})
  };
  const nextHistory = [...history.filter(({ ts }) => ts !== entry.ts), entry]
    .filter(({ ts }) => nowMs - Date.parse(ts) <= HISTORY_RETENTION_MS)
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  await writeJson(paths.latest, snapshot);
  await writeJson(paths.history, nextHistory);
  await writeJson(paths.inputs, inputs);
  // The first daily file is seeded from the retained four-hour history.
  if (daily !== undefined) {
    await writeJson(paths.daily, updateBtcRadarDaily(daily, daily ? [entry] : nextHistory,
      inputs.trend && !inputs.trend.expired ? inputs.trend.value : []));
  }

  const reasons = btcRadarAlertReasons(previous, snapshot, events);
  let alert = { status: reasons.length ? "PENDING" : "NONE", reasons };
  if (reasons.length && !feishuConfigured(environment)) alert = { status: "SKIPPED_NO_FEISHU", reasons };
  else if (reasons.length) {
    const uuid = createHash("sha256").update(`btc-radar:${snapshot.ts}`).digest("hex").slice(0, 40);
    try {
      await send(btcRadarAlertText(snapshot, reasons, environment), uuid, environment, fetchImpl, null);
      alert = { status: "SENT", reasons };
    } catch (error) {
      alert = { status: "FAILED", reasons, error: error.message };
    }
  }

  // The first trend state seen is adopted silently; after that each switch is
  // pushed once, and a failed push is retried on the next run.
  const trend = snapshot.trend;
  let notified = state.trend?.notified ?? null;
  let trendAlert = { status: "NONE" };
  if (trend?.state && !notified) notified = trend.state;
  else if (trend?.state && trend.state !== notified) {
    if (!feishuConfigured(environment)) {
      trendAlert = { status: "SKIPPED_NO_FEISHU", state: trend.state };
      notified = trend.state;
    } else {
      const uuid = createHash("sha256").update(`btc-trend:${trend.date}:${trend.state}`).digest("hex").slice(0, 40);
      try {
        await send(btcTrendAlertText(trend, snapshot, environment), uuid, environment, fetchImpl, null);
        trendAlert = { status: "SENT", state: trend.state };
        notified = trend.state;
      } catch (error) {
        trendAlert = { status: "FAILED", state: trend.state, error: error.message };
      }
    }
  }
  await writeJson(paths.state, {
    trackedAlgoId: algoId,
    lastRunAt: new Date(nowMs).toISOString(),
    lastAlert: { ts: snapshot.ts, ...alert },
    trend: { notified, lastAlert: trendAlert.status === "NONE" ? state.trend?.lastAlert ?? null : { ts: snapshot.ts, ...trendAlert } }
  });
  return { snapshot, alert, trendAlert };
}

// Operator settings for the page, such as total capital for the loss share.
export async function loadBtcRadarSettings(directory) {
  try {
    const settings = await readJson(join(directory, "settings.json"), {});
    return Number(settings.capitalUsdt) > 0 ? { capitalUsdt: Number(settings.capitalUsdt), updatedAt: settings.updatedAt || null } : {};
  } catch {
    return {};
  }
}

export async function saveBtcRadarSettings(directory, { capitalUsdt } = {}, nowMs = Date.now()) {
  const numeric = typeof capitalUsdt === "number" || (typeof capitalUsdt === "string" && capitalUsdt.trim() !== "");
  const value = capitalUsdt === null || capitalUsdt === "" ? null : numeric ? Number(capitalUsdt) : Number.NaN;
  if (value !== null && !(Number.isFinite(value) && value > 0 && value <= 1e9)) {
    const error = new Error("总资金必须是大于 0 的数字");
    error.statusCode = 400;
    throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const settings = value === null ? {} : { capitalUsdt: Number(value.toFixed(2)), updatedAt: new Date(nowMs).toISOString() };
  await writeJson(join(directory, "settings.json"), settings);
  return settings;
}

export async function loadBtcRadarView(directory, nowMs = Date.now()) {
  const settings = await loadBtcRadarSettings(directory);
  try {
    const latest = await readJson(join(directory, "latest.json"), null);
    if (!latest) return { status: "MISSING", latest: null, history: [], settings };
    const history = await readJson(join(directory, "history.json"), []);
    const freshness = btcRadarFreshness(latest, nowMs);
    const positions = (latest.positions || (latest.position ? [latest.position] : [])).map(held => {
      const stale = held.stale || btcRadarFreshness({ ts: held.fetchedAt || latest.ts }, nowMs).expired;
      return { ...held, p_sl_week: null, p_tp_week: null,
        ...(freshness.expired || stale ? { stale: true, level: "yellow", level_name: "持仓数据失效" } : {}) };
    });
    const position = positions.find(held => held.id === latest.position?.id) || positions[0] || null;
    // Saved daily evidence stays visible when the current conclusion expires.
    let daily = null;
    try {
      const saved = await readJson(join(directory, "daily.json"), null);
      daily = btcRadarDailyView(saved || updateBtcRadarDaily(null, history,
        (await readJson(join(directory, "inputs.json"), {}))?.trend?.value || []), latest.modelVersion);
    } catch {}
    return { status: freshness.expired ? "STALE" : "AVAILABLE", latest: {
      ...latest, positions, position,
      ...(freshness.expired ? { score: null, level: "unknown", level_name: "数据失效", summary: "评估版本或数据时效失效，仅保留历史快照。", factors: freshness.expiredSources.includes("modelVersion") ? [] : (latest.factors || []).map(f => ({ ...f, score: null })) } : {})
    }, history: history.slice(-BTC_RADAR_HISTORY_LIMIT), daily, settings, freshness };
  } catch {
    return { status: "ERROR", latest: null, history: [], settings };
  }
}
