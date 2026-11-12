import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPersonalAssetsSnapshot, emptyPortfolio, readPersonalAssets, savePersonalAssets } from "../src/personal-assets.mjs";
import { archiveExistingPersonalAssetsSnapshots, archivePersonalAssetsSnapshot } from "../src/personal-assets-history.mjs";

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "assets-history-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const portfolio = emptyPortfolio();
  portfolio.accounts[0].basis = "holdings";
  portfolio.entries = [{ id: "cash", accountId: "account-1", kind: "holding", name: "cash", category: "现金", currency: "USD", amount: -1, asOf: "2026-10-24", source: "manual" },
    { id: "stock", accountId: "account-1", kind: "holding", name: "stock", category: "股票", currency: "USD", amount: 100, asOf: "2026-10-24", source: "manual" }];
  portfolio.rates.USD = { value: 7, date: "2026-10-24" };
  portfolio.stockPnl = [{ accountId: "account-1", amount: -10, currency: "USD", asOf: "2026-10-24", source: "manual" }];
  await savePersonalAssets({ stateDir, portfolio, revision: 0 });
  return { stateDir, portfolio, path: join(stateDir, "personal-assets-history.sqlite") };
}

test("history preserves signed cash/PnL, quantities, actual dates and source failure without leaking credentials", async t => {
  const f = await fixture(t);
  const state = await createPersonalAssetsSnapshot({ stateDir: f.stateDir, revision: 1, daily: true, dailyPhase: "refresh", now: new Date("2026-10-25T23:01:00Z"),
    sourceCoverage: { refresh: { lastError: "partial failure", password: "never-copy" }, providers: { okx: { lastFetchedAt: "2026-10-24T00:00:00Z", lastError: "failed", credentials: { secret: "never-copy" } } },
      funds: { bindings: [{ entryId: "stock", quantity: "2.5", confirmedOn: "2026-10-24", quote: { price: "40", date: "2026-10-24" } }] } } });
  const db = new DatabaseSync(f.path);t.after(() => db.close());
  assert.equal(db.prepare("SELECT total_cny FROM snapshots").get().total_cny,693);
  assert.equal(db.prepare("SELECT cny_value FROM account_pnl").get().cny_value,-70);
  assert.equal(db.prepare("SELECT amount FROM asset_values WHERE entry_id='cash'").get().amount,-1);
  const row = db.prepare("SELECT * FROM snapshots").get();
  assert.equal(row.beijing_day,"2026-10-26");assert.equal(row.at,"2026-10-25T23:01:00.000Z");
  assert.equal(row.coverage_json.includes("never-copy"),false);
  assert.equal(JSON.parse(row.coverage_json).funds.bindings[0].quantity,"2.5");
  assert.equal(JSON.parse(row.portfolio_json).entries[0].asOf,"2026-10-24");
  assert.equal((await stat(f.path)).mode & 0o777,0o600);
  const before = await readFile(join(f.stateDir,"personal-assets.json"),"utf8");
  assert.deepEqual(await archiveExistingPersonalAssetsSnapshots({stateDir:f.stateDir,snapshots:state.snapshots}),{inspected:1,archived:0});
  assert.equal(await readFile(join(f.stateDir,"personal-assets.json"),"utf8"),before);
});

test("daily asset changes reconcile additions/removals and missing values stay unknown", async t => {
  const f = await fixture(t);
  await createPersonalAssetsSnapshot({stateDir:f.stateDir,revision:1,daily:true,now:new Date("2026-10-24T15:55:00Z")});
  f.portfolio.entries = [f.portfolio.entries[1],{...f.portfolio.entries[0],id:"new",amount:2}];
  await savePersonalAssets({stateDir:f.stateDir,portfolio:f.portfolio,revision:1});
  await createPersonalAssetsSnapshot({stateDir:f.stateDir,revision:2,daily:true,now:new Date("2026-10-25T15:55:00Z")});
  const db = new DatabaseSync(f.path);t.after(() => db.close());
  let rows=db.prepare("SELECT * FROM daily_asset_changes WHERE beijing_day='2026-10-25'").all();
  assert.equal(rows.reduce((sum,row)=>sum+row.change_cny,0),21);
  assert.equal(rows.find(row=>row.entry_id==="cash").after_json,null);
  assert.equal(db.prepare("SELECT change_cny FROM daily_changes WHERE beijing_day='2026-10-25'").get().change_cny,21);
  delete f.portfolio.rates.USD;
  await savePersonalAssets({stateDir:f.stateDir,portfolio:f.portfolio,revision:2});
  await createPersonalAssetsSnapshot({stateDir:f.stateDir,revision:3,daily:true,now:new Date("2026-10-26T15:55:00Z")});
  assert.equal(db.prepare("SELECT change_cny FROM daily_changes WHERE beijing_day='2026-10-26'").get().change_cny,null);
  rows=db.prepare("SELECT change_cny FROM daily_asset_changes WHERE beijing_day='2026-10-26'").all();
  assert.ok(rows.every(row=>row.change_cny===null));
  await createPersonalAssetsSnapshot({stateDir:f.stateDir,revision:3,daily:true,now:new Date("2026-10-28T15:55:00Z")});
  assert.equal(db.prepare("SELECT change_cny FROM daily_changes WHERE beijing_day='2026-10-28'").get().change_cny,null);
});

test("history backfill is idempotent, conflicts and unsafe databases preserve prior records", async t => {
  const f = await fixture(t);
  const state=await createPersonalAssetsSnapshot({stateDir:f.stateDir,revision:1});
  const snapshot=JSON.parse(await readFile(join(f.stateDir,"personal-assets-snapshots",state.snapshots[0].id+".json"),"utf8"));
  await rm(f.path);
  assert.deepEqual(await archiveExistingPersonalAssetsSnapshots({stateDir:f.stateDir,snapshots:state.snapshots}),{inspected:1,archived:1});
  assert.equal((await archivePersonalAssetsSnapshot({stateDir:f.stateDir,snapshot})).saved,false);
  snapshot.portfolio.entries[1].amount=200;snapshot.total=1393;
  await assert.rejects(archivePersonalAssetsSnapshot({stateDir:f.stateDir,snapshot}),/identity conflict/);
  const db=new DatabaseSync(f.path);assert.equal(db.prepare("SELECT total_cny FROM snapshots").get().total_cny,693);db.close();
  await chmod(f.path,0o644);
  const before=await readFile(join(f.stateDir,"personal-assets.json"),"utf8");
  await assert.rejects(createPersonalAssetsSnapshot({stateDir:f.stateDir,revision:1,daily:true}),/private regular file/);
  assert.equal(await readFile(join(f.stateDir,"personal-assets.json"),"utf8"),before);
  assert.equal((await readPersonalAssets({stateDir:f.stateDir})).revision,1);
});
