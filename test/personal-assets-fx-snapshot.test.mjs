import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPersonalAssetsSnapshot, emptyPortfolio, readPersonalAssets, savePersonalAssets } from "../src/personal-assets.mjs";

const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

async function fixture(context) {
  const stateDir = await mkdtemp(join(tmpdir(), "personal-assets-fx-snapshot-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const portfolio = emptyPortfolio();
  portfolio.entries = [{ id: "synthetic-usd", accountId: portfolio.accounts[0].id, kind: "total", name: "合成美元资产", category: "基金", currency: "USD", amount: 100, asOf: date, source: "manual" }];
  portfolio.rates.USD = { value: 2, date, note: "旧手工测试汇率" };
  await savePersonalAssets({ stateDir, portfolio, revision: 0 });
  return stateDir;
}

function valuation(value, asOf = `${date}T01:00:00.000Z`) {
  return {
    rates: { CNY: { value: 1, date }, USD: { value, date, note: "合成自动汇率" } },
    fx: { mode: "automatic", status: "fresh", source: "synthetic", fetchedAt: asOf, errors: [], rates: { USD: { value, date, asOf, source: "synthetic" } } },
  };
}

test("automatic valuation snapshots freeze current rates without rewriting the ledger or old snapshots", async (context) => {
  const stateDir = await fixture(context);
  const first = await createPersonalAssetsSnapshot({ stateDir, revision: 1, valuation: valuation(7) });
  assert.equal(first.revision, 1);
  assert.equal(first.snapshots[0].total, 700);
  assert.match(first.snapshots[0].valuationId, /^[a-f0-9]{64}$/);
  const firstPath = join(stateDir, "personal-assets-snapshots", `${first.snapshots[0].id}.json`);
  const firstBytes = await readFile(firstPath, "utf8");
  const stored = JSON.parse(firstBytes);
  assert.deepEqual(stored.portfolio.rates, valuation(7).rates);
  assert.deepEqual(stored.fx, valuation(7).fx);
  assert.equal(first.portfolio.rates.USD.value, 2);

  const same = valuation(7);
  same.fx.fetchedAt = `${date}T01:01:00.000Z`;
  same.fx.errors = ["合成可恢复错误"];
  same.rates.USD.note = `合成自动汇率；重新获取时间 ${date}T01:01:00.000Z`;
  assert.deepEqual(await createPersonalAssetsSnapshot({ stateDir, revision: 1, valuation: same }), first);

  const second = await createPersonalAssetsSnapshot({ stateDir, revision: 1, valuation: valuation(8, `${date}T02:00:00.000Z`) });
  assert.equal(second.revision, 1);
  assert.equal(second.snapshots.length, 2);
  assert.equal(second.snapshots[0].total, 800);
  assert.notEqual(second.snapshots[0].valuationId, first.snapshots[0].valuationId);
  assert.equal(second.snapshots[1].id, first.snapshots[0].id);
  assert.equal(await readFile(firstPath, "utf8"), firstBytes);
  assert.deepEqual(await readPersonalAssets({ stateDir }), second);
  assert.equal(second.portfolio.rates.USD.value, 2);
});

test("snapshots preserve nullable quote times and delayed reference metadata without hashing retrieval times", async (context) => {
  const stateDir = await fixture(context);
  const reference = valuation(7);
  reference.fx.status = "stale";
  Object.assign(reference.fx.rates.USD, { asOf: null, timeBasis: "daily", fetchedAt: `${date}T01:00:00.000Z`, source: "synthetic daily" });
  reference.rates.USD.note = `合成日参考；获取时间 ${date}T01:00:00.000Z`;
  const first = await createPersonalAssetsSnapshot({ stateDir, revision: 1, valuation: reference });
  const path = join(stateDir, "personal-assets-snapshots", `${first.snapshots[0].id}.json`);
  const before = await readFile(path, "utf8");
  assert.deepEqual(JSON.parse(before).fx, reference.fx);
  assert.equal(first.snapshots[0].total, 700);
  reference.fx.fetchedAt = `${date}T01:01:00.000Z`;
  reference.fx.rates.USD.fetchedAt = reference.fx.fetchedAt;
  reference.rates.USD.note = `合成日参考；获取时间 ${date}T01:01:00.000Z`;
  assert.deepEqual(await createPersonalAssetsSnapshot({ stateDir, revision: 1, valuation: reference }), first);
  assert.equal(await readFile(path, "utf8"), before);
});

test("legacy snapshots keep revision idempotency while automatic valuation uses an independent identity", async (context) => {
  const stateDir = await fixture(context);
  const legacy = await createPersonalAssetsSnapshot({ stateDir, revision: 1 });
  assert.equal(legacy.snapshots[0].total, 200);
  assert.equal("valuationId" in legacy.snapshots[0], false);
  const automatic = await createPersonalAssetsSnapshot({ stateDir, revision: 1, valuation: valuation(7) });
  assert.equal(automatic.snapshots.length, 2);
  assert.equal(automatic.snapshots[0].total, 700);
  assert.deepEqual(await createPersonalAssetsSnapshot({ stateDir, revision: 1 }), automatic);
  assert.equal((await readdir(join(stateDir, "personal-assets-snapshots"))).length, 2);
});

test("malformed automatic rates or stored valuation identities fail closed", async (context) => {
  const stateDir = await fixture(context);
  const path = join(stateDir, "personal-assets.json");
  const before = await readFile(path, "utf8");
  const invalid = valuation(0);
  await assert.rejects(createPersonalAssetsSnapshot({ stateDir, revision: 1, valuation: invalid }), { status: 400 });
  assert.equal(await readFile(path, "utf8"), before);
  const current = await createPersonalAssetsSnapshot({ stateDir, revision: 1, valuation: valuation(7) });
  current.snapshots[0].valuationId = "bad";
  await writeFile(path, JSON.stringify(current));
  await assert.rejects(readPersonalAssets({ stateDir }), { status: 500 });
});

test("daily snapshots deduplicate a Beijing day across concurrent calls and survive an unchanged next day", async (context) => {
  const stateDir = await fixture(context);
  const early = new Date("2026-10-23T16:01:00Z");
  const same = new Date("2026-10-24T15:59:00Z");
  const next = new Date("2026-10-24T16:01:00Z");
  await Promise.all([early, same].map(now => createPersonalAssetsSnapshot({stateDir,revision:1,valuation:valuation(7),daily:true,now})));
  let state = await readPersonalAssets({stateDir});
  assert.equal(state.snapshots.length,1);
  assert.equal(state.snapshots[0].dailyDate,"2026-10-24");
  const path=join(stateDir,"personal-assets-snapshots",state.snapshots[0].id+".json");
  const bytes=await readFile(path,"utf8");
  state=await createPersonalAssetsSnapshot({stateDir,revision:1,valuation:valuation(7),daily:true,now:next});
  assert.equal(state.snapshots.length,2);
  assert.equal(state.snapshots[0].dailyDate,"2026-10-25");
  assert.equal(state.snapshots[0].at,next.toISOString());
  assert.equal(state.revision,1);
  assert.equal(await readFile(path,"utf8"),bytes);
});
