import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BTC_RADAR_LEVELS, evaluateBtcRadar, evaluateRadarPosition, pyFixed } from "./btc-radar-model.mjs";
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

export const BTC_RADAR_HISTORY_LIMIT = 180;
const HISTORY_RETENTION_MS = 60 * 86_400_000;

const PUBLIC_SOURCES = [
  ["btcMarket", "BTC 行情", loadBtcMarket],
  ["gold", "黄金", loadGoldCloses],
  ["funding", "资金费率", loadFundingRates],
  ["openInterest", "持仓量", loadOpenInterestChange],
  ["polyWeek", "Polymarket 本周", loadPolymarketWeek],
  ["polyMonth", "Polymarket 本月", loadPolymarketMonth],
  ["fed", "美联储利率预期", loadFedExpectations],
  ["treasury", "美债收益率", loadTreasuryYields]
];

// Displayed beside the factors but never scored.
const REFERENCE_SOURCES = [
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
  if (previous && levelRank(current.level) > levelRank(previous.level)) reasons.push(`综合等级升至${current.level_name}`);
  for (const now of current.positions || (current.position ? [current.position] : [])) {
    if (now.stale) continue;
    const before = now.id ? previous?.positions?.find((held) => held.id === now.id) : previous?.position || null;
    const label = current.positions ? `${now.source === "grid" ? "合约网格" : now.source === "account" ? "普通永续" : "马丁格尔"}${now.direction === "short" ? "空头" : "多头"}：` : "";
    if (now.level === "red") reasons.push(`${label}持仓距止损不到 3%`);
    else if (before?.level === "green" && now.level === "orange") reasons.push(`${label}持仓离止损不到 5%`);
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
  const paths = Object.fromEntries(["latest", "history", "inputs", "state", "observations"].map((name) => [name, join(directory, `${name}.json`)]));
  const [previous, history, previousInputs, state, observations] = await Promise.all([
    readJson(paths.latest, null), readJson(paths.history, []), readJson(paths.inputs, {}), readJson(paths.state, {}),
    readJson(paths.observations, null)
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
    poly_week: inputs.polyWeek.value,
    poly_month: inputs.polyMonth.value,
    fed: inputs.fed.value,
    treasury: inputs.treasury.value,
    position: primary,
    sources: BTC_RADAR_SOURCES
  });
  snapshot.positions = positions.map((held) => evaluateRadarPosition(held, inputs.btcMarket.value.price, inputs.polyWeek.value));
  // The page interpolates dragged stop and take-profit levels on this ladder.
  snapshot.ladders = { week: inputs.polyWeek.value };
  snapshot.indicators = {
    rsi14: inputs.rsi?.value ?? null,
    fearGreed: inputs.fearGreed?.value ?? null
  };
  snapshot.trend = inputs.trend ? btcTrendSummary(inputs.trend.value) : null;
  snapshot.observation = null;
  if (inputs.trend && inputs.fearGreedHistory && inputs.fundingHistory) {
    const { record, summary } = updateObservations(observations, observationRows({
      closes: inputs.trend.value,
      fearGreed: inputs.fearGreedHistory.value,
      funding: inputs.fundingHistory.value,
      dollar: inputs.macro?.value.dollar,
      realYield: inputs.macro?.value.realYield
    }));
    await writeJson(paths.observations, record);
    snapshot.observation = summary;
  }
  snapshot.data_status = {
    okxConfigured: Boolean(credentials),
    algoId,
    staleSources: stale.map(({ key, label, since }) => ({ key, label, since })),
    ...(stale.length ? { sourceErrors: stale.map(({ key, since, error }) => ({ key, since, error })) } : {})
  };

  const entry = {
    ts: snapshot.ts,
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

export async function loadBtcRadarView(directory) {
  const settings = await loadBtcRadarSettings(directory);
  try {
    const latest = await readJson(join(directory, "latest.json"), null);
    if (!latest) return { status: "MISSING", latest: null, history: [], settings };
    const history = await readJson(join(directory, "history.json"), []);
    return { status: "AVAILABLE", latest, history: history.slice(-BTC_RADAR_HISTORY_LIMIT), settings };
  } catch {
    return { status: "ERROR", latest: null, history: [], settings };
  }
}
