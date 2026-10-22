import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile, chown, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

export const STRATEGY_ID = "weekly-etf-dual-momentum-defense";
const DAY = 86400000, iso = n => new Date(n).toISOString();
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])) : v;
export const digest = v => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
export const atomicJson = async (path,value,mode=0o600) => {
  const temporary=path+".tmp";
  await writeFile(temporary,JSON.stringify(value,null,2)+"\n",{mode});await chmod(temporary,mode);await rename(temporary,path);
};
const readJson = path => readFile(path,"utf8").then(JSON.parse);
export function decideRenewal({policy:p,state:s,runtime:r,registry,nowMs:n,evaluate}) {
  const halt=reason=>({action:"HALT",reason,gate:{allowed:false}});
  const start=Date.parse(p?.startsAt),end=Date.parse(p?.hardDeadline);
  if(p?.schemaVersion!==1||p.strategyId!==STRATEGY_ID||p.consentedBy!=="henry"||!p.policyId||p.enabled!==true||
      !Number.isFinite(n)||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>30*DAY||n<start) return halt("INVALID_OR_DISABLED_POLICY");
  if(n>=end)return{action:"EXPIRED",reason:"TOTAL_WINDOW_ENDED",gate:{allowed:false}};
  if(!s||s.schemaVersion!==1||s.policyHash!==digest(p)||!s.expectedGrantHash||!Number.isInteger(s.generation)||s.generation<0)return halt("PRIVATE_STATE_OR_POLICY_CHANGED");
  if(s.halted)return halt(s.halted.reason||"PREVIOUSLY_HALTED");
  if(!r||r.codeHash!==p.codeHash||r.identity?.identityHash!==p.identityHash)return halt("CODE_OR_IDENTITY_CHANGED");
  if(digest(r.config)!==p.configHash)return halt("CONFIG_CHANGED");
  if(digest(r.control)!==p.controlHash||r.control?.strategyId!==STRATEGY_ID||r.control.entriesPaused)return halt("STRATEGY_CONTROL_CHANGED");
  if(r.approvalControlHash!==p.approvalControlHash)return halt("APPROVAL_CONTROL_CHANGED");
  if(r.emergencyStop)return halt("EMERGENCY_STOP");
  const age=n-Date.parse(r.heartbeatAt);
  if(!Number.isFinite(age)||age<0||age>300000)return halt("BOT_HEARTBEAT_STALE");
  const matches=registry?.schemaVersion===1&&Array.isArray(registry.authorizations)?registry.authorizations.filter(a=>a.strategyId===STRATEGY_ID):[];
  if(matches.length!==1||digest(matches[0])!==s.expectedGrantHash)return halt("GRANT_REVOKED_OR_CHANGED");
  const grant=matches[0],expiry=Date.parse(grant.expiresAt);
  if(grant.type!=="EXPERIMENTAL_EXCEPTION"||grant.topUpRequest!=null||!Number.isFinite(expiry)||expiry>end)return halt("GRANT_SCOPE_INVALID");
  // The fixed user consent may recover the SAME expired lease, never a revoked or edited one.
  const validAt=Math.min(n,expiry-1);
  const checked=evaluate({identity:r.identity,config:r.config,authorization:grant,nowMs:validAt});
  if(!checked.allowed)return halt("EXISTING_GRANT_INVALID");
  const gate=evaluate({identity:r.identity,config:r.config,authorization:grant,nowMs:n});
  if(expiry===end||expiry-n>2*DAY)return{action:"KEEP",reason:"VALID",gate,grant};
  const next={...grant,approvedAt:iso(n),expiresAt:iso(Math.min(n+7*DAY,end)),
    autoRenewal:{policyId:p.policyId,consentedAt:p.startsAt,hardDeadline:p.hardDeadline,generation:s.generation+1}};
  delete next.topUpRequest;
  const nextGate=evaluate({identity:r.identity,config:r.config,authorization:next,nowMs:n});
  if(!nextGate.allowed)return halt("PROPOSED_LEASE_REJECTED");
  return{action:"RENEW",reason:expiry<=n?"RECOVER_SAME_EXPIRED_LEASE":"LEASE_DUE",grant:next,gate:nextGate};
}

