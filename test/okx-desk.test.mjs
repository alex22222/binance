import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handlePersonalAssetsRequest } from "../src/personal-assets-routes.mjs";
import { okxDeskHtml } from "../src/okx-desk-html.mjs";
import {
  DESK_FIXTURE_PATH,
  VAULT_LEDGER_PATH,
  VAULT_REPORTS_DIR,
  loadOkxDeskLedger,
  parseOkxDeskLedger,
  shadowSentences
} from "../src/okx-desk-ledger.mjs";

const fixture = () => readFile(DESK_FIXTURE_PATH, "utf8");
const shift = (ledger, id) => ledger.shifts.find((item) => item.id === id);

test("the 2026-11-12 sample keeps scan counts, chart scores and falsifiers", async () => {
  const ledger = parseOkxDeskLedger(await fixture());
  assert.deepEqual(ledger.shifts.map((item) => item.id), [
    "2026-11-12T09:00", "2026-11-12T13:00", "2026-11-12T17:00", "2026-11-12T21:00"
  ]);
  assert.equal(ledger.loose.length, 0);
  assert.equal(ledger.status["熔断"], "未触发");
  assert.match(ledger.capital, /1000 USDT/);
  const morning = shift(ledger, "2026-11-12T09:00");
  assert.deepEqual(morning.counts, { ideas: 1, watch: 8, none: 17, source: "scan" });
  assert.equal(morning.breaker, "未触发");
  const ondo = morning.rows.find((row) => row.symbol === "ONDO-USDT-SWAP" && row.kind === "idea");
  assert.match(ondo.idea, /^有点子（空/);
  assert.match(ondo.idea, /可机检否决：若下一根已收盘4H/);
  const ondoChart = morning.rows.find((row) => row.symbol === "ONDO-USDT-SWAP" && row.kind === "chart");
  assert.equal(ondoChart.score, 5);
  assert.equal(ondoChart.status, "结束(<7)");
  assert.equal(morning.rows.some((row) => row.kind === "strategy" || row.kind === "risk"), false);
  const afternoon = shift(ledger, "2026-11-12T13:00");
  assert.equal(afternoon.counts.ideas, 1);
  assert.equal(afternoon.rows.find((row) => row.kind === "chart" && row.symbol === "TAO-USDT-SWAP").score, 5);
  assert.deepEqual(shift(ledger, "2026-11-12T17:00").counts, { ideas: 0, watch: 1, none: 25, source: "scan" });
  assert.deepEqual(shift(ledger, "2026-11-12T21:00").counts, { ideas: 0, watch: 2, none: 24, source: "scan" });
  assert.deepEqual(shift(ledger, "2026-11-12T21:00").rows.filter((row) => row.kind === "watch").map((row) => row.symbol), ["PYTH-USDT-SWAP", "ANTHROPIC-USDT-SWAP"]);
  assert.match(morning.summaryLine, /ONDO有点子/);
});

test("manual rows stay out of the 09:00 slot and keep strategy and risk text", () => {
  const ledger = parseOkxDeskLedger(`
| 时间 | 角色 | 标的 | 点子 | 证据 | 评分 | 入场 | 止损 | 目标 | 影子仓位 | 风险% | 风控 | 状态 | 影子结果 | 教训 |
| 2026-11-08 12:04 | 侦察 | BTC-USDT-SWAP | 无信号：演练 | 证据 |  |  |  |  |  |  | — | 观察中 |  | 演练 |
| 2026-11-08 12:05 | 策略师 | BTC-USDT-SWAP | 演练计划 | 证据 | — | 76500 | 75700 | 78100 | 名义≈956 | 1.0 | 待审 | 计划中(演练) |  | 非实盘 |
| 2026-11-08 12:09 | 风控 | BTC-USDT-SWAP | 演练计划复核 | 证据 |  | 76500 | 75700 | 78100 | 名义≈956 | 1.0 | 影子批准(演练) | 演练·归档 |  | 不下单 |
| 2026-11-08 13:05 | 侦察 | 自选全表扫描 | 无信号汇总：有点子0；弱关注0 | 证据 |  |  |  |  |  |  | — | 结束 |  | 13:00 |

## 策略计划明细（演练）

### 2026-11-08 12:05 · BTC-USDT-SWAP · 演练计划

\`\`\`
标的 | 方向
BTC-USDT-SWAP | 条件多
\`\`\`
`);
  assert.deepEqual(ledger.shifts.map((item) => item.id), ["2026-11-08T12:04", "2026-11-08T13:00"]);
  const drill = shift(ledger, "2026-11-08T12:04");
  assert.equal(drill.kind, "manual");
  assert.equal(drill.rows.filter((row) => row.kind === "strategy").length, 1);
  assert.equal(drill.rows.find((row) => row.kind === "risk").riskDecision, "影子批准(演练)");
  assert.match(drill.plans[0].text, /条件多/);
  assert.equal(shift(ledger, "2026-11-08T13:00").counts.none, null);
});

test("daily report shadow sentences stay quotes and skip unrelated desk words", () => {
  const sentences = shadowSentences("我的关注点：OKX 影子账户继续只观察、不下真单。先看 75,000 能否守住。\n- 关注点：和你的多角色交易台思路一致。");
  assert.deepEqual(sentences, ["我的关注点：OKX 影子账户继续只观察、不下真单。"]);
});

