import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideRenewal, digest, reminderEvents, commitRegistry, deliverEvent, revokeRegistry, recoverPrepared } from "../ops/auth-renewal/core.mjs";
import { evaluatePromotion, strategyIdentity } from "../src/strategy-governance.mjs";
const DAY = 86400000, ID = "weekly-etf-dual-momentum-defense", NOW = Date.parse("2026-10-22T04:00:00Z");
const iso = n => new Date(n).toISOString();
function fixture() {
  const config = { defaultStrategyId: ID, symbols: ["QQQ","SPY","SGOV"], maxTradeUsdt: 250, maxOpenPositions: 1, dailyLossLimitUsdt: 2, disasterStopLossPct: 8,
    weeklyEtfAllocation: { allocationPct: 50, cashReservePct: 50, maxSingleLossUsdt: 20 } };
  const identity = strategyIdentity(config, ID, "a".repeat(64));
  const grant = { type: "EXPERIMENTAL_EXCEPTION", strategyId: ID, identityHash: identity.identityHash, approvedBy: "henry", approvedAt: iso(NOW-DAY), expiresAt: iso(NOW+DAY), reason: "User approved bounded exception", riskAccepted: true,
    limits: { maxTradeUsdt:250, maxOpenPositions:1, dailyLossLimitUsdt:2, weeklyEtfAllocation:config.weeklyEtfAllocation } };
  const registry = { schemaVersion:1, authorizations:[grant,{ strategyId:"unrelated", preserved:true }] };
  const policy = { schemaVersion:1, policyId:"test-30-days", enabled:true, strategyId:ID, consentedBy:"henry", startsAt:iso(NOW), hardDeadline:iso(NOW+30*DAY), identityHash:identity.identityHash,
    codeHash:identity.codeHash, configHash:digest(config), controlHash:digest({strategyId:ID,entriesPaused:false}), approvalControlHash:"b".repeat(64) };
  const state = { schemaVersion:1, policyHash:digest(policy), expectedGrantHash:digest(grant), generation:0, halted:null };
  const runtime = { codeHash:identity.codeHash, config, identity, control:{strategyId:ID,entriesPaused:false}, approvalControlHash:policy.approvalControlHash, heartbeatAt:iso(NOW), emergencyStop:false };
  return {policy,state,runtime,registry,nowMs:NOW,evaluate:evaluatePromotion};
}
test("renewal respects existing seven-day lease and does not create research eligibility or top-ups",()=>{
  const x=fixture(),d=decideRenewal(x); assert.equal(d.action,"RENEW");
  assert.equal(Date.parse(d.grant.expiresAt)-Date.parse(d.grant.approvedAt),7*DAY);
  assert.deepEqual(d.grant.limits,x.registry.authorizations[0].limits); assert.equal(d.grant.topUpRequest,undefined);
  const g=evaluatePromotion({config:x.runtime.config,identity:x.runtime.identity,authorization:d.grant,nowMs:NOW});
  assert.equal(g.allowed,true);assert.equal(g.researchQualified,false);assert.equal(g.protectiveExitAllowed,true);
});
test("fixed total cutoff clamps the final lease and expires exactly without sliding on restart",()=>{
  const x=fixture(); x.nowMs=NOW+29*DAY; x.runtime.heartbeatAt=iso(x.nowMs);
  const d=decideRenewal(x);assert.equal(d.action,"RENEW");assert.equal(d.grant.expiresAt,x.policy.hardDeadline);
  x.nowMs=NOW+30*DAY;assert.equal(decideRenewal(x).action,"EXPIRED");
  x.nowMs--; x.policy.hardDeadline=iso(NOW+31*DAY);assert.equal(decideRenewal(x).action,"HALT");
});
test("changes, revocation, pause, stale data and missing private state never auto-bind a new grant",()=>{
  const changes=[x=>{x.runtime.codeHash="c".repeat(64);},x=>{x.runtime.config.maxTradeUsdt=251;},x=>{x.runtime.config.symbols.push("VTI");},
    x=>{x.runtime.control.strategyId="other";},x=>{x.runtime.control.entriesPaused=true;},x=>{x.runtime.emergencyStop=true;},
    x=>{x.runtime.approvalControlHash="c".repeat(64);},x=>{x.registry.authorizations=[];},x=>{x.registry.authorizations[0].expiresAt=iso(NOW+2*DAY);},
    x=>{x.runtime.heartbeatAt=iso(NOW-301000);},x=>{x.runtime.heartbeatAt=iso(NOW+1000);},x=>{x.state=null;},x=>{x.policy.enabled=false;},
    x=>{x.registry.authorizations[0].topUpRequest={requestId:"consumed"};},x=>{x.state.halted={reason:"OPERATOR_REVOKED"};}];
  for(const edit of changes){const x=fixture();edit(x);assert.equal(decideRenewal(x).action,"HALT");}
});
test("a lease with ample time is unchanged, only the same expired lease may recover within fixed consent",()=>{
  const x=fixture();x.registry.authorizations[0].expiresAt=iso(NOW+4*DAY);x.state.expectedGrantHash=digest(x.registry.authorizations[0]);
  assert.equal(decideRenewal(x).action,"KEEP");
  x.registry.authorizations[0].expiresAt=iso(NOW-1);x.state.expectedGrantHash=digest(x.registry.authorizations[0]);assert.equal(decideRenewal(x).action,"RENEW");
});
test("the final capped lease is not reissued every minute during the last 48 hours",()=>{
  const x=fixture();x.nowMs=NOW+29*DAY;x.runtime.heartbeatAt=iso(x.nowMs);
  const d=decideRenewal(x);x.registry.authorizations[0]=d.grant;x.state.expectedGrantHash=digest(d.grant);x.state.generation++;
  x.nowMs+=60000;x.runtime.heartbeatAt=iso(x.nowMs);assert.equal(decideRenewal(x).action,"KEEP");
});
test("deadline notices are 48h,24h,expired and do not backfill superseded reminders",()=>{
  const x=fixture();let d={action:"KEEP",reason:"VALID",gate:{allowed:true}};
  const events=n=>reminderEvents({policy:x.policy,state:x.state,decision:d,nowMs:n,marketOpen:false});
  assert.ok(events(NOW).some(e=>e.key==="enabled"));
  assert.ok(events(NOW+28*DAY).some(e=>e.key==="deadline-48h"));
  assert.ok(events(NOW+29*DAY).some(e=>e.key==="deadline-24h"));
  assert.ok(!events(NOW+29*DAY).some(e=>e.key==="deadline-48h"));
  d={action:"EXPIRED",reason:"TOTAL_WINDOW_ENDED",gate:{allowed:false}};
  assert.ok(events(NOW+30*DAY).some(e=>e.key==="deadline-expired"));
  assert.ok(!events(NOW+30*DAY).some(e=>e.key==="deadline-24h"));
});
test("opening authorization blocks and latched failures produce stable dedup keys",()=>{
  const x=fixture(),decision={action:"HALT",reason:"CODE_CHANGED",gate:{allowed:false}};
  const a=reminderEvents({...x,decision,marketOpen:true}),b=reminderEvents({...x,decision,marketOpen:true,nowMs:NOW+60000});
  assert.deepEqual(a.map(e=>e.key),b.map(e=>e.key));assert.ok(a.some(e=>e.key.startsWith("market-blocked-")));
});
test("atomic registry commit preserves unrelated records and interrupted commit is reconciled, not signed twice",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"auth-renew-test-")),path=join(dir,"authorizations.json");
  const x=fixture(),before=JSON.stringify(x.registry);await writeFile(path,before,{mode:0o644});
  const decision=decideRenewal(x);
  const result=await commitRegistry({registryPath:path,directory:dir,registry:x.registry,state:x.state,decision,verify:async()=>true});
  const after=JSON.parse(await readFile(path));assert.deepEqual(after.authorizations[1],x.registry.authorizations[1]);
  assert.equal(result.expectedGrantHash,digest(after.authorizations[0]));
  const recovered=await commitRegistry({registryPath:path,directory:dir,registry:x.registry,state:x.state,decision,verify:async()=>true});
  assert.equal(recovered.expectedGrantHash,result.expectedGrantHash);assert.equal(recovered.generation,1);
  assert.equal(JSON.parse(await readFile(join(dir,"renewal-journal.json"))).status,"APPLIED");
});
test("CAS and final identity verification refuse external changes without overwriting them",async()=>{
  for(const conflict of [true,false]) {
    const dir=await mkdtemp(join(tmpdir(),"auth-cas-test-")),path=join(dir,"authorizations.json"),x=fixture();await writeFile(path,JSON.stringify(x.registry));
    if(conflict)await writeFile(path,JSON.stringify({schemaVersion:1,authorizations:[]}));
    await assert.rejects(commitRegistry({registryPath:path,directory:dir,registry:x.registry,state:x.state,decision:decideRenewal(x),verify:async()=>false}));
    assert.equal(JSON.parse(await readFile(path)).authorizations.length,conflict?0:2);
  }
});
test("operator revocation latches the stop and removes only this strategy without restoring top-ups",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"auth-revoke-test-")),registryPath=join(directory,"authorizations.json"),x=fixture();
  await writeFile(registryPath,JSON.stringify(x.registry));await writeFile(join(directory,"private-state.json"),JSON.stringify(x.state));
  await revokeRegistry({directory,registryPath,nowMs:NOW});
  x.registry=JSON.parse(await readFile(registryPath));x.state=JSON.parse(await readFile(join(directory,"private-state.json")));
  assert.deepEqual(x.registry.authorizations,[{strategyId:"unrelated",preserved:true}]);assert.equal(x.state.halted.reason,"OPERATOR_REVOKED");
  assert.equal(decideRenewal(x).action,"HALT");
});
test("production PREPARED recovery only restores metadata once and never clears an operator stop",async()=>{
  for(const stopped of [false,true]) {
    const directory=await mkdtemp(join(tmpdir(),"auth-recovery-test-")),x=fixture(),d=decideRenewal(x);
    const registry={...x.registry,authorizations:x.registry.authorizations.map(a=>a.strategyId===ID?d.grant:a)};
    const next={...x.state,generation:1,expectedGrantHash:digest(d.grant),lastRenewal:{grantHash:digest(d.grant),expiresAt:d.grant.expiresAt}};
    const journal={status:"PREPARED",oldRegistryHash:digest(x.registry),newRegistryHash:digest(registry),state:next};
    if(stopped)x.state.halted={reason:"OPERATOR_REVOKED"};
    const result=await recoverPrepared({directory,state:x.state,registry,journal});assert.equal(result.generation,1);
    if(stopped)assert.equal(result.halted.reason,"OPERATOR_REVOKED");
    const saved=JSON.parse(await readFile(join(directory,"renewal-journal.json")));
    assert.deepEqual(await recoverPrepared({directory,state:result,registry,journal:saved}),result);
    const n={...x,registry,state:result};assert.equal(decideRenewal(n).action,stopped?"HALT":"KEEP");
  }
});
test("notice archives before sending, validates business receipt and suppresses duplicates/uncertain resends",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"auth-notice-test-"));let calls=0;
  const args={directory,policyId:"P",event:{key:"enabled",text:"部署验收"},send:async()=>{calls++;return{channel:"app",messageId:"M1"};}};
  assert.equal((await deliverEvent(args)).status,"SENT");assert.equal((await deliverEvent(args)).duplicateSkipped,true);assert.equal(calls,1);
  args.event={key:"failure",text:"失败"};args.send=async()=>{calls++;throw Error("network");};await assert.rejects(deliverEvent(args));
  await assert.rejects(deliverEvent(args),/Uncertain/);assert.equal(calls,2);
  args.event={key:"no-business-receipt",text:"无回执"};args.send=async()=>({});await assert.rejects(deliverEvent(args),/receipt/);
});
