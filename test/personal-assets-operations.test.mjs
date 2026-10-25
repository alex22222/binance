import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { OPERATIONS_TASKS, readOperationsOverview, handlePersonalAssetsRequest } from "../src/personal-assets-routes.mjs";
import { operationsHtml } from "../src/personal-assets-html.mjs";

const now = new Date("2026-10-25T13:30:00Z");
const stateDir = "/state";
const renewalPath = "/renewal/public-status.json";
const unix = (iso) => `@${Date.parse(iso) / 1000}`;
const textTime = (iso) => { const date = new Date(iso); return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()]} ${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`; };

function fakeSystem({ services = {}, timers = {}, extraTimers = [], fail = false } = {}) {
  const block = (fields) => Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n");
  return async (args) => {
    if (fail) throw Error("systemctl unavailable");
    if (args[0] === "list-timers") return [...OPERATIONS_TASKS.map((task) => task.unit), ...extraTimers].map((unit) => `Mon 2026-10-26 13:00:00 UTC 23h Fri 2026-10-23 21:55:00 UTC 1 day ago ${unit}.timer ${unit}.service`).join("\n");
    return args.filter((arg) => /\.(service|timer)$/.test(arg)).map((id) => {
      const unit = id.replace(/\.(service|timer)$/, "");
      if (id.endsWith(".timer")) return block({ Id: id, LoadState: "loaded", ActiveState: "active", LastTriggerUSec: textTime("2026-10-25T12:00:00Z"), NextElapseUSecRealtime: textTime("2026-10-26T13:00:00Z"), ...timers[unit] });
      return block({ Id: id, LoadState: "loaded", ActiveState: "inactive", Result: "success", ExecMainStatus: "0", ExecMainStartTimestamp: unix("2026-10-25T12:00:00Z"), ExecMainExitTimestamp: unix("2026-10-25T12:00:30Z"), ...services[unit] });
    }).join("\n\n");
  };
}

function fakeFiles(extra = {}) {
  const files = {
    [renewalPath]: { schemaVersion: 1, strategyId: "weekly-etf-dual-momentum-defense", checkedAt: "2026-10-25T13:29:02.000Z", authorizationAllowed: true, entryControlsOpen: true, leaseExpiresAt: "2026-10-29T02:36:49.374Z", hardDeadline: "2026-11-21T04:00:49.002Z", autoRenewalState: "ACTIVE", reason: "VALID", generation: 0 },
    [join(stateDir, "btc-radar/state.json")]: { lastRunAt: "2026-10-25T12:43:01.158Z" },
    [join(stateDir, "trade-reviews/premarket/2026-10-22.json")]: { tradingDate: "2026-10-22" },
    [join(stateDir, "trade-reviews/premarket/2026-10-23.json")]: { tradingDate: "2026-10-23" },
    [join(stateDir, "trade-reviews/latest.json")]: { tradingDate: "2026-10-23", generatedAt: "2026-10-24T12:01:00.614Z" },
    [join(stateDir, "strategy-validation/reports/2026-10-24.json")]: { generatedAt: "2026-10-24T22:57:28.962Z" },
    [join(stateDir, "strategy-evidence/aaaa.json")]: { generatedAt: "2026-10-20T00:00:00.000Z" },
    [join(stateDir, "strategy-evidence/ffff.json")]: { generatedAt: "2026-10-24T23:30:00.000Z" },
    [join(stateDir, "shadow-outcomes/latest.json")]: { generatedAt: "2026-10-23T22:25:00.588Z" },
    [join(stateDir, "turtle-paper/latest.json")]: { lastObservation: { sessionDate: "2026-10-23" } },
    [join(stateDir, "weekly-etf-rotation-paper/latest.json")]: { lastObservation: { sessionDate: "2026-10-23" } },
    [join(stateDir, "weekly-etf-dual-momentum-paper/latest.json")]: { lastObservation: { sessionDate: "2026-10-23" } },
    [join(stateDir, "etf-frequency-paper/latest.json")]: { lastObservation: { sessionDate: "2026-10-23" } },
    [join(stateDir, "personal-assets-sync.json")]: { providers: { okx: { lastFetchedAt: "2026-10-25T01:00:08.260Z" }, futu: { lastFetchedAt: "2026-10-25T01:00:12.000Z" }, broken: null } },
    [join(stateDir, "personal-assets.json")]: { snapshots: [{ at: "2026-10-25T00:00:05.000Z" }] },
    ...extra
  };
  const mtimes = { [join(stateDir, "strategy-evidence/aaaa.json")]: 1, [join(stateDir, "strategy-evidence/ffff.json")]: 2 };
  return {
    readText: async (path) => { if (!(path in files)) throw Object.assign(Error("missing"), { code: "ENOENT" }); return typeof files[path] === "string" ? files[path] : JSON.stringify(files[path]); },
    listDirectory: async (directory) => Object.keys(files).filter((path) => path.startsWith(directory + "/")).map((path) => path.slice(directory.length + 1)),
    statFile: async (path) => ({ mtimeMs: mtimes[path] ?? 0 })
  };
}

const overview = (options = {}, files = {}) => readOperationsOverview({ stateDir, now, renewalPath, systemctl: fakeSystem(options), ...fakeFiles(files) });
const row = (result, unit) => result.tasks.find((task) => task.unit === unit);

test("the run overview reports every timer's last run, next run, data date and a healthy renewal", async () => {
  const result = await overview({ services: { "binance-agentic-spy-open-check": { LoadState: "not-found", ExecMainStartTimestamp: "", ExecMainExitTimestamp: "" } }, timers: { "binance-agentic-spy-open-check": { NextElapseUSecRealtime: "" } } });
  assert.equal(result.systemdError, null);
  assert.equal(result.tasks.length, 16);
  const radar = row(result, "binance-agentic-btc-radar");
  assert.deepEqual([radar.status, radar.startedAt, radar.finishedAt, radar.nextRunAt, radar.dataAsOf], ["ok", "2026-10-25T12:00:00.000Z", "2026-10-25T12:00:30.000Z", "2026-10-26T13:00:00.000Z", "2026-10-25T12:43:01.158Z"]);
  assert.equal(row(result, "binance-agentic-premarket-brief").dataAsOf, "2026-10-23");
  assert.equal(row(result, "binance-agentic-strategy-evidence").dataAsOf, "2026-10-24T23:30:00.000Z");
  assert.equal(row(result, "binance-personal-assets-sync").dataAsOf, "2026-10-25T01:00:12.000Z");
  assert.equal(row(result, "binance-agentic-turtle-paper").status, "ok");
  assert.equal(row(result, "binance-agentic-spy-open-check").status, "finished");
  for (const unit of ["binance-agentic-offhours-research", "binance-agentic-monthly-research"]) {
    assert.equal(row(result, unit).dataAsOf, null);
    assert.match(row(result, unit).dataNote, /仅研究账户可读/);
  }
  const renewal = row(result, "binance-agentic-authorization");
  assert.equal(renewal.status, "ok");
  assert.equal(renewal.dataNote, "续签 ACTIVE · VALID");
  assert.deepEqual([result.renewal.verified, result.renewal.state, result.renewal.authorizationAllowed], [true, "ACTIVE", true]);
});

test("failures, running jobs, stale data, unknown timers and unreadable outputs are each called out", async () => {
  const result = await overview({
    services: { "binance-agentic-trade-review": { Result: "exit-code", ExecMainStatus: "1" }, "binance-agentic-strategy-validation": { ActiveState: "activating" } },
    timers: { "binance-agentic-monthly-research": { LoadState: "not-found" } },
    extraTimers: ["binance-agentic-new-job"]
  }, {
    [join(stateDir, "turtle-paper/latest.json")]: { lastObservation: { sessionDate: "2026-10-19" } },
    [join(stateDir, "shadow-outcomes/latest.json")]: "{not json",
    [join(stateDir, "btc-radar/state.json")]: { lastRunAt: "not a date" }
  });
  assert.equal(row(result, "binance-agentic-trade-review").status, "failed");
  assert.equal(row(result, "binance-agentic-trade-review").exitStatus, "1");
  assert.equal(row(result, "binance-agentic-strategy-validation").status, "running");
  assert.equal(row(result, "binance-agentic-turtle-paper").status, "stale");
  assert.equal(row(result, "binance-agentic-monthly-research").status, "missing");
  assert.match(row(result, "binance-agentic-shadow-outcomes").dataNote, /无法读取/);
  assert.match(row(result, "binance-agentic-btc-radar").dataNote, /没有可核验的数据时间/);
  const added = row(result, "binance-agentic-new-job");
  assert.deepEqual([added.group, added.label, added.status], ["其他", "binance-agentic-new-job", "ok"]);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.counts.stale, 1);
});

test("renewal that is halted, stale or malformed is never shown as healthy", async () => {
  const base = JSON.parse(await fakeFiles().readText(renewalPath));
  const halted = await overview({}, { [renewalPath]: { ...base, autoRenewalState: "HALTED", reason: "CODE_OR_IDENTITY_CHANGED" } });
  assert.equal(row(halted, "binance-agentic-authorization").status, "attention");
  assert.equal(halted.renewal.reason, "CODE_OR_IDENTITY_CHANGED");
  const stale = await overview({}, { [renewalPath]: { ...base, checkedAt: "2026-10-25T13:20:00.000Z" } });
  assert.equal(stale.renewal.verified, false);
  assert.equal(row(stale, "binance-agentic-authorization").status, "failed");
  const leaked = await overview({}, { [renewalPath]: { ...base, reason: "/etc/secret path" } });
  assert.equal(leaked.renewal.reason, "REASON_WITHHELD");
  const missing = await overview({}, { [renewalPath]: "nope" });
  assert.equal(missing.renewal.reason, "STATUS_UNVERIFIED");
});

test("an unreadable systemd is reported instead of inventing run results", async () => {
  const result = await overview({ fail: true });
  assert.match(result.systemdError, /systemd/);
  assert.equal(result.tasks.length, 16);
  assert.ok(result.tasks.every((task) => task.startedAt === null && task.nextRunAt === null));
  assert.ok(result.tasks.every((task) => task.status === "missing"));
});

test("the page is server-rendered without script, escapes values and refreshes itself", async () => {
  const result = await overview({ extraTimers: ["binance-x"] });
  result.tasks[0].dataNote = '<img src=x onerror="alert(1)">';
  result.tasks[0].label = "<b>续签</b>";
  const html = operationsHtml(result);
  assert.doesNotMatch(html, /<script|<img src=x|<b>续签/);
  assert.match(html, /&lt;b&gt;续签&lt;\/b&gt;/);
  assert.match(html, /<meta http-equiv="refresh" content="60">/);
  assert.match(html, /<a href="\/operations" aria-current="page">运行总览<\/a>/);
  assert.match(html, /服务器 17 个定时任务/);
  for (const group of ["交易与风控", "策略研究", "纸面模拟", "个人资产", "研究", "其他"]) assert.match(html, new RegExp(`<tr class="op-group"><th colspan="5">${group}</th>`));
  assert.match(html, /交易授权续签<\/h2><span class="op-pill ok">ACTIVE<\/span>/);
  assert.match(html, /2026-10-23 交易日/);
  assert.match(html, /24 小时后/);
  assert.doesNotMatch(html, /\b0 分钟前|-\d+ 分钟/);
});

test("the overview routes serve HTML without script and a JSON view, and leave other paths alone", async () => {
  const call = async (url) => {
    const response = { headers: null, body: "", status: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    const handled = await handlePersonalAssetsRequest({ request: { method: "GET", url, headers: {} }, response, stateDir: "/nonexistent-state", requireAllowedOrigin() {} });
    return { handled, response };
  };
  const page = await call("/operations");
  assert.equal(page.handled, true);
  assert.equal(page.response.status, 200);
  assert.match(page.response.headers["Content-Security-Policy"], /^default-src 'none'; style-src 'unsafe-inline'/);
  assert.doesNotMatch(page.response.headers["Content-Security-Policy"], /script-src/);
  assert.match(page.response.body, /运行总览/);
  const api = await call("/api/operations");
  assert.equal(api.response.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(JSON.parse(api.response.body).tasks.length >= 16, true);
  assert.equal((await call("/operationsx")).handled, false);
});
