import { lstat, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname,join } from "node:path";
import { revokeRegistry } from "./core.mjs";

if(process.getuid()!==0||process.argv[2]!=="revoke"||process.env.AUTHORIZATION_WRITER_LOCKED!=="1")throw Error("Use root binance-authorization-revoke shared-lock entry point");
const release=await realpath(dirname(process.argv[1])),manifest=JSON.parse(await readFile(join(release,"release.json"),"utf8"));
for(const name of["core.mjs","operator.mjs"]) {
  const path=join(release,name),s=await lstat(path);
  if(!s.isFile()||s.uid!==0||(s.mode&0o022)||createHash("sha256").update(await readFile(path)).digest("hex")!==manifest.files[name])throw Error("Operator release identity invalid");
}
console.log(JSON.stringify(await revokeRegistry({registryPath:"/opt/binance-agentic-stock-bot/strategy-governance/authorizations.json",directory:"/var/lib/binance-agentic-authorization"})));
