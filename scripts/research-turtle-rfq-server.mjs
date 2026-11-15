// One-shot SSH diagnostic. No deploy, restart, login, signing or transaction call.
import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RFQ_QUOTE_WINDOW_MS } from "./scheduled-turtle-rfq.mjs";
export { RFQ_QUOTE_WINDOW_MS };

export function assertRfqExecutionTime(slotAt, firstCall, nowMs = Date.now()) {
  if (slotAt === undefined) return; // Unscheduled one-shot diagnostics retain their explicit invocation.
  const start = Date.parse(slotAt), deadline = start + (firstCall ? 600000 : 1200000); // 10 min to start, 20 min of quote validity
  if (!Number.isFinite(start) || nowMs < start || nowMs >= deadline) throw new Error("Outside scheduled read-only wallet window");
}

export function isRfqFeeRead(args) {
  return (args.length === 2 && args[0] === "wallet" && args[1] === "address")
    || (args.length === 6 && args[0] === "wallet" && args[1] === "tx-history" && args[2] === "--tx" && /^0x[a-fA-F0-9]{64}$/.test(args[3]) && args[4] === "--binanceChainId" && args[5] === "56");
}

export function parseRfqCollectorOutput(error, stdout) {
  let report;
  try { report = JSON.parse(stdout); } catch { throw new Error("Read-only collector failed without a complete JSON receipt"); }
  if (report?.mode !== "READ_ONLY") throw new Error("Invalid read-only collector receipt");
  return { ...report, collectorProcess: { exitedSuccessfully: !error, exitCode: error?.code ?? 0 } };
}

