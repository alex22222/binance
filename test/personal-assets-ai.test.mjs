import test from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyPortfolio } from "../src/personal-assets-core.mjs";
import { assetReviewInput, readAssetAiStatus, reviewPersonalAssets, configureAssetAi } from "../src/personal-assets-ai.mjs";
const now = new Date("2026-10-24T14:00:00Z");
const key = "sk-synthetic-asset-review-key-never-export";
function assets() {
 const portfolio=emptyPortfolio();
 portfolio.accounts[0].name="secret account 0x1111111111111111111111111111111111111111";
 portfolio.accounts[0].note="secret note";
 portfolio.entries=[{id:"one",accountId:portfolio.accounts[0].id,kind:"total",name:"secret holding",category:"组合资产",currency:"CNY",amount:100,asOf:"2026-10-24",source:"manual"}];
 return {revision:2,updatedAt:now.toISOString(),portfolio,snapshots:[],fx:{status:"fresh",fetchedAt:now.toISOString()},sync:{providers:{okxweb3:{credentials:{apiKey:key},targetAccountId:portfolio.accounts[0].id,lastValuationComplete:false,lastUnpricedAssets:[{quantity:"25",contract:"private address"}]}}}};
}
async function dir(t){const p=await mkdtemp(join(tmpdir(),"assets-ai-"));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
const response=(text="当前组合集中度需结合未同步账户核对。")=>Response.json({choices:[{finish_reason:"stop",message:{role:"assistant",content:text,reasoning_content:"private reasoning not published"}}]});
test("AI inputs contain aggregated coverage and freshness, never names, notes, addresses, quantities or credentials",()=>{
 const input=assets();input.funds={status:"available",bindings:[{name:"secret fund",quantity:"2.34567891",isin:"HK0000857299",enabled:true,confirmedOn:"2020-01-01",navDate:"2026-10-23"}]};
 const data=assetReviewInput(input);const encoded=JSON.stringify(data);
 assert.equal(data.baseCurrency,"CNY");assert.equal(data.total,100);assert.equal(data.unpricedAssets,1);
 for(const value of [key,"secret account","secret note","secret holding","0x111","private address","secret fund","2.34567891","HK0000857299"])assert.equal(encoded.includes(value),false);
 assert.equal(data.fundRevaluations.quantityBasis,"manually-entered-or-screenshot-not-account-sync");
 input.funds.bindings.push({symbol:"sz000534",name:"secret stock",quantity:"1234567",quantityBasis:"screenshot",confirmedOn:"2026-10-24",priceDate:"2026-10-23",priceBasis:"market-quote"});
 const updated=assetReviewInput(input);assert.equal(updated.fundRevaluations.positions[1].quantityBasis,"screenshot");assert.equal(updated.fundRevaluations.positions[1].priceDate,"2026-10-23");
 for(const value of ["secret stock","sz000534","1234567"])assert.equal(JSON.stringify(updated).includes(value),false);
 assert.ok(data.byCategory.some(row=>row.name==="组合资产"));
});
test("missing AI configuration is explicit and performs no external request",async t=>{
 const stateDir=await dir(t);let calls=0;
 const result=await reviewPersonalAssets({stateDir,assets:assets(),now,fetchImpl:async()=>{calls++;}});
 assert.equal(result.status,"unconfigured");assert.equal(calls,0);assert.equal((await readAssetAiStatus({stateDir})).configured,false);
});
test("Moonshot configuration makes one bounded inference and caches the whole Beijing day",async t=>{
 const stateDir=await dir(t);let calls=0;
 const fetchImpl=async(url,init)=>{calls++;assert.equal(url,"https://api.moonshot.cn/v1/chat/completions");assert.equal(init.redirect,"error");const body=JSON.parse(init.body);assert.equal(body.tools,undefined);assert.equal(body.model,"kimi-k3.1-pro");assert.equal(body.reasoning_effort,"low");assert.equal(body.max_completion_tokens,2400);assert.equal(body.stream,false);assert.equal(body.messages[0].role,"system");assert.equal(body.messages[1].role,"user");assert.equal(init.headers.Authorization,"Bearer "+key);assert.equal(init.body.includes("secret note"),false);return response();};
 const first=await configureAssetAi({stateDir,apiKey:key,assets:assets(),now,fetchImpl});
 assert.equal(first.status,"fresh");assert.ok(first.review.text);assert.equal(first.review.revision,2);assert.equal(first.review.provider,"moonshot");assert.equal(first.provider,"moonshot");
 assert.equal(first.quota.limit,1);assert.equal(first.quota.used,1);assert.equal(first.quota.remaining,0);assert.equal(first.quota.timeZone,"Asia/Shanghai");assert.equal(first.quota.date,"2026-10-24");assert.equal(first.quota.nextAllowedAt,"2026-10-24T16:00:00.000Z");assert.equal(first.lastAttemptStatus,"succeeded");
 for(const file of ["personal-assets-ai-moonshot.json","personal-assets-ai-attempts/2026-10-24-result.json","personal-assets-ai-attempts/2026-10-24.json"])assert.equal((await stat(join(stateDir,file))).mode&0o777,0o600);
 assert.equal((await stat(join(stateDir,"personal-assets-ai-attempts"))).mode&0o777,0o700);
 const second=await reviewPersonalAssets({stateDir,assets:assets(),now:new Date(now.getTime()+1000),fetchImpl});
 assert.equal(second.status,"cached");assert.equal(calls,1);
 const changed=assets();changed.revision=3;
 const outdated=await reviewPersonalAssets({stateDir,assets:changed,now:new Date(now.getTime()+60*60_000),fetchImpl});
 assert.equal(outdated.status,"outdated");assert.equal(outdated.review.revision,2);assert.equal(calls,1);
 const switched=await configureAssetAi({stateDir,apiKey:key+"-replacement",assets:changed,now:new Date("2026-10-24T15:59:59Z"),fetchImpl:async()=>{throw Error("daily quota cannot be bypassed by key change");}});
 assert.equal(switched.configurationSaved,true);assert.equal(switched.quota.remaining,0);assert.equal(switched.status,"outdated");
 assert.equal(JSON.stringify(await readAssetAiStatus({stateDir,now})).includes(key),false);
 const tomorrow=await reviewPersonalAssets({stateDir,assets:changed,now:new Date("2026-10-24T16:00:00Z"),fetchImpl:async(url,init)=>{calls++;assert.equal(init.headers.Authorization,"Bearer "+key+"-replacement");return response("新一天的点评。");}});
 assert.equal(tomorrow.status,"fresh");assert.equal(calls,2);assert.equal(tomorrow.quota.date,"2026-10-25");
});
test("failed attempts consume the day, retain previous review, and reject force or key-change bypass",async t=>{
 const stateDir=await dir(t);let calls=0;
 const first=await configureAssetAi({stateDir,apiKey:key,assets:assets(),now,fetchImpl:async()=>{calls++;return new Response(key,{status:401});}});
 assert.equal(first.status,"unavailable");assert.equal(first.configured,true);assert.equal(first.lastAttemptStatus,"failed");assert.equal(first.quota.remaining,0);assert.equal(JSON.stringify(first).includes(key),false);
 const retry=await configureAssetAi({stateDir,apiKey:key+"-new",assets:assets(),now:new Date(now.getTime()+1000),force:true,fetchImpl:async()=>{calls++;return response();}});
 assert.equal(calls,1);assert.equal(retry.status,"unavailable");assert.equal(retry.configurationSaved,true);
 const tomorrow=new Date("2026-10-24T16:00:00Z");
 const valid=await reviewPersonalAssets({stateDir,assets:assets(),now:tomorrow,fetchImpl:async()=>{calls++;return response("保留的有效点评。");}});
 const failed=await reviewPersonalAssets({stateDir,assets:assets(),now:new Date("2026-10-25T16:00:00Z"),fetchImpl:async()=>{calls++;return new Response("upstream secret "+key,{status:429});}});
 assert.equal(failed.status,"unavailable");assert.equal(failed.review.text,valid.review.text);assert.equal(failed.review.generatedAt,valid.review.generatedAt);assert.equal(JSON.stringify(failed).includes(key),false);
 const status=await readAssetAiStatus({stateDir,now:new Date("2026-10-25T17:00:00Z")});assert.equal(status.lastAttemptStatus,"failed");assert.equal(status.quota.remaining,0);assert.equal(status.review.text,valid.review.text);
 assert.equal(calls,3);
});
test("old OpenAI credentials are neither reused as Moonshot nor overwritten; cached review keeps original provenance",async t=>{
 const stateDir=await dir(t);const old=JSON.stringify({schemaVersion:1,apiKey:"old-openai-secret"})+"\n";
 await writeFile(join(stateDir,"personal-assets-ai.json"),old,{mode:0o600});
 await writeFile(join(stateDir,"personal-assets-ai-review.json"),JSON.stringify({schemaVersion:1,lastAttemptAt:"2026-10-24T13:00:00Z",review:{text:"旧 OpenAI 点评",generatedAt:"2026-10-24T13:00:02Z",revision:1,fingerprint:"a".repeat(64)}}),{mode:0o600});
 const status=await readAssetAiStatus({stateDir,now});assert.equal(status.configured,false);assert.equal(status.review.provider,"openai");assert.equal(status.review.model,"gpt-5.4-mini");
 let calls=0;const result=await reviewPersonalAssets({stateDir,assets:assets(),now,fetchImpl:async()=>{calls++;return response();}});
 assert.equal(result.status,"unconfigured");assert.equal(result.review.text,"旧 OpenAI 点评");assert.equal(calls,0);
 const configured=await configureAssetAi({stateDir,apiKey:key,assets:assets(),now,fetchImpl:async()=>{calls++;return response();}});
 assert.equal(configured.quota.remaining,0);assert.equal(calls,0);assert.equal(await readFile(join(stateDir,"personal-assets-ai.json"),"utf8"),old);
});
test("concurrent requests and a persisted attempt after process loss cannot create another daily inference",async t=>{
 const stateDir=await dir(t);let release;const wait=new Promise(resolve=>release=resolve);let entered;const started=new Promise(resolve=>entered=resolve);let calls=0;
 const first=configureAssetAi({stateDir,apiKey:key,assets:assets(),now,fetchImpl:async()=>{calls++;entered();await wait;return response();}});
 await started;
 const parallel=await Promise.allSettled([reviewPersonalAssets({stateDir,assets:assets(),now,force:true,fetchImpl:async()=>{calls++;return response();}}),configureAssetAi({stateDir,apiKey:key+"-other",assets:assets(),now,fetchImpl:async()=>{calls++;return response();}})]);
 assert.equal(calls,1);assert.ok(parallel.every(row=>row.status==="fulfilled"?row.value.quota.remaining===0:row.reason.statusCode===429));release();await first;
 const restarted=await import("../src/personal-assets-ai.mjs?restart="+Date.now());
 const cached=await restarted.reviewPersonalAssets({stateDir,assets:assets(),now,fetchImpl:async()=>{calls++;return response();}});assert.equal(cached.quota.remaining,0);assert.equal(calls,1);
 const orphan=await dir(t);await writeFile(join(orphan,"personal-assets-ai-moonshot.json"),JSON.stringify({schemaVersion:1,provider:"moonshot",apiKey:key}),{mode:0o600});
 await mkdir(join(orphan,"personal-assets-ai-attempts"),{mode:0o700});
 await writeFile(join(orphan,"personal-assets-ai-attempts/2026-10-24.json"),JSON.stringify({schemaVersion:1,date:"2026-10-24",attemptedAt:now.toISOString(),provider:"moonshot",model:"kimi-k3.1-pro"}),{mode:0o600});
 const recovered=await restarted.reviewPersonalAssets({stateDir:orphan,assets:assets(),now,fetchImpl:async()=>{calls++;return response();}});assert.equal(calls,1);assert.equal(recovered.quota.remaining,0);assert.equal(recovered.lastAttemptStatus,"attempted");assert.equal(recovered.status,"unavailable");
});
test("local invalid key and missing config never consume quota; corrupt attempt files fail closed",async t=>{
 const stateDir=await dir(t);let calls=0;
 for(const apiKey of ["", "short", "contains whitespace key", "x".repeat(501)])await assert.rejects(async()=>configureAssetAi({stateDir,apiKey,assets:assets(),now,fetchImpl:async()=>{calls++;return response();}}),e=>e.statusCode===400);
 await reviewPersonalAssets({stateDir,assets:assets(),now,fetchImpl:async()=>{calls++;return response();}});assert.equal(calls,0);assert.equal((await readAssetAiStatus({stateDir,now})).quota.remaining,1);
 await mkdir(join(stateDir,"personal-assets-ai-attempts"),{mode:0o700});await writeFile(join(stateDir,"personal-assets-ai-attempts/2026-10-24.json"),"{}",{mode:0o600});
 await assert.rejects(configureAssetAi({stateDir,apiKey:key,assets:assets(),now,fetchImpl:async()=>{calls++;return response();}}));assert.equal(calls,0);
});
test("incomplete, tool-only, empty, oversized and invalid JSON responses do not replace cached reviews or retry that day",async t=>{
 for(const make of [()=>Response.json({choices:[{finish_reason:"length",message:{role:"assistant",content:"unfinished"}}]}),()=>Response.json({choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:"",tool_calls:[{}]}}]}),()=>response(""),()=>new Response("not JSON"),()=>new Response("{}",{headers:{"content-length":"1000001"}})]) {
  const stateDir=await dir(t);let calls=0;const result=await configureAssetAi({stateDir,apiKey:key,assets:assets(),now,fetchImpl:async()=>{calls++;return make();}});
  assert.equal(result.status,"unavailable");assert.equal(result.review,null);assert.equal(result.quota.remaining,0);
  await reviewPersonalAssets({stateDir,assets:assets(),now,fetchImpl:async()=>{calls++;return response();}});assert.equal(calls,1);
 }
});
test("a clock rollover after durable reservation never sends under yesterday's quota",async t=>{
 const stateDir=await dir(t);let clockReads=0;let calls=0;
 const before=new Date("2026-10-24T15:59:59.999Z"),after=new Date("2026-10-24T16:00:00.001Z");
 const result=await configureAssetAi({stateDir,apiKey:key,assets:assets(),clock:()=>++clockReads<=2?before:after,fetchImpl:async()=>{calls++;return response();}});
 assert.equal(calls,0);assert.equal(result.status,"unavailable");assert.match(result.error,/跨日/);
 const next=await reviewPersonalAssets({stateDir,assets:assets(),clock:()=>after,fetchImpl:async()=>{calls++;return response();}});
 assert.equal(next.status,"fresh");assert.equal(calls,1);assert.equal(next.quota.date,"2026-10-25");
 await configureAssetAi({stateDir,apiKey:key+"-new",assets:assets(),clock:()=>after,fetchImpl:async()=>{calls++;return response();}});assert.equal(calls,1);
});
test("crashing after an upstream attempt and a legacy stale lock cannot reset quota or block the next day",async t=>{
 const stateDir=await dir(t);
 const moduleUrl=new URL("../src/personal-assets-ai.mjs",import.meta.url).href;
 const code=`import { configureAssetAi } from ${JSON.stringify(moduleUrl)};await configureAssetAi({stateDir:process.env.ASSET_AI_TEST_DIR,apiKey:${JSON.stringify(key)},assets:${JSON.stringify(assets())},now:new Date(${JSON.stringify(now.toISOString())}),fetchImpl:async()=>{process.stdout.write("upstream-entered\\n");await new Promise(()=>{});}});`;
 const child=spawn(process.execPath,["--input-type=module","--eval",code],{env:{...process.env,ASSET_AI_TEST_DIR:stateDir},stdio:["ignore","pipe","pipe"]});
 t.after(()=>{if(child.exitCode===null)child.kill("SIGKILL");});
 await new Promise((resolve,reject)=>{let output="",error="";child.stdout.on("data",data=>{output+=data;if(output.includes("upstream-entered"))resolve();});child.stderr.on("data",data=>error+=data);child.once("exit",()=>reject(Error("child exited before request: "+error)));});
 const exited=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGKILL");await exited;
 await writeFile(join(stateDir,"personal-assets-ai.lock"),"",{mode:0o600});
 let calls=0;const cached=await reviewPersonalAssets({stateDir,assets:assets(),now,fetchImpl:async()=>{calls++;return response();}});assert.equal(calls,0);assert.equal(cached.quota.remaining,0);assert.equal(cached.lastAttemptStatus,"attempted");
 const tomorrow=await reviewPersonalAssets({stateDir,assets:assets(),now:new Date("2026-10-24T16:00:00Z"),fetchImpl:async()=>{calls++;return response();}});assert.equal(calls,1);assert.equal(tomorrow.status,"fresh");
});
test("overlapping days and key replacement retain the latest successful daily result without config overwrite",async t=>{
 const stateDir=await dir(t);let release;const waiting=new Promise(resolve=>release=resolve);let entered;const started=new Promise(resolve=>entered=resolve);let current=now;
 const yesterday=configureAssetAi({stateDir,apiKey:key,assets:assets(),clock:()=>current,fetchImpl:async()=>{entered();await waiting;return response("较早一天的点评");}});await started;
 current=new Date("2026-10-24T16:00:01Z");const changed=assets();changed.revision=3;
 const today=await configureAssetAi({stateDir,apiKey:key+"-latest",assets:changed,clock:()=>current,fetchImpl:async()=>response("最新一天的点评")});assert.equal(today.review.text,"最新一天的点评");
 current=new Date("2026-10-24T16:00:02Z");release();await yesterday;
 const status=await readAssetAiStatus({stateDir,now:current});assert.equal(status.review.text,"最新一天的点评");assert.equal(status.review.revision,3);assert.equal(status.lastAttemptStatus,"succeeded");assert.equal(status.quota.remaining,0);
 assert.equal(JSON.parse(await readFile(join(stateDir,"personal-assets-ai-moonshot.json"),"utf8")).apiKey,key+"-latest");
});
test("persisted reservations keep their cap across provider or model changes without blocking later days",async t=>{
 const stateDir=await dir(t);await mkdir(join(stateDir,"personal-assets-ai-attempts"),{mode:0o700});
 await writeFile(join(stateDir,"personal-assets-ai-attempts/2026-10-24.json"),JSON.stringify({schemaVersion:1,date:"2026-10-24",attemptedAt:now.toISOString(),provider:"earlier-provider",model:"earlier-model"}),{mode:0o600});
 let calls=0;const blocked=await configureAssetAi({stateDir,apiKey:key,assets:assets(),now,fetchImpl:async()=>{calls++;return response();}});assert.equal(blocked.quota.remaining,0);assert.equal(calls,0);
 const next=await reviewPersonalAssets({stateDir,assets:assets(),now:new Date("2026-10-24T16:00:00Z"),fetchImpl:async()=>{calls++;return response();}});assert.equal(next.status,"fresh");assert.equal(calls,1);
});
