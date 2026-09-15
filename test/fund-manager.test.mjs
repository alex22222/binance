import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beijingDate, paperSummary } from "../src/fund-manager-evidence.mjs";
import { newYorkDate } from "../src/strategy-data.mjs";
import { REPORT_SECTIONS, deliverManagerReport, sendManagerFeishu, validateManagerReport } from "../src/fund-manager-delivery.mjs";

const date = "2026-09-13";
const text = `基金经理日报 ${date}\n${REPORT_SECTIONS.map((section) => `## ${section}\n已核实或注明缺失`).join("\n")}\nhttps://www.federalreserve.gov/`;
const environment = { FEISHU_APP_ID: "test", FEISHU_APP_SECRET: "test", FEISHU_RECEIVE_ID: "oc_test", DASHBOARD_PUBLIC_ORIGIN: "https://stocks.example.com" };
const response = (body) => ({ ok: true, status: 200, json: async () => body });

test("uses Beijing dates across UTC midnight and preserves unavailable Paper evidence", () => {
  assert.equal(beijingDate("2026-09-12T16:01:00Z"), date);
  assert.equal(paperSummary(null, "2026-09-11", newYorkDate).daily, null);
  const summary = paperSummary({ startedAt: "2026-09-09T13:00:00Z", lastObservation: { sessionDate: "2026-09-10" }, trades: [], realizedPnlUsdt: 0 }, "2026-09-11", newYorkDate);
  assert.equal(summary.daily.realizedPnlUsdt, null);
  const fresh = paperSummary({ startedAt: "2026-09-09T13:00:00Z", lastObservation: { sessionDate: "2026-09-11" }, trades: [], realizedPnlUsdt: 0 }, "2026-09-11", newYorkDate);
  assert.equal(fresh.daily.realizedPnlUsdt, 0);
  assert.equal(fresh.daily.profitFactor, null);
});

test("separates daily Paper closed PnL from cumulative and open marks", () => {
  const summary = paperSummary({
    startedAt: "2026-09-09T13:00:00Z", lastObservation: { sessionDate: "2026-09-11" }, realizedPnlUsdt: 4,
    position: { symbol: "DBC", unrealizedPnlUsdt: -0.5, markedAt: "2026-09-11T19:55:00Z" },
    trades: [{ closedAt: "2026-09-10T15:00:00Z", pnlUsdt: 5 }, { closedAt: "2026-09-11T15:00:00Z", pnlUsdt: -1 }]
  }, "2026-09-11", newYorkDate);
  assert.equal(summary.daily.realizedPnlUsdt, -1);
  assert.equal(summary.cumulative.realizedPnlUsdt, 4);
  assert.equal(summary.position.unrealizedPnlUsdt, -0.5);
});

test("rejects incomplete reports and HTTP-200 Feishu business errors", async () => {
  assert.throws(() => validateManagerReport(date, text.replace("## 黄金", "缺少黄金")), /黄金/);
  assert.throws(() => validateManagerReport(date, text + "字".repeat(6000)), /16 KB/);
  await assert.rejects(sendManagerFeishu(text, "test", { FEISHU_WEBHOOK_URL: "https://example.test" }, async () => response({ code: 19021 })), /19021/);
});

test("archives delivery receipts, uses configured recipient, and skips repeat daily sends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manager-delivery-"));
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response(url.includes("tenant_access_token") ? { code: 0, tenant_access_token: "test" } : { code: 0, data: { message_id: "om_test" } });
  };
  const first = await deliverManagerReport({ directory, date, text, environment, fetchImpl });
  const second = await deliverManagerReport({ directory, date, text, environment, fetchImpl });
  assert.equal(first.status, "SENT");
  assert.equal(second.duplicateSkipped, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.receive_id, "oc_test");
  assert.equal(requests[1].body.msg_type, "interactive");
  assert.equal(JSON.parse(requests[1].body.content).elements.at(-1).actions[0].url, "https://stocks.example.com/fund-manager?date=2026-09-13&edition=daily");
  assert.match(await readFile(join(directory, `${date}-daily.html`), "utf8"), /<!doctype html>/);
  assert.equal(requests[1].body.uuid, first.uuid);
  assert.equal(JSON.parse(await readFile(join(directory, `${date}-daily.receipt.json`), "utf8")).messageId, "om_test");
});

test("retries uncertain app delivery with the same uuid and rejects changed content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manager-retry-"));
  const uuids = [];
  let fail = true;
  const fetchImpl = async (url, options) => {
    if (url.includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "test" });
    uuids.push(JSON.parse(options.body).uuid);
    if (fail) throw new Error("connection lost after request");
    return response({ code: 0, data: { message_id: "om_retry" } });
  };
  await assert.rejects(deliverManagerReport({ directory, date, text, environment, fetchImpl }), /connection lost/);
  await assert.rejects(deliverManagerReport({ directory, date, text: text + "修改", environment, fetchImpl }), /identical/);
  fail = false;
  assert.equal((await deliverManagerReport({ directory, date, text, environment, fetchImpl })).status, "SENT");
  assert.equal(uuids[0], uuids[1]);
});