export async function buildServerTurtleRfqSource({ slotAt, feeEvidence = false } = {}) {
  const universe = await readFile(new URL("../src/turtle-etf-universe.mjs", import.meta.url), "utf8");
  const collector = (await readFile(new URL("./research-turtle-rfq.mjs", import.meta.url), "utf8"))
    .replace('import { TURTLE_ETF_UNIVERSE, turtleEtfAssets } from "../src/turtle-etf-universe.mjs";', universe);
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(collector).toString("base64");
  const source = `
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
const { collectTurtleRfq, roundTripSample, assertResearchReadCommand } = await import(${JSON.stringify(moduleUrl)});
const root = "/opt/binance-agentic-stock-bot";
const hash = value => createHash("sha256").update(value).digest("hex");
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 35000, maxBuffer: 4 << 20 });
const pids = () => run("systemctl", ["show", "binance-agentic-stock-bot", "binance-agentic-dashboard", "--property=Id,MainPID,ExecMainStartTimestamp"]);
const files = [root + "/config.json", "/etc/binance-agentic-stock-bot.env", root + "/state/approval-control.json", root + "/state/strategy-control.json", ...fs.readdirSync(root + "/src").filter(f => f.endsWith(".mjs")).sort().map(f => root + "/src/" + f)];
const fingerprint = () => hash(JSON.stringify(files.map(file => [file, hash(fs.readFileSync(file))])));
const before = { at: new Date().toISOString(), fingerprint: fingerprint(), pids: pids() };
const pid = run("systemctl", ["show", "binance-agentic-stock-bot.service", "--property=MainPID", "--value"]).trim();
const serviceEnv = Object.fromEntries(fs.readFileSync("/proc/" + pid + "/environ", "utf8").split("\\0").filter(Boolean).map(v => { const i = v.indexOf("="); return [v.slice(0, i), v.slice(i + 1)]; }));
const selected = Object.fromEntries(Object.entries(serviceEnv).filter(([key]) => ["HOME", "PATH", "BINANCE_BAW_DIR", "BINANCE_INSTANCE_ID", "BAW_CLI_PATH", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key)));
if (!selected.BINANCE_INSTANCE_ID || !selected.BINANCE_BAW_DIR || !selected.BAW_CLI_PATH || !selected.HOME) throw new Error("Incomplete production wallet context; no CLI call allowed");
const uid = Number(run("id", ["-u", "binancebot"]).trim()), gid = Number(run("id", ["-g", "binancebot"]).trim());
const commands = [];
const slotAt = ${JSON.stringify(slotAt) ?? "undefined"};
const feeEvidence = ${JSON.stringify(feeEvidence)};
const assertRfqExecutionTime = ${assertRfqExecutionTime.toString()};
const isRfqFeeRead = ${isRfqFeeRead.toString()};
let firstCliCall = true;
async function cliRead(args) {
  const feeRead = feeEvidence && isRfqFeeRead(args);
  if (!feeRead) assertResearchReadCommand(args);
  assertRfqExecutionTime(slotAt, firstCliCall);
  firstCliCall = false;
  const at = new Date().toISOString(); let raw;
  try { raw = execFileSync(selected.BAW_CLI_PATH, [...args, "--json"], { env: selected, uid, gid, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, maxBuffer: 2 << 20 }); }
  catch (error) { raw = error.stdout; if (!raw) { commands.push({ at, operation: args.slice(0, 2), status: "CLI_TIMEOUT_OR_NO_JSON" }); throw new Error("CLI timeout or no JSON response"); } }
  assertRfqExecutionTime(slotAt, false);
  let payload; try { payload = JSON.parse(raw); } catch { throw new Error("CLI returned non-JSON output"); }
  commands.push({ at, operation: args.slice(0, 2), status: payload.success ? "SUCCESS" : "ERROR", code: payload.error?.code ?? null });
  if (!payload.success) throw new Error(String(payload.error?.message || payload.message || "Quote unavailable"));
  return { data: payload.data, sha256: hash(raw) };
}
const temporary = await mkdtemp("/tmp/binance-turtle-rfq-");
const report = await collectTurtleRfq(temporary, cliRead);
report.context = { scope: "EXACT_RUNNING_BOT_CONTEXT", uid: "binancebot", home: selected.HOME, walletDirectory: selected.BINANCE_BAW_DIR, instanceConfigured: true, cliPath: selected.BAW_CLI_PATH };
report.closedMarketDiagnostics = [];
const usdt = "0x55d398326f99059fF775485246999027B3197955";
// One small quote per closed asset confirms the API behavior. Never a regular-session sample.
for (const asset of report.instruments.filter(a => a.statusSource.payload?.data?.openState === false)) {
  const startedAt = new Date().toISOString(), amount = "50";
  const row = { symbol: asset.symbol, contractAddress: asset.contractAddress, amount, startedAt, evidenceLevel: "OFFSESSION_DIAGNOSTIC_NOT_QUALIFYING" };
  try {
    const buy = await cliRead(["market-order", "quote", "--fromTokenQty", amount, "--fromToken", usdt, "--toToken", asset.contractAddress, "--binanceChainId", "56", "--slippage", "0.5"]);
    const sell = await cliRead(["market-order", "quote", "--fromTokenQty", String(buy.data.toCoinAmount), "--fromToken", asset.contractAddress, "--toToken", usdt, "--binanceChainId", "56", "--slippage", "0.5"]);
    Object.assign(row, roundTripSample(amount, buy.data, sell.data, startedAt, new Date().toISOString()), { evidenceLevel: "OFFSESSION_DIAGNOSTIC_NOT_QUALIFYING", buySourceHash: buy.sha256, sellSourceHash: sell.sha256 });
  } catch (error) { row.error = error.message; row.endedAt = new Date().toISOString(); }
  report.closedMarketDiagnostics.push(row);
}
const state = JSON.parse(fs.readFileSync(root + "/state/bot-state.json", "utf8"));
const history = state.roundTripGasHistoryUsdt || [];
const config = JSON.parse(fs.readFileSync(root + "/config.json", "utf8"));
report.costConfiguration = { maxRoundTripCostPct: config.maxRoundTripCostPct, executionBufferPct: config.executionBufferPct, estimatedRoundTripGasUsdt: config.estimatedRoundTripGasUsdt };
report.gas = { source: "SAVED_BOT_AGGREGATES_NOT_INDEPENDENTLY_RECONCILED", valuesUsdt: history, sampleCount: history.length, traceSource: config.traceFile, terminalRows: [] };
const tracePath = root + "/" + config.traceFile;
const info = fs.statSync(tracePath), input = fs.createReadStream(tracePath, { end: info.size - 1 });
for await (const line of createInterface({ input, crlfDelay: Infinity })) {
  if (!line.includes('"pending_order"') || !line.includes('"finished"')) continue;
  let row; try { row = JSON.parse(line); } catch { continue; }
  if (row.event !== "pending_order" || row.status !== "finished") continue;
  const d = row.details || {};
  if (!["SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "GLD", "DBC"].includes(d.symbol)) continue;
  const keys = ["side", "symbol", "orderId", "entryType", "parentOrderId", "costBasisUsdt", "positionCostBasisUsdt", "txHash", "gasBnb", "gasUsdt", "gasSource", "entryTxHash", "exitTxHash", "exitGasBnb", "exitGasUsdt", "exitGasSource", "gasCostUsdt"];
  report.gas.terminalRows.push({ at: row.timestamp, sourceLineHash: hash(line), ...Object.fromEntries(keys.filter(key => d[key] !== undefined).map(key => [key, d[key]])) });
}
report.gas.traceRead = { bytesAtStart: info.size, mtimeAtStart: info.mtime.toISOString(), completeThroughCapturedSize: true };
report.gas.customerFeeEvidence = { status: "UNKNOWN", history: [], currentUserGasDebitVerified: false, gasIncludedInQuote: null };
if (feeEvidence && report.walletStatus === "CONNECTED") {
  try {
    const addresses = await cliRead(["wallet", "address"]);
    const address = addresses.data?.addresses?.find(a => a.binanceChainId === "56")?.address;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("BSC wallet address unavailable");
    report.gas.customerFeeEvidence.walletAddressHash = hash(address.toLowerCase());
    const hashes = [...new Set(report.gas.terminalRows.flatMap(r => [r.txHash, r.entryTxHash, r.exitTxHash]).filter(Boolean))];
    if (hashes.length > 20 || hashes.some(h => !/^0x[a-fA-F0-9]{64}$/.test(h))) throw new Error("Historical fee scope exceeds limit");
    for (const txHash of hashes) {
      try {
        const response = await cliRead(["wallet", "tx-history", "--tx", txHash, "--binanceChainId", "56"]);
        const rows = (response.data?.transactions ?? []).filter(r => r.txHash?.toLowerCase() === txHash.toLowerCase());
        report.gas.customerFeeEvidence.history.push({ txHash, sourceHash: response.sha256, transactions: rows.map(r => ({ txHash: r.txHash, status: r.status, txTime: r.txTime,
          networks: (r.txHashList ?? []).filter(t => t.txHash?.toLowerCase() === txHash.toLowerCase() && t.binanceChainId === "56").map(t => ({ txHash: t.txHash, status: t.status, networkFee: t.networkFee ?? null })) })) });
      } catch (error) { report.gas.customerFeeEvidence.history.push({ txHash, error: error.message }); }
    }
  } catch (error) { report.gas.customerFeeEvidence.error = error.message; }
}
report.commands = commands;
report.protection = { beforeAt: before.at, afterAt: new Date().toISOString(), protectedFingerprintUnchanged: before.fingerprint === fingerprint(), servicePidsUnchanged: before.pids === pids() };
report.completedAt = new Date().toISOString();
console.log(JSON.stringify(report));
if (!report.protection.protectedFingerprintUnchanged || !report.protection.servicePidsUnchanged) process.exitCode = 1;
`;
  return source;
}