export async function commitRegistry({registryPath,directory,registry,state,decision,verify}) {
  // Caller MUST hold writer.lock via flock, including every operator writer.
  // The hash checks detect drift; rename alone is not a cross-process CAS.
  if(decision.action!=="RENEW")throw Error("Not a renewal");
  const journalPath=join(directory,"renewal-journal.json"),privatePath=join(directory,"private-state.json");
  const old=registry.authorizations.find(a=>a.strategyId===STRATEGY_ID);
  if(!old||digest(old)!==state.expectedGrantHash)throw Error("CAS old grant mismatch");
  const next={...registry,authorizations:registry.authorizations.map(a=>a.strategyId===STRATEGY_ID?decision.grant:a)};
  const recovered={...state,expectedGrantHash:digest(decision.grant),generation:state.generation+1,
    lastRenewal:{grantHash:digest(decision.grant),approvedAt:decision.grant.approvedAt,expiresAt:decision.grant.expiresAt,generation:state.generation+1}};
  const prior=await readJson(journalPath).catch(e=>e.code==="ENOENT"?null:Promise.reject(e));
  if(prior&&prior.newRegistryHash===digest(next)&&digest(await readJson(registryPath))===digest(next)) {
    if(!await verify())throw Error("Final identity changed during recovery");
    await atomicJson(privatePath,recovered);await atomicJson(journalPath,{...prior,status:"APPLIED"});return recovered;
  }
  if(prior?.status==="PREPARED")throw Error("Unresolved previous renewal journal");
  if(digest(await readJson(registryPath))!==digest(registry))throw Error("CAS registry changed");
  if(!await verify())throw Error("Final identity changed");
  const info=await stat(registryPath),backup=join(directory,`grant-before-${state.generation}-${state.expectedGrantHash}.json`);
  await writeFile(backup,JSON.stringify(registry,null,2)+"\n",{mode:0o600,flag:"wx"});
  const journal={status:"PREPARED",oldRegistryHash:digest(registry),newRegistryHash:digest(next),state:recovered,preparedAt:new Date().toISOString()};
  await atomicJson(journalPath,journal);
  const temporary=registryPath+".renewal.tmp";
  await writeFile(temporary,JSON.stringify(next,null,2)+"\n",{mode:info.mode&0o777,flag:"wx"});
  if(process.getuid?.()===0)await chown(temporary,info.uid,info.gid);
  await chmod(temporary,info.mode&0o777);
  if(!await verify()||digest(await readJson(registryPath))!==digest(registry))throw Error("CAS or final identity changed before rename");
  await rename(temporary,registryPath);
  if(digest(await readJson(registryPath))!==digest(next))throw Error("Registry changed after rename");
  await atomicJson(privatePath,recovered);await atomicJson(journalPath,{...journal,status:"APPLIED"});return recovered;
}

export async function revokeRegistry({registryPath,directory,nowMs=Date.now()}) {
  // Same kernel writer lock as automatic renewal. No order or position mutation.
  const statePath=join(directory,"private-state.json"),state=await readJson(statePath),registry=await readJson(registryPath),info=await stat(registryPath);
  await atomicJson(statePath,{...state,halted:{reason:"OPERATOR_REVOKED",at:iso(nowMs)}});
  await writeFile(join(directory,`operator-revoke-${nowMs}.json`),JSON.stringify(registry,null,2)+"\n",{mode:0o600,flag:"wx"});
  const next={...registry,authorizations:registry.authorizations.filter(a=>a.strategyId!==STRATEGY_ID)};
  const temporary=registryPath+".revoke.tmp";await writeFile(temporary,JSON.stringify(next,null,2)+"\n",{mode:info.mode&0o777,flag:"wx"});
  if(process.getuid?.()===0)await chown(temporary,info.uid,info.gid);
  await chmod(temporary,info.mode&0o777);await rename(temporary,registryPath);
  return{revoked:true,strategyId:STRATEGY_ID};
}

