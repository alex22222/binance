import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beijingDate } from "../src/fund-manager-evidence.mjs";
import { validateManagerReport } from "../src/fund-manager-delivery.mjs";
import { fundManagerHtml } from "../src/fund-manager-html.mjs";

const root = resolve(import.meta.dirname, "..");
const command = process.argv[2];
const date = process.argv[3] || beijingDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Expected YYYY-MM-DD");
const directory = resolve(root, "state/fund-manager", date);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

async function remote(script, input = "") {
  return new Promise((resolveResult, reject) => {
    const child = spawn("ssh", [
      "-i", "/Users/henry/.ssh/polymtrade_vultr_ed25519", "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2", "root@173.199.122.23", script
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      // Remote stderr can contain provider request details; keep it out of report/log output.
      if (code !== 0) reject(new Error(`Fund manager remote ${command} failed (${code}); ${stderr.includes("Uncertain delivery") ? "uncertain delivery; inspect receipt" : "inspect the report service"}`));
      else {
        try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error("Invalid remote evidence or receipt")); }
      }
    });
    child.stdin.end(input);
  });
}

const remoteRoot = "/opt/binance-agentic-stock-bot";
if (command === "collect") {
  if (date !== beijingDate()) throw new Error("Collect produces a current snapshot; historical dates are not supported");
  const source = await readFile(resolve(root, "src/fund-manager-evidence.mjs"), "utf8");
  const evidence = await remote(`cd ${quote(remoteRoot)} && FUND_MANAGER_COLLECT=1 node --input-type=module`, source);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ event: "fund_manager_evidence_ready", reportDate: evidence.reportDate, tradingDate: evidence.tradingDate, liveStatus: evidence.live.status, archiveStale: evidence.archive.stale, path: resolve(directory, "evidence.json"), errors: evidence.errors }));
} else if (["send", "preview", "publish"].includes(command)) {
  if (date !== beijingDate()) throw new Error("Only today's Beijing report can be sent");
  const file = process.argv[4] ? resolve(process.argv[4]) : resolve(directory, "report.md");
  let text = await readFile(file, "utf8");
  const edition = command === "preview" || process.argv.includes("--preview") ? "preview" : "daily";
  if (edition === "preview") text = `【首次验收预览，正式早报将重新采集】\n\n${text}`;
  validateManagerReport(date, text);
  const action = command === "publish" ? "FUND_MANAGER_PUBLISH" : "FUND_MANAGER_SEND";
  const result = await remote(`cd ${quote(remoteRoot)} && set -a && . /etc/binance-agentic-stock-bot.env && set +a && ${action}=1 runuser --preserve-environment -u binancebot -- node --input-type=module -e ${quote('await import("./src/fund-manager-delivery.mjs");')}`, JSON.stringify({ date, text, edition }));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, `${edition === "preview" ? "preview" : "report"}.html`), fundManagerHtml({ date, text, edition }), { mode: 0o600 });
  await writeFile(resolve(directory, `${command}.receipt.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
} else if (command === "status") {
  const result = await remote(`cd ${quote(remoteRoot)} && node --input-type=module -e ${quote(`import { readFile } from "node:fs/promises"; console.log(await readFile("state/fund-manager/${date}-daily.receipt.json", "utf8").catch(e => e.code === "ENOENT" ? '{"status":"NOT_SENT"}' : Promise.reject(e)));`)}`);
  console.log(JSON.stringify(result));
} else {
  throw new Error("Usage: node scripts/run-fund-manager.mjs collect|status|send|preview|publish [YYYY-MM-DD] [report.md] [--preview]");
}