export async function collectServerTurtleRfq(directory, { slotAt, local = false, feeEvidence = false } = {}) {
  const source = await buildServerTurtleRfqSource({ slotAt, feeEvidence });
  const args = ["-i", "/Users/henry/.ssh/polymtrade_vultr_ed25519", "-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ControlPath=none", "root@173.199.122.23", "nice -n 15 node --input-type=module"];
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "remote-runner.mjs"), source, { flag: "wx", mode: 0o600 });
  const result = await new Promise((ok, fail) => {
    const child = execFile(local ? process.execPath : "ssh", local ? ["--input-type=module"] : args, { timeout: RFQ_QUOTE_WINDOW_MS, maxBuffer: 8 << 20 }, (error, stdout) => {
      try { ok(parseRfqCollectorOutput(error, stdout)); } catch (failure) { fail(failure); }
    });
    child.stdin.end(source);
  });
  const report = result;
  await writeFile(resolve(directory, "quote-report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Supply a new isolated research output directory");
  const report = await collectServerTurtleRfq(resolve(process.argv[2]));
  console.log(JSON.stringify({ status: report.status, samples: report.pairedQuotes.length, failures: report.failures.length, closedDiagnostics: report.closedMarketDiagnostics.length, gasTerminalRows: report.gas.terminalRows.length, protection: report.protection }));
}