test("the page renders one shift, escapes ledger text and does not echo a bad query", async () => {
  const ledger = parseOkxDeskLedger(await fixture());
  ledger.shifts[0].rows[0].idea = `<script>alert(1)</script>`;
  const html = okxDeskHtml(ledger, { shiftId: "2026-11-12T09:00" });
  assert.match(html, /<a href="\/crypto\/desk" aria-current="page">交易过程<\/a>/);
  assert.match(html, /ONDO-USDT-SWAP/);
  assert.match(html, /否决条件<\/dt><dd>若下一根已收盘4H/);
  assert.doesNotMatch(html, /<li>S2<\/li>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<form|onclick=/);
  assert.match(okxDeskHtml(ledger, { unknown: true }), /没有这一班/);
  assert.doesNotMatch(okxDeskHtml(ledger, { unknown: true }), /<script>alert/);
});

test("desk routes are read-only HTML and JSON behind the shared handler", async () => {
  const previousLedger = process.env.OKX_DESK_LEDGER_PATH;
  const previousReports = process.env.OKX_DESK_REPORTS_DIR;
  process.env.OKX_DESK_LEDGER_PATH = DESK_FIXTURE_PATH;
  process.env.OKX_DESK_REPORTS_DIR = join(tmpdir(), "okx-desk-no-reports");
  const call = async (url, method = "GET") => {
    const response = { headers: null, body: "", status: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body || ""; } };
    const handled = await handlePersonalAssetsRequest({ request: { method, url, headers: {} }, response, stateDir: "/nonexistent-state", requireAllowedOrigin() {} });
    return { handled, response };
  };
  try {
    const page = await call("/crypto/desk?shift=2026-11-12T21:00");
    assert.equal(page.handled, true);
    assert.equal(page.response.status, 200);
    assert.match(page.response.headers["Content-Security-Policy"], /^default-src 'none'; style-src 'unsafe-inline'/);
    assert.doesNotMatch(page.response.headers["Content-Security-Policy"], /script-src/);
    assert.match(page.response.body, /PYTH-USDT-SWAP/);
    assert.match(page.response.body, /ANTHROPIC-USDT-SWAP/);
    assert.doesNotMatch(page.response.body, /<script|<form/);
    const missed = await call("/crypto/desk?shift=%3Cscript%3E");
    assert.match(missed.response.body, /没有这一班/);
    assert.doesNotMatch(missed.response.body, /<script>/);
    const api = await call("/api/crypto/desk");
    const body = JSON.parse(api.response.body);
    assert.equal(body.source.kind, "fixture");
    assert.equal(body.shifts.at(-1).id, "2026-11-12T21:00");
    const denied = await call("/crypto/desk", "POST");
    assert.equal(denied.response.status, 405);
    assert.equal((await call("/crypto/deskx")).handled, false);
  } finally {
    if (previousLedger === undefined) delete process.env.OKX_DESK_LEDGER_PATH;
    else process.env.OKX_DESK_LEDGER_PATH = previousLedger;
    if (previousReports === undefined) delete process.env.OKX_DESK_REPORTS_DIR;
    else process.env.OKX_DESK_REPORTS_DIR = previousReports;
  }
});

test("the Mac vault, when readable, still parses the 2026-11-12 shifts without leftovers", async () => {
  let ledger;
  try {
    ledger = await loadOkxDeskLedger({ ledgerPath: VAULT_LEDGER_PATH, reportsDir: VAULT_REPORTS_DIR });
  } catch {
    return;
  }
  if (ledger.source.kind !== "vault") return;
  assert.equal(ledger.loose.length, 0);
  const night = shift(ledger, "2026-11-12T21:00");
  assert.equal(night.counts.ideas, 0);
  assert.equal(night.counts.watch, 2);
  assert.equal(night.breaker, "未触发");
  const morning = shift(ledger, "2026-11-12T09:00");
  assert.equal(morning.rows.find((row) => row.kind === "chart").score, 5);
  const drill = shift(ledger, "2026-11-08T12:04");
  assert.equal(shift(ledger, "2026-11-08T11:07").rows.length, 2);
  assert.equal(shift(ledger, "2026-11-08T12:05"), undefined);
  assert.equal(drill.rows.some((row) => row.kind === "chart"), true);
  assert.equal(drill.rows.some((row) => row.kind === "risk"), true);
  assert.ok(drill.plans.length >= 1);
  const directory = await mkdtemp(join(tmpdir(), "okx-desk-missing-"));
  try {
    await writeFile(join(directory, "not-a-report.txt"), "影子");
    const fallback = await loadOkxDeskLedger({ ledgerPath: join(directory, "missing.md"), reportsDir: directory, readText: readFile });
    assert.equal(fallback.source.kind, "fixture");
    const copyPath = join(directory, "copy.md");
    await writeFile(copyPath, await readFile(DESK_FIXTURE_PATH));
    const copy = await loadOkxDeskLedger({ ledgerPath: copyPath, reportsDir: directory, fixturePath: DESK_FIXTURE_PATH });
    assert.equal(copy.source.kind, "copy");
    assert.equal(copy.source.label, "服务器上的影子日志副本");
    assert.equal(fallback.shifts[0].id, "2026-11-12T09:00");
    assert.equal(fallback.reports.status, "ok");
    assert.deepEqual(fallback.reports.notes, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
