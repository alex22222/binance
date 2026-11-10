// Explicit read-only acceptance audit. Credentials stay on the VPS and are
// never serialized. No service/collector start, config edit or notification.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadLeveragedAccountRisk } from "../../src/btc-radar-sources.mjs";
import { leverageRisk } from "../../src/btc-radar-risk.mjs";

const remote = `
import {readFile} from 'node:fs/promises';
import {createOkxReadOnlyClient} from '/opt/binance-agentic-stock-bot/src/btc-radar-sources.mjs';
const env={};
for(const file of ['/etc/binance-agentic-stock-bot.env','/etc/binance-agentic-btc-radar.env']){
  let text;try{text=await readFile(file,'utf8')}catch(e){if(e.code==='ENOENT')continue;throw e}
  for(const line of text.split(/\\r?\\n/)){
    const match=line.match(/^(OKX_API_KEY|OKX_API_SECRET|OKX_API_PASSPHRASE)=(.*)$/);
    if(match){let value=match[2].trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);env[match[1]]=value}
  }
}
const get=createOkxReadOnlyClient({apiKey:env.OKX_API_KEY,secretKey:env.OKX_API_SECRET,passphrase:env.OKX_API_PASSPHRASE,
fetchImpl:(url,options)=>fetch(url,{...options,headers:{...options.headers,'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'}})});
const payloads={};
const keys=new Set(['instId','instType','posId','pos','posSide','posCcy','sz','ordType','tgtCcy','lever','mgnMode','tdMode','side','reduceOnly','algoId','slTriggerPx','slOrdPx','slTriggerPxType','tpTriggerPx','closeFraction','closeOrderAlgo','state','direction']);
const safe=row=>Object.fromEntries(Object.entries(row).filter(([k])=>keys.has(k)).map(([k,v])=>[k,k==='closeOrderAlgo'?v.map(safe):v]));
async function collect(path,params={}){const key=JSON.stringify([path,params]);try{const rows=await get(path,params);payloads[key]={rows:rows.map(safe)};return rows}catch(e){payloads[key]={error:e.message};return []}}
await collect('/api/v5/account/positions');
for(const ordType of ['oco','conditional']){let after;for(let i=0;i<20;i++){const rows=await collect('/api/v5/trade/orders-algo-pending',{ordType,limit:'100',...(after?{after}:{})});if(rows.length<100)break;const next=rows.at(-1).algoId;if(next===after)break;after=next}}
for(const kind of ['dca','grid']){
 const algoOrdType=kind==='dca'?'contract_dca':'contract_grid';
 const bots=await collect(kind==='dca'?'/api/v5/tradingBot/dca/ongoing-list':'/api/v5/tradingBot/grid/orders-algo-pending',{algoOrdType,limit:'100'});
 for(const bot of bots.filter(b=>!b.state||b.state==='running'))await collect(kind==='dca'?'/api/v5/tradingBot/dca/position-details':'/api/v5/tradingBot/grid/positions',{algoId:bot.algoId,algoOrdType});
}
console.log(JSON.stringify({fetchedAt:new Date().toISOString(),payloads}));
`;
const command = `node --input-type=module -e ${"'" + remote.replaceAll("'", "'\\''") + "'"}`;
const { stdout } = await promisify(execFile)("ssh", ["-i", join(homedir(), ".ssh", "polymtrade_vultr_ed25519"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=12", "root@173.199.122.23", command], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
const captured = JSON.parse(stdout);
const account = await loadLeveragedAccountRisk(async (path, params = {}) => {
  const result = captured.payloads[JSON.stringify([path, params])];
  if (!result) throw new Error("AUDIT_RESPONSE_NOT_CAPTURED");
  if (result.error) throw new Error(result.error);
  return result.rows;
});
// Do not claim an effective score-dependent allowance without the full model.
const audit = { fetchedAt: captured.fetchedAt, readOnly: true, account: leverageRisk(account, null),
  thresholdScenarios: [54.9, 55, 69.9, 70].map(score => ({ hypotheticalScore: score, ...leverageRisk(account, score) })) };
const directory = resolve("artifacts/btc-radar-v3-study");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "account-audit.json"), JSON.stringify(audit, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ fetchedAt: audit.fetchedAt, readOnly: true, complete: account.complete,
  errors: account.errors, positions: account.positions.map(({ instId, source, direction, size, leverage, stopCoverage, coverageNote }) => ({ instId, source, direction, size, leverage, stopCoverage, coverageNote })) }, null, 2));
