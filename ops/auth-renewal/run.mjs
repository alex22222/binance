import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicJson, commitRegistry, decideRenewal, deliverEvent, digest, reminderEvents, recoverPrepared, STRATEGY_ID } from "./core.mjs";

const root="/opt/binance-agentic-stock-bot",directory="/var/lib/binance-agentic-authorization",policyPath="/etc/binance-agentic-authorization-policy.json";
const release=await realpath(dirname(process.argv[1]));
const json=async p=>JSON.parse(await readFile(p,"utf8"));
const manifest=await json(join(release,"release.json"));
const sha=b=>createHash("sha256").update(b).digest("hex");
for(const [name,hash]of Object.entries(manifest.files)) {
  if(!/^[a-z-]+\.mjs$/.test(name))throw Error("Invalid release filename");
  const path=join(release,name),info=await lstat(path);
  if(!info.isFile()||info.uid!==0||(info.mode&0o022)||sha(await readFile(path))!==hash)throw Error("Immutable release identity invalid");
}
if(process.argv[2]==="verify") { console.log(JSON.stringify({event:"authorization_release_verified"})); }
else if(process.argv[2]!=="tick")throw Error("Expected verify or tick");
else {
  if(process.env.AUTHORIZATION_WRITER_LOCKED!=="1")throw Error("Use the shared flock writer entry point");
  let policy={policyId:manifest.policyId,hardDeadline:manifest.hardDeadline};
  const privatePath=join(directory,"private-state.json");
  let state,decision,runtime,registry;
  const registryPath=join(root,"strategy-governance/authorizations.json");
  const statePath=name=>{
    const p=resolve(root,name);
    if(!p.startsWith(root+"/state/"))throw Error("Unexpected production state path");
    return p;
  };
  async function sourceHash() {
    const names=(await readdir(root+"/src")).filter(n=>!n.startsWith(".")&&n.endsWith(".mjs")).sort();
    return digest(await Promise.all(names.map(async n=>[n,sha(await readFile(root+"/src/"+n))])));
  }
  async function snapshot() {
    const sampledAt=new Date().toISOString();
    const config=await json(root+"/config.json"),control=await json(statePath(config.strategyControlFile));
    const bot=await json(statePath(config.stateFile));
    const stop=await json(statePath(config.emergencyStopFile)).catch(e=>e.code==="ENOENT"?null:Promise.reject(e));
    const codeHash=await sourceHash();
    const approvalControlHash=digest(await json(root+"/state/approval-control.json"));
    return{sampledAt,config,control,codeHash,heartbeatAt:bot.updatedAt,emergencyStop:stop?.active===true,approvalControlHash};
  }
  async function verifyFinal() {
    const r=await snapshot();
    return digest(await json(policyPath))===state.policyHash&&r.codeHash===policy.codeHash&&digest(r.config)===policy.configHash&&
      digest(r.control)===policy.controlHash&&r.approvalControlHash===policy.approvalControlHash&&!r.emergencyStop&&
      Date.now()<Date.parse(policy.hardDeadline)&&Date.now()-Date.parse(r.heartbeatAt)>=0&&Date.now()-Date.parse(r.heartbeatAt)<=300000;
  }
  async function send(text,uuid) {
    const env=process.env,id=env.FEISHU_RECEIVE_ID;
    if(!env.FEISHU_APP_ID||!env.FEISHU_APP_SECRET||!id||env.FEISHU_WEBHOOK_URL)throw Error("Notification App is not configured");
    const post=async(url,body,token)=>{
      const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
      const data=await r.json();if(!r.ok||data.code!==0)throw Error("Feishu business request failed");return data;
    };
    const type=env.FEISHU_RECEIVE_ID_TYPE||(id.startsWith("oc_")?"chat_id":id.startsWith("ou_")?"open_id":null);
    if(!type)throw Error("Unknown notification receive type");
    const auth=await post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",{app_id:env.FEISHU_APP_ID,app_secret:env.FEISHU_APP_SECRET});
    if(!auth.tenant_access_token)throw Error("Missing notification token");
    const result=await post("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type="+encodeURIComponent(type),{receive_id:id,msg_type:"text",content:JSON.stringify({text}),uuid},auth.tenant_access_token);
    return{channel:"app",messageId:result.data?.message_id};
  }
  try {
    let configWritable=false;try{await access(root+"/config.json",constants.W_OK);configWritable=true;}catch(e){if(!["EACCES","EROFS"].includes(e.code))throw e;}
    if(configWritable||(await lstat("/etc/binance-agentic-stock-bot.env")).size!==0)throw Error("Missing production write/secret isolation");
    const policyInfo=await lstat(policyPath);
    if(!policyInfo.isFile()||policyInfo.uid!==0||(policyInfo.mode&0o777)!==0o600)throw Error("Unsafe consent policy permissions");
    policy=await json(policyPath);
    const own=await lstat(privatePath);if(!own.isFile()||own.uid!==0||(own.mode&0o077))throw Error("Unsafe private state");
    state=await json(privatePath);registry=await json(registryPath);runtime=await snapshot();
    const notificationFiles=await readdir(join(directory,"notifications")).catch(e=>e.code==="ENOENT"?[]:Promise.reject(e));
    for(const name of notificationFiles.filter(n=>/^[a-f0-9]{64}\.receipt\.json$/.test(n))) {
      if((await json(join(directory,"notifications",name))).status==="SENDING"&&!state.halted){
        state={...state,halted:{reason:"NOTIFICATION_UNCONFIRMED",at:new Date().toISOString()}};await atomicJson(privatePath,state);
      }
    }
    let governance=null,marketOpen=false;
    if(runtime.codeHash===policy.codeHash) {
      governance=await import(pathToFileURL(root+"/src/strategy-governance.mjs"));
      runtime.identity=governance.strategyIdentity(runtime.config,STRATEGY_ID,runtime.codeHash);
      const strategy=await import(pathToFileURL(root+"/src/strategy.mjs"));marketOpen=strategy.nyseSessionPlan().regularOpen;
    } else {
      // Frozen calendar is read-only and used only to decide when to alert, never to permit orders.
      const {nyseSessionPlan}=await import("./calendar.mjs");marketOpen=nyseSessionPlan().regularOpen;
    }
    for(const p of [registryPath,dirname(registryPath)]){const s=await lstat(p);if(s.uid!==0||(s.mode&0o022)||s.isSymbolicLink())throw Error("Unsafe operator registry permissions");}
    const journalPath=join(directory,"renewal-journal.json");
    const journal=await json(journalPath).catch(e=>e.code==="ENOENT"?null:Promise.reject(e));
    state=await recoverPrepared({directory,state,registry,journal});
    decision=decideRenewal({policy,state,runtime,registry,nowMs:Date.now(),evaluate:governance?.evaluatePromotion||(()=>({allowed:false}))});
    if(decision.action==="RENEW") {
      state=await commitRegistry({registryPath,directory,registry,state,decision,verify:verifyFinal});
      registry=await json(registryPath);
    }
    if(decision.action==="HALT"&&!state.halted){state={...state,halted:{reason:decision.reason,at:new Date().toISOString()}};await atomicJson(privatePath,state);}
    const grant=registry.authorizations?.find(g=>g.strategyId===STRATEGY_ID);
    const loadedGate=governance?await governance.loadStrategyGate({projectRoot:root,config:runtime.config,strategyId:STRATEGY_ID}):{allowed:false};
    const actualGate={...loadedGate,allowed:runtime.control.strategyId===STRATEGY_ID&&loadedGate.allowed===true};
    // A stopped renewer does not rewrite/revoke a surviving lease. Report its actual current gate separately.
    decision.gate=actualGate;
    const errors=[];
    for(const event of reminderEvents({policy,state,decision,nowMs:Date.now(),marketOpen})) {
      try{await deliverEvent({directory:join(directory,"notifications"),policyId:policy.policyId,event,send});}
      catch{errors.push(event.key);}
    }
    if(errors.length&&!state.halted){state={...state,halted:{reason:"NOTIFICATION_UNCONFIRMED",at:new Date().toISOString()}};await atomicJson(privatePath,state);}
    const status={schemaVersion:1,strategyId:STRATEGY_ID,checkedAt:runtime.sampledAt,authorizationAllowed:actualGate.allowed===true,
      entryControlsOpen:runtime.control.strategyId===STRATEGY_ID&&!runtime.control.entriesPaused&&!runtime.emergencyStop,
      leaseExpiresAt:grant?.expiresAt||null,hardDeadline:policy.hardDeadline,autoRenewalState:errors.length?"ERROR":decision.action==="EXPIRED"?"EXPIRED":state.halted?"HALTED":"ACTIVE",
      reason:state.halted?.reason||decision.reason,generation:state.generation};
    await atomicJson(join(directory,"public-status.json"),status,0o640);
    await atomicJson(join(directory,"last-tick.json"),{...status,decision:decision.action,notificationErrors:errors});
    console.log(JSON.stringify({event:"authorization_tick",action:decision.action,status:status.autoRenewalState,generation:state.generation,notificationErrors:errors.length}));
    if(errors.length)process.exitCode=1;
  } catch(error) {
    const reason="RENEWAL_OR_COLLECTION_FAILED";
    if(state&&!state.halted){state={...state,halted:{reason,at:new Date().toISOString()}};await atomicJson(privatePath,state);}
    const publicFailure={schemaVersion:1,strategyId:STRATEGY_ID,checkedAt:new Date().toISOString(),authorizationAllowed:false,entryControlsOpen:false,leaseExpiresAt:null,
      hardDeadline:policy.hardDeadline,autoRenewalState:"ERROR",reason,generation:state?.generation??null};
    await atomicJson(join(directory,"public-status.json"),publicFailure,0o640);
    await atomicJson(join(directory,"last-failure.json"),{...publicFailure,errorCode:error.code||null,error: String(error.message).replace(/https?:\/\/\S+/g,"[url]").slice(0,160)});
    await deliverEvent({directory:join(directory,"notifications"),policyId:policy.policyId,event:{key:"operational-failure",text:"[Agentic Stock Bot] 自动续签失败，已停止并保留证据。原因：读取/提交/恢复失败。请人工处理；未改风控、未下单。https://spaceflag.site"},send}).catch(()=>{});
    console.log(JSON.stringify({event:"authorization_tick_failed",reason}));process.exitCode=1;
  }
}
