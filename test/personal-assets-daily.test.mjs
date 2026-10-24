import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDailyPersonalAssetsSnapshot } from "../scripts/snapshot-personal-assets.mjs";
import { emptyPortfolio, readPersonalAssets, savePersonalAssets } from "../src/personal-assets.mjs";
test("daily worker freezes valued amounts and safe source coverage and is idempotent",async t=>{
 const stateDir=await mkdtemp(join(tmpdir(),"assets-daily-"));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const portfolio=emptyPortfolio();portfolio.entries=[{id:"one",accountId:"account-1",kind:"total",name:"synthetic",category:"现金",currency:"USD",amount:2,asOf:"2026-10-24",source:"manual"}];
 await savePersonalAssets({stateDir,portfolio,revision:0});
 await writeFile(join(stateDir,"personal-assets-sync.json"),JSON.stringify({schemaVersion:1,providers:{okx:{credentials:{apiKey:"never-snapshot",secret:"never-snapshot",passphrase:"never-snapshot"},enabled:false,lastAppliedAt:null}}}),{mode:0o600});
 const valueState=async state=>({...state,portfolio:{...state.portfolio,rates:{CNY:{value:1,date:"2026-10-24"},USD:{value:7,date:"2026-10-24"}}},fx:{status:"fresh",rates:{}}});
 const result=await runDailyPersonalAssetsSnapshot({stateDir,now:new Date("2026-10-24T15:55:00Z"),valueState});assert.equal(result.saved,true);
 assert.equal((await runDailyPersonalAssetsSnapshot({stateDir,now:new Date("2026-10-24T15:56:00Z"),valueState})).saved,false);
 const state=await readPersonalAssets({stateDir});const full=await readFile(join(stateDir,"personal-assets-snapshots",state.snapshots[0].id+".json"),"utf8");
 assert.equal(state.snapshots[0].total,14);assert.equal(full.includes("never-snapshot"),false);assert.ok(JSON.parse(full).sync.providers.okx);
 assert.deepEqual(state.portfolio,portfolio);assert.equal(state.revision,1);
});
test("an empty account inventory is not saved as a zero-value daily snapshot",async t=>{
 const stateDir=await mkdtemp(join(tmpdir(),"assets-daily-empty-"));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 assert.deepEqual(await runDailyPersonalAssetsSnapshot({stateDir}),{status:"no-recorded-assets",saved:false});
});

test("the daily CLI actually executes when systemd launches it through the current release symlink",async t=>{
 const stateDir=await mkdtemp(join(tmpdir(),"assets-daily-cli-"));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const portfolio=emptyPortfolio();portfolio.entries=[{id:"one",accountId:"account-1",kind:"total",name:"synthetic",category:"现金",currency:"CNY",amount:2,asOf:"2026-10-24",source:"manual"}];
 await savePersonalAssets({stateDir,portfolio,revision:0});
 const linked=join(stateDir,"current-daily.mjs");await symlink(new URL("../scripts/snapshot-personal-assets.mjs",import.meta.url),linked);
 const {stdout}=await promisify(execFile)(process.execPath,[linked],{env:{...process.env,PERSONAL_ASSETS_DIR:stateDir,PERSONAL_ASSETS_FX_DISABLED:"1"}});
 assert.match(stdout,/personal-assets-daily-snapshot/);
 assert.equal((await readPersonalAssets({stateDir})).snapshots.length,1);
});

test("importing the daily helper from stdin does not execute the CLI or require a real argv filename",async()=>{
 const moduleUrl=new URL("../scripts/snapshot-personal-assets.mjs",import.meta.url).href;
 const {stdout}=await promisify(execFile)(process.execPath,["--input-type=module","-e",`process.argv[1]="-";await import(${JSON.stringify(moduleUrl)});console.log("helper imported")`]);
 assert.equal(stdout.trim(),"helper imported");
});