export async function recoverPrepared({directory,state,registry,journal}) {
  if(journal?.status!=="PREPARED")return state;
  if(journal.state?.policyHash!==state.policyHash||![state.generation,state.generation+1].includes(journal.state.generation)||digest(registry)!==journal.newRegistryHash)throw Error("Unresolved prepared renewal; preserve evidence");
  const grant=registry.authorizations.find(g=>g.strategyId===STRATEGY_ID);
  if(!grant||digest(grant)!==journal.state.expectedGrantHash)throw Error("Journal recovery grant mismatch");
  const recovered={...journal.state,halted:state.halted||journal.state.halted};
  await atomicJson(join(directory,"private-state.json"),recovered);
  await atomicJson(join(directory,"renewal-journal.json"),{...journal,status:"APPLIED",recoveredAt:new Date().toISOString()});
  return recovered;
}

const bj = at => new Date(at).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
export function reminderEvents({policy:p,state:s,decision:d,nowMs:n,marketOpen}) {
  const events=[],remaining=Date.parse(p.hardDeadline)-n;
  const add=(key,text)=>events.push({key,text:`[Agentic Stock Bot] ${text}\n策略：周频ETF双动量防守\n总授权截止（北京）：${bj(p.hardDeadline)}\n原风控/审批/一次性补仓限制不变；授权有效不代表已经成交。\nhttps://spaceflag.site`});
  if(["KEEP","RENEW"].includes(d.action))add("enabled",`30天有界自动续签已启用\n服务器独立检查；单张租约最长7天，代码/配置等变化将停止续签，不自动接受新版本。`);
  if(s?.lastRenewal)add("renewed-"+s.lastRenewal.grantHash,`最近一次实验授权自动续签记录\n签发（北京）：${bj(s.lastRenewal.approvedAt)}\n本张到期（北京）：${bj(s.lastRenewal.expiresAt)}；仍非研究合格。`);
  if(remaining<=0)add("deadline-expired","30天总授权已结束，已停止续签；原例外到期后禁止新增买入，保护性卖出规则不变。需要重新明确授权。");
  else if(remaining<=DAY)add("deadline-24h","总授权将在24小时内到期；届时停止续签及新增买入资格，请人工复核。不是永久授权。");
  else if(remaining<=2*DAY)add("deadline-48h","总授权将在48小时内到期；如需继续请人工复核，不会自动延长30天窗口。");
  if(d.action==="HALT")add("halt-"+d.reason,`自动续签已停止，需要处理\n原因：${d.reason}。不会自动解除；现有租约是否仍有效以当前闸门为准。`);
  if(marketOpen&&remaining>0&&d.gate?.allowed!==true) {
    const date=new Date(n).toLocaleDateString("en-CA",{timeZone:"America/New_York"});
    add("market-blocked-"+date+"-"+d.reason,`开市时新增买入授权未放行\n原因：${d.reason}。未发单、未补买，其他风控仍独立生效。`);
  }
  return events;
}

export async function deliverEvent({directory,policyId,event,send}) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const id=digest([policyId,event.key]),receiptPath=join(directory,id+".receipt.json"),messagePath=join(directory,id+".message.txt"),lockPath=join(directory,id+".lock");
  const existing=await readJson(receiptPath).catch(e=>e.code==="ENOENT"?null:Promise.reject(e));
  if(existing?.status==="SENT")return{...existing,duplicateSkipped:true};
  const lock=await open(lockPath,"wx",0o600);
  try {
    const old=await readJson(receiptPath).catch(e=>e.code==="ENOENT"?null:Promise.reject(e));
    if(old?.status==="SENT")return{...old,duplicateSkipped:true};
    if(old?.status==="SENDING")throw Error("Uncertain Feishu delivery; inspect receipt before retry");
    await writeFile(messagePath,event.text,{mode:0o600});
    const pending={key:event.key,status:"SENDING",messageHash:digest(event.text),uuid:id.slice(0,40),attemptedAt:new Date().toISOString()};
    await atomicJson(receiptPath,pending);
    const result=await send(event.text,pending.uuid);
    if(result?.channel!=="app"||!result.messageId)throw Error("Missing business receipt");
    const sent={...pending,status:"SENT",channel:result.channel,messageId:result.messageId,sentAt:new Date().toISOString()};
    await atomicJson(receiptPath,sent);return sent;
  }finally{await lock.close();await unlink(lockPath);}
}
