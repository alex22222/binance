import { readAssetAiStatus, reviewPersonalAssets, configureAssetAi } from "./personal-assets-ai.mjs";
import { readAssetFundStatus, configureAssetFund } from "./personal-assets-funds.mjs";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { personalAssetsHtml, statementPasswordsHtml, refreshScheduleHtml, operationsHtml } from "./personal-assets-html.mjs";
import { readPersonalAssets, savePersonalAssets, createPersonalAssetsSnapshot, readStatementPasswordStatus, configureStatementPassword, readAssetRefreshSchedule, configureAssetRefreshSchedule } from "./personal-assets.mjs";
import { valuePersonalAssetState } from "./personal-assets-fx.mjs";
import { readAssetSyncStatus, performAssetSyncAction, completeFutuAuthorization } from "./personal-assets-sync.mjs";

const sourceFile = (name) => fileURLToPath(new URL(name, import.meta.url));
const files = new Map([
  ["/assets/app.mjs", { path: sourceFile("personal-assets-client.mjs"), type: "text/javascript; charset=utf-8" }],
  ["/assets/core.mjs", { path: sourceFile("personal-assets-core.mjs"), type: "text/javascript; charset=utf-8" }]
]);
for (const name of [
  "tesseract.min.js", "tesseract.min.js.LICENSE.txt", "worker.min.js", "worker.min.js.LICENSE.txt", "NOTICE.txt",
  "core/LICENSE", "core/tesseract-core-lstm.wasm.js", "core/tesseract-core-simd-lstm.wasm.js", "core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "lang/eng.traineddata.gz", "lang/chi_sim.traineddata.gz", "lang/chi_tra.traineddata.gz"
]) {
  files.set(`/assets/ocr/${name}`, {
    path: sourceFile(`../assets/personal-assets/ocr/${name}`),
    type: name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".gz") ? "application/gzip" : "text/plain; charset=utf-8"
  });
}

function requestError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function json(response, data, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function sessionBinding(request) {
  const session = String(request.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("dashboard_session="));
  return session || request.headers.authorization || "";
}

async function assetView(state, options) {
  const [valued, sync, refreshSchedule] = await Promise.all([valuePersonalAssetState(state, options), readAssetSyncStatus({ stateDir: options.stateDir }).catch(() => ({
    status: "unavailable", error: "同步状态暂不可用，请检查同步配置；已保存资产仍可查看。", providers: {},
  })), readAssetRefreshSchedule({ stateDir: options.stateDir }).catch(() => ({ status: "unavailable" }))]);
  const funds = await readAssetFundStatus({ stateDir: options.stateDir, state }).catch(() => ({ status: "unavailable", bindings: [] }));
  return { ...valued, funds, refreshSchedule, sync: { ...sync, providers: Object.fromEntries(Object.entries(sync.providers).map(([name, details]) => {
    const { preview, accounts, selectedAccountId, wallets, ...summary } = details;
    return [name, summary];
  })) } };
}

async function readAssetBody(request) {
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw requestError("请使用 JSON 格式提交资产。", 415);
  }
  const body = await new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let oversized = false;
    request.on("data", (chunk) => {
      if (oversized) return;
      size += chunk.length;
      if (size > 1_500_000) {
        oversized = true;
        chunks = [];
        reject(requestError("资产数据过大，请减少本次记录数量。", 413));
      } else chunks.push(chunk);
    });
    request.once("end", () => { if (!oversized) resolve(Buffer.concat(chunks).toString("utf8")); });
    request.once("error", reject);
  });
  try {
    const data = JSON.parse(body);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw requestError("无法读取资产数据，请检查格式。", 400);
  }
}

// Called only after the Dashboard's shared authentication gate.
// Run overview. This module is already in the Dashboard-only release, so the
// overview lives here rather than in a new module the release loader would have
// to admit. Each binance* systemd timer reports its last run, result and next
// trigger; where its output is readable by the Dashboard user, the page also
// shows the date that output's data runs to. Nothing here writes or triggers.
const RENEWAL_STATUS_PATH = "/var/lib/binance-agentic-authorization/public-status.json";
const latestTime = (values) => values.filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
  .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
