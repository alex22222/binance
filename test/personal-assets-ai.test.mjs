import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
const response=(text="当前组合集中度需结合未同步账户核对。")=>Response.json({status:"completed",output:[{type:"reasoning"},{type:"message",role:"assistant",content:[{type:"output_text",text}]}]});
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
test("configuration verifies a real response, stores private credentials, returns safe text and reuses a bounded cache",async t=>{
 const stateDir=await dir(t);let calls=0;
 const fetchImpl=async(url,init)=>{calls++;assert.equal(url,"https://api.openai.com/v1/responses");assert.equal(init.redirect,"error");const body=JSON.parse(init.body);assert.equal(body.store,false);assert.equal(body.tools,undefined);assert.equal(body.model,"gpt-5.4-mini");assert.equal(init.headers.Authorization,"Bearer "+key);assert.equal(init.body.includes("secret note"),false);return response();};
 const first=await configureAssetAi({stateDir,apiKey:key,assets:assets(),now,fetchImpl});
 assert.equal(first.status,"fresh");assert.ok(first.review.text);assert.equal(first.review.revision,2);
 assert.equal((await stat(join(stateDir,"personal-assets-ai.json"))).mode&0o777,0o600);
 const second=await reviewPersonalAssets({stateDir,assets:assets(),now:new Date(now.getTime()+1000),fetchImpl});
 assert.equal(second.status,"cached");assert.equal(calls,1);
 const changed=assets();changed.revision=3;
 const outdated=await reviewPersonalAssets({stateDir,assets:changed,now:new Date(now.getTime()+2000),fetchImpl});
 assert.equal(outdated.status,"outdated");assert.equal(outdated.review.revision,2);assert.equal(calls,1);
 assert.equal(JSON.stringify(await readAssetAiStatus({stateDir})).includes(key),false);
});
test("failed configuration and failed refresh never leak upstream data or pretend the prior review is current",async t=>{
 const stateDir=await dir(t);
 await assert.rejects(configureAssetAi({stateDir,apiKey:key,assets:assets(),now,fetchImpl:async()=>new Response(key,{status:401})}),e=>e.statusCode===400&&!e.message.includes(key));
 assert.equal((await readAssetAiStatus({stateDir})).configured,false);
 await configureAssetAi({stateDir,apiKey:key,assets:assets(),now,fetchImpl:async()=>response()});
 const result=await reviewPersonalAssets({stateDir,assets:assets(),now:new Date(now.getTime()+301000),fetchImpl:async()=>new Response(key,{status:429})});
 assert.equal(result.status,"unavailable");assert.ok(result.review.text);assert.equal(JSON.stringify(result).includes(key),false);
 const retry=await reviewPersonalAssets({stateDir,assets:assets(),now:new Date(now.getTime()+302000),fetchImpl:async()=>{throw Error("should not retry within cooldown");}});
 assert.equal(retry.status,"unavailable");
});
test("incomplete, empty, oversized and invalid JSON responses are not published as AI reviews",async t=>{
 for(const make of [()=>Response.json({status:"incomplete",output:[]}),()=>response(""),()=>new Response("not JSON"),()=>new Response("{}",{headers:{"content-length":"1000001"}})]) {
  const stateDir=await dir(t);await assert.rejects(configureAssetAi({stateDir,apiKey:key,assets:assets(),now,fetchImpl:async()=>make()}));
  assert.equal((await readAssetAiStatus({stateDir})).configured,false);
 }
});
