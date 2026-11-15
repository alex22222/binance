// Finite research workflow. No trading imports; all wallet access stays in the frozen quote-only driver.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RFQ_SCHEDULE = Object.freeze(["2026-11-16", "2026-11-17", "2026-11-18"].flatMap(date => [
  { id: date + "-open", sessionDate: date, phase: "open", at: date + "T14:45:00.000Z" },
  { id: date + "-mid", sessionDate: date, phase: "mid", at: date + "T17:45:00.000Z" },
  { id: date + "-close", sessionDate: date, phase: "close", at: date + "T20:30:00.000Z" }
]));
const symbols = ["SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "GLD", "DBC"];
const amounts = ["50", "217.66", "250"];
const usdt = "0x55d398326f99059fF775485246999027B3197955";
const sha = v => createHash("sha256").update(v).digest("hex");
const releaseFiles = ["scripts/scheduled-turtle-rfq.mjs", "scripts/research-turtle-rfq-server.mjs", "scripts/research-turtle-rfq.mjs", "scripts/research-turtle-rfq-chain.mjs", "src/turtle-etf-universe.mjs"];
const canonical = value => {
  if (!/^\d+(\.\d+)?$/.test(String(value)) || !(Number(value) > 0)) throw new Error("Invalid quote amount");
  const [whole, fraction = ""] = String(value).split(".");
  return whole.replace(/^0+(?=\d)/, "") + (fraction.replace(/0+$/, "") ? "." + fraction.replace(/0+$/, "") : "");
};

export function dueRfqSlot(nowMs, phase) {
  if (!["open", "mid", "close"].includes(phase) || !Number.isFinite(nowMs)) throw new Error("Invalid schedule phase/time");
  // A delayed launch can start at most ten minutes after its fixed slot, never before it.
  return RFQ_SCHEDULE.find(slot => slot.phase === phase && nowMs >= Date.parse(slot.at) && nowMs < Date.parse(slot.at) + 600000) ?? null;
}

export function qualifyingRfqPairs(report, slot) {
  if (report.collectorProcess?.exitedSuccessfully === false || report.walletStatus !== "CONNECTED" || report.context?.scope !== "EXACT_RUNNING_BOT_CONTEXT"
    || report.protection?.protectedFingerprintUnchanged !== true || report.protection?.servicePidsUnchanged !== true) return [];
  const launch = Date.parse(report.at), start = Date.parse(slot.at);
  if (!(launch >= start && launch < start + 600000)) return [];
  const seen = new Set(), valid = [];
  for (const pair of report.pairedQuotes ?? []) {
    try {
      const key = pair.symbol + ":" + canonical(pair.amount);
      if (!symbols.includes(pair.symbol) || !amounts.includes(canonical(pair.amount)) || seen.has(key)) continue;
      const instrument = report.instruments?.find(row => row.symbol === pair.symbol);
      if (!instrument || instrument.contractAddress !== pair.contractAddress || instrument.statusSource?.payload?.data?.marketStatus !== "regular"
        || report.market?.payload?.data?.marketStatus !== "regular" || report.market?.payload?.data?.openState !== true || pair.regularSessionEligible !== true) continue;
      if (pair.buyRequest?.fromToken !== usdt || pair.buyRequest?.toToken !== pair.contractAddress || pair.sellRequest?.fromToken !== pair.contractAddress || pair.sellRequest?.toToken !== usdt
        || pair.buyRequest?.binanceChainId !== "56" || pair.sellRequest?.binanceChainId !== "56") continue;
      if (pair.buyResponse?.fromCoinSymbol !== "USDT" || pair.buyResponse?.toCoinSymbol !== instrument.tokenSymbol
        || pair.sellResponse?.fromCoinSymbol !== instrument.tokenSymbol || pair.sellResponse?.toCoinSymbol !== "USDT") continue;
      if (![pair.buyRequest.fromTokenQty, pair.buyResponse.fromCoinAmount].every(v => canonical(v) === canonical(pair.amount))) continue;
      if (![pair.sellRequest.fromTokenQty, pair.sellResponse.fromCoinAmount].every(v => canonical(v) === canonical(pair.buyResponse.toCoinAmount))) continue;
      if (canonical(pair.returnedUsdt) !== canonical(pair.sellResponse.toCoinAmount)) continue;
      const from = Date.parse(pair.startedAt), to = Date.parse(pair.endedAt);
      if (!(from >= start && to >= from && to - from <= 30000 && to < start + 1200000)) continue;
      const loss = (1 - Number(pair.returnedUsdt) / Number(pair.amount)) * 100;
      if (!Number.isFinite(loss) || Math.abs(loss - pair.quotedRoundTripPct) > 1e-10) continue;
      seen.add(key); valid.push({ ...pair, scheduledSlot: slot.id });
    } catch { /* Invalid evidence remains in the raw report, never counts as a valid sample. */ }
  }
  return valid;
}

async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function atomicJson(path, value) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

export async function summarizeScheduledRfq(directory, nowMs = Date.now()) {
  const rows = [];
  for (const slot of RFQ_SCHEDULE) {
    const location = resolve(directory, "slots", slot.id);
    let receipt, raw;
    try { receipt = await json(resolve(location, "receipt.json")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    try { raw = await readFile(resolve(location, "quote-report.json"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const report = raw ? JSON.parse(raw) : null;
    const valid = report && receipt?.quoteReportHash === sha(raw) ? qualifyingRfqPairs(report, slot) : [];
    rows.push({ ...slot, status: receipt?.status ?? (nowMs >= Date.parse(slot.at) + 600000 ? "MISSED_WINDOW" : "PENDING"), qualifyingPairs: valid.length,
      missing: symbols.flatMap(symbol => amounts.map(amount => ({ symbol, amount }))).filter(target => !valid.some(p => p.symbol === target.symbol && canonical(p.amount) === target.amount)), quoteReportHash: raw ? sha(raw) : null });
  }
  const count = rows.reduce((n, row) => n + row.qualifyingPairs, 0);
  const result = { generatedAt: new Date(nowMs).toISOString(), status: count === 216 ? "QUOTE_COVERAGE_COMPLETE_COST_REVIEW_REQUIRED" : "INCOMPLETE_WITHHOLD",
    requiredPairs: 216, qualifyingPairs: count, slots: rows, currentUserGasDebitVerified: false, automaticTradingEligible: false };
  await atomicJson(resolve(directory, "progress.json"), result);
  return result;
}

export async function runScheduledRfq({ directory, releaseDirectory, phase, nowMs = Date.now(), collect }) {
  const slot = dueRfqSlot(nowMs, phase);
  if (!slot) return { status: "OUTSIDE_WINDOW_NO_WALLET_CALL", phase };
  const manifest = await json(resolve(releaseDirectory, "release.json"));
  if (manifest.schemaVersion !== 1 || manifest.kind !== "FINITE_TURTLE_RFQ_READ_ONLY" || manifest.scheduleHash !== sha(JSON.stringify(RFQ_SCHEDULE))
    || JSON.stringify(Object.keys(manifest.sources ?? {}).sort()) !== JSON.stringify([...releaseFiles].sort())) throw new Error("Invalid frozen research manifest");
  for (const [file, expected] of Object.entries(manifest.sources)) {
    if (!/^(scripts|src)\/[a-z0-9-]+\.mjs$/.test(file) || sha(await readFile(resolve(releaseDirectory, file))) !== expected) throw new Error("Frozen research source changed");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = resolve(directory, "runner.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") return { status: "RESEARCH_RUN_ALREADY_LOCKED" }; throw error; }
  try {
    const location = resolve(directory, "slots", slot.id);
    await mkdir(location, { recursive: true, mode: 0o700 });
    try { await writeFile(resolve(location, "claim.json"), JSON.stringify({ slot, claimedAt: new Date(nowMs).toISOString() }), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code === "EEXIST") return { status: "SLOT_ALREADY_CLAIMED_NO_REPEAT", slot: slot.id }; throw error; }
    let receipt;
    try {
      const report = await collect(location, { slotAt: slot.at }), raw = await readFile(resolve(location, "quote-report.json"), "utf8");
      const pairs = qualifyingRfqPairs(report, slot);
      receipt = { slot: slot.id, completedAt: new Date().toISOString(), status: pairs.length === 24 ? "COLLECTED_24" : "PARTIAL_OR_BLOCKED", qualifyingPairs: pairs.length, quoteReportHash: sha(raw), automaticTradingEligible: false };
    } catch (error) { receipt = { slot: slot.id, completedAt: new Date().toISOString(), status: "FAILED_WITHOUT_BACKFILL", error: error.message, automaticTradingEligible: false }; }
    await writeFile(resolve(location, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
    const progress = await summarizeScheduledRfq(directory);
    return { ...receipt, totalQualifyingPairs: progress.qualifyingPairs, needsFinalResearchReport: slot.id === RFQ_SCHEDULE.at(-1).id };
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const releaseDirectory = resolve(import.meta.dirname, "..");
  const manifest = await json(resolve(releaseDirectory, "release.json"));
  if (process.argv[2] === "--status") {
    console.log(JSON.stringify(await summarizeScheduledRfq(manifest.stateDirectory)));
  } else {
    const { collectServerTurtleRfq } = await import("./research-turtle-rfq-server.mjs");
    console.log(JSON.stringify(await runScheduledRfq({ directory: manifest.stateDirectory, releaseDirectory, phase: process.argv[2], collect: collectServerTurtleRfq })));
  }
}
