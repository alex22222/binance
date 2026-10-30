import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as assets from "../src/personal-assets.mjs";

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "asset-comparison-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const portfolio = assets.emptyPortfolio();
  portfolio.accounts = [
    { id: "broker", name: "证券账户", platform: "盈立", basis: "holdings", reviewStatus: "confirmed", note: "" },
    { id: "exchange", name: "交易所", platform: "OKX", basis: "total", reviewStatus: "confirmed", note: "" },
    { id: "pending", name: "待核对", platform: "待确认", basis: "total", reviewStatus: "pending", note: "" },
  ];
  const entry = (id, amount, fields = {}) => ({ id, accountId: "broker", name: id, category: "股票", kind: "holding", currency: "USD", amount, asOf: "2026-10-28", source: "manual", ...fields });
  portfolio.rates.USD = { value: 7, date: "2026-10-28", note: "历史汇率" };
  portfolio.entries = [entry("up", 100), entry("down", 20), entry("same", 10), entry("removed", 5),
    entry("exchange-total", 50, { accountId: "exchange", kind: "total" }),
    entry("excluded-detail", 1000, { accountId: "exchange" }),
    entry("pending-total", 900, { accountId: "pending", kind: "total" })];
  await assets.savePersonalAssets({ stateDir, portfolio, revision: 0 });
  const first = await assets.createPersonalAssetsSnapshot({ stateDir, revision: 1, now: new Date("2026-10-28T15:55:00Z") });
  portfolio.rates.USD.value = 8;
  portfolio.entries = portfolio.entries.filter(row => row.id !== "removed");
  portfolio.entries.find(row => row.id === "up").amount = 110;
  portfolio.entries.find(row => row.id === "down").amount = 10;
  portfolio.entries.push(entry("added", 3));
  await assets.savePersonalAssets({ stateDir, portfolio, revision: 1 });
  const second = await assets.createPersonalAssetsSnapshot({ stateDir, revision: 2, now: new Date("2026-10-29T15:55:00Z") });
  return { stateDir, from: first.snapshots[0], to: second.snapshots[0], portfolio, entry };
}

test("snapshot comparison uses each frozen rate and the counted rows, without changing state or fetching prices", async t => {
  const f = await fixture(t);
  const path = join(f.stateDir, "personal-assets.json");
  const before = await readFile(path, "utf8");
  const result = await assets.readPersonalAssetsComparison({ stateDir: f.stateDir, from: f.from.id, to: f.to.id });
  assert.equal(result.from.id, f.from.id);
  assert.equal(result.to.id, f.to.id);
  const rows = new Map(result.rows.map(row => [row.id, row]));
  assert.equal(rows.get("up").before, 700);
  assert.equal(rows.get("up").after, 880);
  assert.equal(rows.get("up").impact, 180);
  assert.equal(rows.get("down").impact, -60);
  assert.equal(rows.get("same").impact, 10); // Same USD value, changed historical FX.
  assert.equal(rows.get("added").status, "新增记录");
  assert.equal(rows.get("removed").status, "移除记录");
  assert.equal(rows.get("exchange-total").impact, 50);
  assert.equal(rows.has("excluded-detail"), false);
  assert.equal(rows.has("pending-total"), false);
  assert.equal(result.rows[0].id, "up");
  assert.ok(Math.abs(result.rows.reduce((sum, row) => sum + row.impact, 0) - (f.to.total - f.from.total)) < 1e-8);
  assert.equal(result.change, f.to.total - f.from.total);
  assert.equal(await readFile(path, "utf8"), before);
});

test("missing valuations and changes of accounting scope have explicit statuses rather than investment gains", async t => {
  const f = await fixture(t);
  f.portfolio.accounts.find(row => row.id === "exchange").basis = "holdings";
  delete f.portfolio.rates.USD;
  await assets.savePersonalAssets({ stateDir: f.stateDir, portfolio: f.portfolio, revision: 2 });
  const state = await assets.createPersonalAssetsSnapshot({ stateDir: f.stateDir, revision: 3, now: new Date("2026-10-30T15:55:00Z") });
  const result = await assets.readPersonalAssetsComparison({ stateDir: f.stateDir, from: f.to.id, to: state.snapshots[0].id });
  const rows = new Map(result.rows.map(row => [row.id, row]));
  assert.equal(rows.get("up").after, null);
  assert.equal(rows.get("up").status, "缺少估值");
  assert.equal(rows.get("exchange-total").status, "移出统计");
  assert.equal(rows.get("excluded-detail").status, "未估值");
  assert.equal(result.to.total, null);
  assert.equal(result.change, null);
  const recovered = await assets.readPersonalAssetsComparison({ stateDir: f.stateDir, from: state.snapshots[0].id, to: f.to.id });
  assert.equal(recovered.rows.find(row => row.id === "up").status, "补齐估值");
});

test("snapshot detail reads reject unlisted, malformed, missing, symlinked or mismatched files", async t => {
  const f = await fixture(t);
  const call = (from = f.from.id) => assets.readPersonalAssetsComparison({ stateDir: f.stateDir, from, to: f.to.id });
  await assert.rejects(call("../../personal-assets"), { status: 400 });
  await assert.rejects(call("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), { status: 404 });
  const path = join(f.stateDir, "personal-assets-snapshots", `${f.from.id}.json`);
  const bytes = await readFile(path, "utf8");
  const raw = JSON.parse(bytes);
  raw.portfolio.entries[0].amount += 1;
  await writeFile(path, JSON.stringify(raw));
  await assert.rejects(call(), { status: 500 });
  await rm(path);
  await assert.rejects(call(), { status: 404 });
  const outside = join(f.stateDir, "outside.json");
  await writeFile(outside, bytes);
  await symlink(outside, path);
  await assert.rejects(call(), { status: 500 });
});
