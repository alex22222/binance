import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../ops/auth-renewal/core.mjs";

const linux = process.platform === "linux";
const core = new URL("../ops/auth-renewal/core.mjs",import.meta.url).href;
const ID="weekly-etf-dual-momentum-defense";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function start(t,lock,path) {
  const child=spawn("/usr/bin/flock",["--no-fork",lock,process.execPath,path],{env:{PATH:"/usr/bin:/bin"},stdio:["ignore","pipe","pipe"]});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await once(child,"exit");}});
  return child;
}
const finish=child=>once(child,"exit").then(([code,signal])=>({code,signal}));
test("shared kernel lock serializes operator revocation after an in-flight registry writer",{skip:!linux,timeout:15000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),"auth-flock-revoke-")),lock=join(dir,"writer.lock"),registryPath=join(dir,"registry.json");
  const registry={schemaVersion:1,authorizations:[{strategyId:ID,value:1},{strategyId:"other",value:3}]};
  await writeFile(registryPath,JSON.stringify(registry));await writeFile(join(dir,"private-state.json"),JSON.stringify({generation:0,halted:null}));
  const writer=join(dir,"writer.mjs"),revoker=join(dir,"revoke.mjs");
  await writeFile(writer,`import{readFile,writeFile,rename,access}from'node:fs/promises';const p=${JSON.stringify(registryPath)},signal=${JSON.stringify(join(dir,"continue"))};const r=JSON.parse(await readFile(p));console.log('holding-before-rename');for(;;){try{await access(signal);break;}catch{await new Promise(r=>setTimeout(r,10));}}r.authorizations[0].value=2;await writeFile(p+'.tmp',JSON.stringify(r));await rename(p+'.tmp',p);`);
  await writeFile(revoker,`import{revokeRegistry}from${JSON.stringify(core)};await revokeRegistry({registryPath:${JSON.stringify(registryPath)},directory:${JSON.stringify(dir)}});`);
  const a=await start(t,lock,writer);await once(a.stdout,"data");const aDone=finish(a);
  const b=await start(t,lock,revoker),bDone=finish(b);await sleep(100);assert.equal(b.exitCode,null,"revoker cannot bypass the active writer lock");
  await writeFile(join(dir,"continue"),"go");assert.equal((await aDone).code,0);assert.equal((await bDone).code,0);
  assert.deepEqual(JSON.parse(await readFile(registryPath)).authorizations,[{strategyId:"other",value:3}]);
  assert.equal(JSON.parse(await readFile(join(dir,"private-state.json"))).halted.reason,"OPERATOR_REVOKED");
});
test("kernel releases a killed writer and PREPARED metadata recovery does not sign or write the registry again",{skip:!linux,timeout:15000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),"auth-flock-crash-")),lock=join(dir,"writer.lock"),registryPath=join(dir,"registry.json");
  const old={schemaVersion:1,authorizations:[{strategyId:ID,value:1}]},grant={strategyId:ID,value:2},next={...old,authorizations:[grant]},state={schemaVersion:1,policyHash:"P",expectedGrantHash:digest(old.authorizations[0]),generation:0};
  const recovered={...state,generation:1,expectedGrantHash:digest(grant)};
  const writer=join(dir,"writer.mjs"),recover=join(dir,"recover.mjs");
  await writeFile(writer,`import{writeFile}from'node:fs/promises';const dir=${JSON.stringify(dir)};await writeFile(dir+'/registry.json',${JSON.stringify(JSON.stringify(next))});await writeFile(dir+'/private-state.json',${JSON.stringify(JSON.stringify(state))});await writeFile(dir+'/renewal-journal.json',${JSON.stringify(JSON.stringify({status:"PREPARED",oldRegistryHash:digest(old),newRegistryHash:digest(next),state:recovered}))});console.log('prepared-after-registry-rename');setInterval(()=>{},1000);`);
  await writeFile(recover,`import{readFile}from'node:fs/promises';import{recoverPrepared}from${JSON.stringify(core)};const dir=${JSON.stringify(dir)},json=async name=>JSON.parse(await readFile(dir+'/'+name));await recoverPrepared({directory:dir,state:await json('private-state.json'),registry:await json('registry.json'),journal:await json('renewal-journal.json')});`);
  const a=await start(t,lock,writer);await once(a.stdout,"data");
  assert.equal(spawnSync("/usr/bin/flock",["--nonblock","--conflict-exit-code=75",lock,"/usr/bin/true"]).status,75,"active lock is not stolen");
  const before=await readFile(registryPath,"utf8"),dead=finish(a);a.kill("SIGKILL");await dead;
  const b=await start(t,lock,recover);assert.equal((await finish(b)).code,0);
  assert.equal(await readFile(registryPath,"utf8"),before);
  assert.equal(JSON.parse(await readFile(join(dir,"private-state.json"))).generation,1);
  assert.equal(JSON.parse(await readFile(join(dir,"renewal-journal.json"))).status,"APPLIED");
});