const sessionDate = (json) => json.lastObservation?.sessionDate;
export const OPERATIONS_TASKS = Object.freeze([
  { unit: "binance-agentic-authorization", group: "交易与风控", label: "交易授权续签", cadence: "每分钟", renewal: true },
  { unit: "binance-agentic-btc-radar", group: "交易与风控", label: "BTC 风控雷达", cadence: "约每 4 小时", file: "btc-radar/state.json", asOf: (json) => json.lastRunAt, staleHours: 12 },
  { unit: "binance-agentic-premarket-brief", group: "交易与风控", label: "盘前简报", cadence: "交易日", dir: "trade-reviews/premarket", asOf: (json) => json.tradingDate, staleHours: 96 },
  { unit: "binance-agentic-trade-review", group: "交易与风控", label: "交易复盘", cadence: "每周", file: "trade-reviews/latest.json", asOf: (json) => json.tradingDate, staleHours: 216 },
  { unit: "binance-agentic-spy-open-check", group: "交易与风控", label: "SPY 开盘检查", cadence: "一次性" },
  { unit: "binance-agentic-strategy-validation", group: "策略研究", label: "策略验证", cadence: "每日", dir: "strategy-validation/reports", asOf: (json) => json.generatedAt, staleHours: 48 },
  { unit: "binance-agentic-strategy-evidence", group: "策略研究", label: "策略证据采集", cadence: "每日", dir: "strategy-evidence", asOf: (json) => json.generatedAt, staleHours: 48 },
  { unit: "binance-agentic-shadow-outcomes", group: "策略研究", label: "影子结果标注", cadence: "交易日", file: "shadow-outcomes/latest.json", asOf: (json) => json.generatedAt, staleHours: 96 },
  { unit: "binance-agentic-turtle-paper", group: "纸面模拟", label: "海龟纸面模拟", cadence: "交易日", file: "turtle-paper/latest.json", asOf: sessionDate, staleHours: 96 },
  { unit: "binance-agentic-weekly-etf-paper", group: "纸面模拟", label: "周度 ETF 轮动", cadence: "交易日", file: "weekly-etf-rotation-paper/latest.json", asOf: sessionDate, staleHours: 96 },
  { unit: "binance-agentic-weekly-etf-defense-paper", group: "纸面模拟", label: "双动量防守", cadence: "交易日", file: "weekly-etf-dual-momentum-paper/latest.json", asOf: sessionDate, staleHours: 96 },
  { unit: "binance-agentic-etf-frequency-paper", group: "纸面模拟", label: "ETF 调仓频率对照", cadence: "交易日", file: "etf-frequency-paper/latest.json", asOf: sessionDate, staleHours: 96 },
  { unit: "binance-personal-assets-sync", group: "个人资产", label: "资产只读同步", cadence: "每分钟检查，每日同步", file: "personal-assets-sync.json", asOf: (json) => latestTime(Object.values(json.providers || {}).map((row) => row?.lastFetchedAt)), staleHours: 36 },
  { unit: "binance-personal-assets-daily-snapshot", group: "个人资产", label: "资产每日快照", cadence: "每日", file: "personal-assets.json", asOf: (json) => json.snapshots?.[0]?.at, staleHours: 36 },
  { unit: "binance-agentic-offhours-research", group: "研究", label: "盘后研究", cadence: "交易日", restricted: true },
  { unit: "binance-agentic-monthly-research", group: "研究", label: "月度研究", cadence: "每月", restricted: true }
]);
const SERVICE_PROPERTIES = ["Id", "LoadState", "ActiveState", "Result", "ExecMainStatus", "ExecMainStartTimestamp", "ExecMainExitTimestamp"];
const TIMER_PROPERTIES = ["Id", "LoadState", "ActiveState", "LastTriggerUSec", "NextElapseUSecRealtime"];
const runSystemctl = (args) => new Promise((resolve, reject) => {
  execFile("systemctl", args, { timeout: 5000, maxBuffer: 1_000_000, env: { ...process.env, SYSTEMD_PAGER: "", LC_ALL: "C" } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});
// `--timestamp=unix` covers service timestamps ("@1792932180"); timer properties
// keep systemd's "Sun 2026-10-25 16:43:39 UTC" form on this host.
function systemdTime(value) {
  if (!value || value === "n/a" || value === "0") return null;
  const unix = /^@(\d+)$/.exec(value);
  if (unix) return new Date(Number(unix[1]) * 1000).toISOString();
  const text = /^[A-Z][a-z]{2} (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(value);
  return text ? new Date(`${text[1]}T${text[2]}Z`).toISOString() : null;
}
function parseSystemctlShow(output) {
  const units = new Map();
  for (const block of output.split(/\n\s*\n/)) {
    const fields = Object.fromEntries(block.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    if (fields.Id) units.set(fields.Id, fields);
  }
  return units;
}
async function newestJson(directory, readText, listDirectory, statFile) {
  const names = (await listDirectory(directory)).filter((name) => name.endsWith(".json") && !name.startsWith("."));
  if (!names.length) return null;
  // Dated report names sort by date; content-addressed names are ordered by modification time.
  let newest = names.every((name) => /^\d{4}-\d{2}-\d{2}/.test(name)) ? names.sort().at(-1) : null;
  if (!newest) {
    const times = await Promise.all(names.map(async (name) => [name, (await statFile(join(directory, name))).mtimeMs]));
    newest = times.sort((a, b) => b[1] - a[1])[0][0];
  }
  return JSON.parse(await readText(join(directory, newest), "utf8"));
}
function renewalView(raw, nowMs) {
  // Same acceptance rules as the authorization component's public parser: a
  // status older than three minutes or with unexpected fields is shown as unverified.
  const valid = raw && raw.schemaVersion === 1 && ["ACTIVE", "HALTED", "EXPIRED", "ERROR"].includes(raw.autoRenewalState)
    && typeof raw.authorizationAllowed === "boolean" && typeof raw.entryControlsOpen === "boolean"
    && [raw.checkedAt, raw.leaseExpiresAt, raw.hardDeadline].every((value) => Number.isFinite(Date.parse(value)));
  const checked = valid ? Date.parse(raw.checkedAt) : NaN;
  if (!valid || checked > nowMs + 60_000 || nowMs - checked > 180_000) return { verified: false, state: null, reason: "STATUS_UNVERIFIED", checkedAt: valid ? raw.checkedAt : null };
  return { verified: true, state: raw.autoRenewalState, reason: /^[A-Z][A-Z0-9_]{0,95}$/.test(raw.reason) ? raw.reason : "REASON_WITHHELD",
    authorizationAllowed: raw.authorizationAllowed && nowMs < Date.parse(raw.leaseExpiresAt) && nowMs < Date.parse(raw.hardDeadline),
    entryControlsOpen: raw.entryControlsOpen, checkedAt: raw.checkedAt, leaseExpiresAt: raw.leaseExpiresAt, hardDeadline: raw.hardDeadline };
}
export async function readOperationsOverview({ stateDir, now = new Date(), systemctl = runSystemctl, readText = readFile, listDirectory = readdir, statFile = stat, renewalPath = RENEWAL_STATUS_PATH } = {}) {
  const nowMs = now.getTime();
  const known = new Set(OPERATIONS_TASKS.map((task) => task.unit));
  let systemdError = null;
  let extra = [];
  try {
    extra = [...new Set((await systemctl(["list-timers", "--all", "--no-legend", "--plain"])).match(/\bbinance[\w.-]*(?=\.timer\b)/g) || [])].filter((unit) => !known.has(unit));
  } catch { systemdError = "无法读取 systemd 定时任务列表"; }
  const tasks = [...OPERATIONS_TASKS, ...extra.map((unit) => ({ unit, group: "其他", label: unit, cadence: "—" }))];
  let units = new Map();
  try {
    units = parseSystemctlShow(await systemctl(["show", ...tasks.map((task) => `${task.unit}.service`), "--timestamp=unix", "--no-pager", "-p", SERVICE_PROPERTIES.join(",")]));
    for (const [id, fields] of parseSystemctlShow(await systemctl(["show", ...tasks.map((task) => `${task.unit}.timer`), "--no-pager", "-p", TIMER_PROPERTIES.join(",")]))) units.set(id, fields);
  } catch { systemdError = "无法读取 systemd 运行状态"; }
  let renewal = { verified: false, state: null, reason: "STATUS_UNVERIFIED", checkedAt: null };
  try { renewal = renewalView(JSON.parse(await readText(renewalPath, "utf8")), nowMs); } catch {}
  const rows = await Promise.all(tasks.map(async (task) => {
    const service = units.get(`${task.unit}.service`) || {};
    const timer = units.get(`${task.unit}.timer`) || {};
    const row = { unit: task.unit, group: task.group, label: task.label, cadence: task.cadence,
      startedAt: systemdTime(service.ExecMainStartTimestamp), finishedAt: systemdTime(service.ExecMainExitTimestamp),
      lastTriggerAt: systemdTime(timer.LastTriggerUSec), nextRunAt: systemdTime(timer.NextElapseUSecRealtime),
      result: service.Result || null, exitStatus: service.ExecMainStatus ?? null, dataAsOf: null, dataNote: null };
    if (task.renewal) {
      row.dataAsOf = renewal.checkedAt;
      row.dataNote = renewal.verified ? `续签 ${renewal.state} · ${renewal.reason}` : "续签状态未核实";
    } else if (task.restricted) {
      row.dataNote = "产物目录仅研究账户可读，只显示调度状态";
    } else if (task.file || task.dir) {
      try {
        const json = task.file ? JSON.parse(await readText(join(stateDir, task.file), "utf8")) : await newestJson(join(stateDir, task.dir), readText, listDirectory, statFile);
        const value = json && task.asOf(json);
        row.dataAsOf = typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
        if (!row.dataAsOf) row.dataNote = "产物中没有可核验的数据时间";
      } catch { row.dataNote = "产物不存在或无法读取"; }
    }
    // A trading-session date covers that whole day, so its age counts from the day's end.
    const dataTime = row.dataAsOf ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(row.dataAsOf) ? `${row.dataAsOf}T23:59:59Z` : row.dataAsOf) : NaN;
    const running = ["active", "activating", "reloading"].includes(service.ActiveState);
    row.status = timer.LoadState === "not-found" || !timer.Id ? "missing"
      : running ? "running"
      : service.LoadState === "not-found" && !row.nextRunAt ? "finished"
      : service.Result && service.Result !== "success" ? "failed"
      : task.renewal && !(renewal.verified && renewal.state === "ACTIVE") ? (renewal.verified && renewal.state !== "ERROR" ? "attention" : "failed")
      : !row.startedAt && !row.lastTriggerAt ? "never"
      : task.staleHours && Number.isFinite(dataTime) && nowMs - dataTime > task.staleHours * 3_600_000 ? "stale"
      : "ok";
    return row;
  }));
  const counts = Object.fromEntries(["ok", "running", "failed", "stale", "attention", "never", "finished", "missing"].map((status) => [status, rows.filter((row) => row.status === status).length]));
  return { generatedAt: now.toISOString(), systemdError, renewal, counts, tasks: rows };
}

export async function handlePersonalAssetsRequest({ request, response, stateDir, requireAllowedOrigin }) {
  const path = new URL(request.url, "http://localhost").pathname;
  // The site lands on personal assets. The trading dashboard moved to
  // /dashboard, but the Dashboard entry's own "/" route (which the
  // authorization loader extends) still renders it, so hand the request back.
  // Bot notifications link the bare origin as "打开手机 Dashboard", so Feishu's
  // in-app browser still lands on the trading dashboard.
  if (request.method === "GET" && path === "/") {
    const feishu = /\b(?:Lark|Feishu)\/|\bLarkLocale\//i.test(String(request.headers["user-agent"] || ""));
    response.writeHead(302, { Location: feishu ? "/dashboard" : "/assets", Vary: "User-Agent", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end();
    return true;
  }
  if (request.method === "GET" && ["/dashboard", "/dashboard/"].includes(path)) {
    request.url = "/";
    return false;
  }
  if (request.method === "GET" && ["/operations", "/operations/", "/api/operations"].includes(path)) {
    const overview = await readOperationsOverview({ stateDir });
    if (path === "/api/operations") { json(response, overview); return true; }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Server-rendered with no script; the page refreshes itself once a minute.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(operationsHtml(overview));
    return true;
  }
  const assetApi = ["/api/assets", "/api/assets/snapshots", "/api/assets/rates/refresh", "/api/assets/funds/configure"].includes(path);
  const refreshApi = path === "/api/assets/refresh-schedule";
  const refreshPage = ["/assets", "/assets/"].includes(path) && new URL(request.url, "http://localhost").searchParams.get("settings") === "refresh-schedule";
  const statementApi = path === "/api/assets/statement-passwords";
  const statementPage = ["/assets", "/assets/"].includes(path) && new URL(request.url, "http://localhost").searchParams.get("settings") === "statement-passwords";
  const syncAction = path.match(/^\/api\/assets\/sync\/(okx|futu|polymarket|future|okxweb3|tokenpocket|binanceagentic|okxagentic)\/(bind|connect|authorize|accounts|preview|apply|disconnect)$/);
  const aiApi = ["/api/assets/ai", "/api/assets/ai/review", "/api/assets/ai/configure"].includes(path);
  const syncApi = path === "/api/assets/sync" || path === "/api/assets/sync/futu/callback" || syncAction;
  const file = files.get(path);
  if (!["/assets", "/assets/"].includes(path) && !assetApi && !syncApi && !aiApi && !statementApi && !refreshApi && !file) return false;
  try {
    if (request.method === "GET" && path === "/api/assets/sync/futu/callback") {
      let success = false;
      try {
        await completeFutuAuthorization({ stateDir, query: Object.fromEntries(new URL(request.url, "http://localhost").searchParams), sessionBinding: sessionBinding(request) });
        success = true;
      } catch {}
      response.writeHead(303, { Location: `/assets?sync=${success ? "futu-authorized" : "futu-error"}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      response.end();
      return true;
    }
    if (request.method === "GET" && ["/assets", "/assets/"].includes(path)) {
      const nonce = randomBytes(16).toString("base64");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "X-Content-Type-Options": "nosniff"
      });
      response.end(refreshPage ? refreshScheduleHtml({ nonce }) : statementPage ? statementPasswordsHtml({ nonce }) : personalAssetsHtml({ nonce }));
      return true;
    }
    if (request.method === "GET" && file) {
      const body = await readFile(file.path);
      response.writeHead(200, {
        "Content-Type": file.type,
        "Cache-Control": path.endsWith(".mjs") ? "no-store" : "private, max-age=86400",
        "Content-Length": body.length,
        "X-Content-Type-Options": "nosniff"
      });
      response.end(body);
      return true;
    }
    if (request.method === "GET" && path === "/api/assets") {
      json(response, await assetView(await readPersonalAssets({ stateDir }), { stateDir }));
      return true;
    }
    if (request.method === "GET" && refreshApi) {
      json(response, await readAssetRefreshSchedule({ stateDir }));
      return true;
    }
    if (request.method === "POST" && refreshApi) {
      if (!request.headers.origin) throw requestError("请从自动更新设置页面提交。", 403);
      requireAllowedOrigin(request);
      const body = await readAssetBody(request);
      if (Object.keys(body).some(key => key !== "time")) throw requestError("自动更新配置字段无效。", 400);
      json(response, await configureAssetRefreshSchedule({ stateDir, time: body.time }));
      return true;
    }
    if (request.method === "GET" && statementApi) {
      json(response, await readStatementPasswordStatus({ stateDir }));
      return true;
    }
    if (request.method === "POST" && statementApi) {
      if (!request.headers.origin) throw requestError("请从结单密码页面提交。", 403);
      requireAllowedOrigin(request);
      const body = await readAssetBody(request);
      if (Object.keys(body).some(key => !["provider", "password", "clear"].includes(key))) throw requestError("结单密码配置字段无效。", 400);
      json(response, await configureStatementPassword({ stateDir, provider: body.provider, password: body.password, clear: body.clear }));
      return true;
    }
    if (request.method === "POST" && path === "/api/assets/funds/configure") {
      if (!request.headers.origin) throw requestError("请从资产页面提交。", 403);
      requireAllowedOrigin(request);
      const body = await readAssetBody(request);
      const assets = await configureAssetFund({ stateDir, entryId: body.entryId, isin: body.isin, symbol: body.symbol, quantity: body.quantity, quantityBasis: body.quantityBasis, confirmedOn: body.confirmedOn, revision: body.revision });
      json(response, await assetView(assets, { stateDir }));
      return true;
    }
    if (request.method === "POST" && path === "/api/assets/rates/refresh") {
      if (!request.headers.origin) throw requestError("请从资产页面提交。", 403);
      requireAllowedOrigin(request);
      await readAssetBody(request);
      json(response, await assetView(await readPersonalAssets({ stateDir }), { stateDir, force: true }));
      return true;
    }
    if (request.method === "GET" && path === "/api/assets/ai") {
      json(response, await readAssetAiStatus({ stateDir }));
      return true;
    }
    if (request.method === "POST" && ["/api/assets/ai/review", "/api/assets/ai/configure"].includes(path)) {
      if (!request.headers.origin) throw requestError("请从资产页面提交。", 403);
      requireAllowedOrigin(request);
      const body = await readAssetBody(request);
      const assets = await assetView(await readPersonalAssets({ stateDir }), { stateDir });
      const action = path.endsWith("/configure") ? configureAssetAi : reviewPersonalAssets;
      json(response, await action({ stateDir, assets, ...(path.endsWith("/configure") ? { apiKey: body.apiKey } : {}) }));
      return true;
    }
    if (request.method === "GET" && path === "/api/assets/sync") {
      json(response, await readAssetSyncStatus({ stateDir }));
      return true;
    }
    if (request.method === "POST" && syncAction) {
      if (!request.headers.origin) throw requestError("请从资产页面提交。", 403);
      requireAllowedOrigin(request);
      const body = await readAssetBody(request);
      const result = await performAssetSyncAction({ stateDir, provider: syncAction[1], action: syncAction[2], body, sessionBinding: sessionBinding(request) });
      if (result.assets) result.assets = await assetView(result.assets, { stateDir });
      json(response, result);
      return true;
    }
    if ((request.method === "PUT" && path === "/api/assets") || (request.method === "POST" && path === "/api/assets/snapshots")) {
      if (!request.headers.origin) throw requestError("请从资产页面提交。", 403);
      requireAllowedOrigin(request);
      const body = await readAssetBody(request);
      const current = await readPersonalAssets({ stateDir });
      let state;
      if (path === "/api/assets") {
        state = await savePersonalAssets({ stateDir, portfolio: { ...body.portfolio, rates: current.portfolio.rates }, revision: body.revision });
      } else {
        const valued = await valuePersonalAssetState(current, { stateDir });
        state = await createPersonalAssetsSnapshot({ stateDir, revision: body.revision, valuation: { rates: valued.portfolio.rates, fx: valued.fx } });
      }
      json(response, await assetView(state, { stateDir }));
      return true;
    }
    json(response, { error: "不支持这个请求方法。" }, 405);
  } catch (error) {
    const status = error.statusCode || 500;
    json(response, { error: status >= 500 && !error.assetAiError && !error.fundError ? "个人资产暂时无法读取或保存，请稍后重试。" : error.message }, status);
  }
  return true;
}
