import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { RFQ_QUOTE_WINDOW_MS, RFQ_SCHEDULE, RFQ_SLOT_TIMEOUT_MS, qualifyingRfqPairs } from "../scripts/scheduled-turtle-rfq.mjs";
const load = () => import("../scripts/server-turtle-rfq.mjs");
const sha = v => createHash("sha256").update(v).digest("hex");

test("nonzero collectors preserve their valid diagnostic JSON but never gain sample eligibility", async () => {
  const { parseRfqCollectorOutput } = await import("../scripts/research-turtle-rfq-server.mjs");
  const source = { mode: "READ_ONLY", pairedQuotes: [{ symbol: "SPY" }], protection: { protectedFingerprintUnchanged: false } };
  const report = parseRfqCollectorOutput({ code: 1 }, JSON.stringify(source));
  assert.deepEqual(report.pairedQuotes, source.pairedQuotes);
  assert.equal(report.collectorProcess.exitedSuccessfully, false);
  assert.deepEqual(qualifyingRfqPairs(report, RFQ_SCHEDULE[0]), []);
  assert.throws(() => parseRfqCollectorOutput({ code: 1 }, ""), /failed/);
});

test("partial even-sized quote groups report the statistical median, not the upper middle sample", async () => {
  const { rfqCostStatistics } = await load();
  const even = rfqCostStatistics([{ symbol: "SPY", amount: "50", losses: [3, 1] }])[0];
  assert.equal(even.medianPct, 2); assert.equal(even.p90Pct, 3); assert.equal(even.worstPct, 3);
  assert.equal(rfqCostStatistics([{ symbol: "SPY", amount: "50", losses: [3, 1, 2] }])[0].medianPct, 2);
});

test("native quote source parses without SSH and the extra fee queries cannot expand to writes", async () => {
  const { buildServerTurtleRfqSource, isRfqFeeRead } = await import("../scripts/research-turtle-rfq-server.mjs");
  assert.equal(typeof buildServerTurtleRfqSource, "function");
  assert.equal(isRfqFeeRead(["wallet", "address"]), true);
  assert.equal(isRfqFeeRead(["wallet", "tx-history", "--tx", "0x" + "a".repeat(64), "--binanceChainId", "56"]), true);
  for (const args of [["wallet", "send"], ["auth", "signin"], ["wallet", "tx-history"], ["wallet", "tx-history", "--tx", "bad", "--binanceChainId", "56"], ["market-order", "swap"]]) assert.equal(isRfqFeeRead(args), false);
  const directory = await mkdtemp(join(tmpdir(), "native-source-"));
  try {
    const source = await buildServerTurtleRfqSource({ slotAt: RFQ_SCHEDULE[0].at, feeEvidence: true });
    assert.ok(!source.includes("/Users/henry")); assert.ok(!source.includes("execFile(\"ssh\""));
    const file = join(directory, "source.mjs"); await writeFile(file, source);
    execFileSync(process.execPath, ["--check", file]);
  } finally { await rm(directory, { recursive: true }); }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "native-turtle-"));
  const releaseDirectory = join(directory, "release"), stateDirectory = join(directory, "state");
  await mkdir(releaseDirectory); await mkdir(stateDirectory);
  const baseline = "# 八 ETF 研究\n\n原210组回测保留，WITHHOLD。\n";
  const reportPath = join(directory, "report.md");
  await writeFile(reportPath, baseline); await writeFile(join(releaseDirectory, "baseline.md"), baseline);
  const manifest = { stateDirectory, reportPath, reportBaselineHash: sha(baseline) };
  return { directory, releaseDirectory, stateDirectory, reportPath, manifest, baseline };
}

test("native runner never invokes collection outside the original nine windows", async () => {
  const { runNativeSlot } = await load();
  const result = await runNativeSlot({ phase: "open", nowMs: Date.parse("2026-11-15T15:00Z"), collect: () => { throw Error("No call"); } });
  assert.equal(result.status, "OUTSIDE_WINDOW_NO_WALLET_CALL");
});

test("native failed claim survives process replacement without a stale global lock", async () => {
  const { runNativeSlot } = await load(), f = await fixture();
  try {
    let calls = 0;
    const options = { manifest: f.manifest, phase: "open", nowMs: Date.parse(RFQ_SCHEDULE[0].at), collect: async (_, options) => { calls++; assert.equal(options.local, true); assert.equal(options.feeEvidence, true); throw Error("SOURCE_UNAVAILABLE"); } };
    assert.equal((await runNativeSlot(options)).status, "FAILED_WITHOUT_BACKFILL");
    assert.equal((await runNativeSlot(options)).status, "SLOT_ALREADY_CLAIMED_NO_REPEAT");
    assert.equal(calls, 1);
    await assert.rejects(readFile(join(f.stateDirectory, "runner.lock")), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true }); }
});

test("finalizer seals a saved quote report that never received a receipt", async () => {
  const { finalizeNativeReport } = await load(), f = await fixture();
  try {
    const slot = RFQ_SCHEDULE[0];
    const location = join(f.stateDirectory, "slots", slot.id);
    await mkdir(location, { recursive: true });
    const usdt = "0x55d398326f99059fF775485246999027B3197955";
    const instrument = { symbol: "SPY", tokenSymbol: "SPYon", contractAddress: "0x" + "1".padStart(40, "0"), statusSource: { payload: { data: { marketStatus: "regular" } } } };
    const report = { walletStatus: "CONNECTED", context: { scope: "EXACT_RUNNING_BOT_CONTEXT" }, protection: { protectedFingerprintUnchanged: true, servicePidsUnchanged: true }, at: slot.at, market: { payload: { data: { marketStatus: "regular", openState: true } } }, instruments: [instrument], collectorProcess: { exitedSuccessfully: true, exitCode: 0 }, pairedQuotes: [{ symbol: "SPY", amount: "50", contractAddress: instrument.contractAddress, regularSessionEligible: true, buyRequest: { fromToken: usdt, toToken: instrument.contractAddress, fromTokenQty: "50", binanceChainId: "56" }, sellRequest: { fromToken: instrument.contractAddress, toToken: usdt, fromTokenQty: "0.10", binanceChainId: "56" }, buyResponse: { fromCoinSymbol: "USDT", toCoinSymbol: "SPYon", fromCoinAmount: "50", toCoinAmount: "0.1" }, sellResponse: { fromCoinSymbol: "SPYon", toCoinSymbol: "USDT", fromCoinAmount: "0.1", toCoinAmount: "50" }, returnedUsdt: "50", quotedRoundTripPct: 0, startedAt: slot.at, endedAt: new Date(Date.parse(slot.at) + 2000).toISOString() }] };
    await writeFile(join(location, "quote-report.json"), JSON.stringify(report, null, 2));
    const result = await finalizeNativeReport({ ...f, nowMs: Date.parse("2026-11-18T20:55:00Z") });
    assert.equal(result.qualifyingPairs, 1);
    assert.equal(result.missingPairs, 215);
    const receipt = JSON.parse(await readFile(join(location, "receipt.json"), "utf8"));
    assert.equal(receipt.sealedFromSavedReport, true);
    assert.equal(receipt.qualifyingPairs, 1);
  } finally { await rm(f.directory, { recursive: true }); }
});

test("finalizer cannot run early or use a wallet, then reports missing coverage and preserves baseline", async () => {
  const { finalizeNativeReport } = await load(), f = await fixture();
  try {
    await assert.rejects(finalizeNativeReport({ ...f, nowMs: Date.parse(RFQ_SCHEDULE.at(-1).at) }), /not ended/);
    const options = { ...f, nowMs: Date.parse("2026-11-18T20:55:00Z") };
    const first = await finalizeNativeReport(options);
    assert.equal(first.qualifyingPairs, 0); assert.equal(first.missingPairs, 216);
    assert.equal(first.status, "WITHHOLD"); assert.equal(first.currentUserGasDebitVerified, false);
    assert.equal(first.automaticTradingEligible, false);
    const report = await readFile(f.reportPath, "utf8");
    assert.ok(report.includes("0/216")); assert.ok(report.includes(f.baseline));
    assert.ok(report.includes("UNKNOWN"));
    const second = await finalizeNativeReport(options);
    assert.deepEqual(second, first); assert.equal(await readFile(f.reportPath, "utf8"), report);
  } finally { await rm(f.directory, { recursive: true }); }
});

test("report publication cannot overwrite someone else's later research edits", async () => {
  const { finalizeNativeReport } = await load(), f = await fixture();
  try {
    await writeFile(f.reportPath, "Another author's updated report");
    const result = await finalizeNativeReport({ ...f, nowMs: Date.parse("2026-11-18T20:55:00Z") });
    assert.equal(result.publication.status, "CONFLICT_PRESERVED");
    assert.equal(await readFile(f.reportPath, "utf8"), "Another author's updated report");
    assert.ok((await readFile(join(f.stateDirectory, "report.md"), "utf8")).includes("0/216"));
  } finally { await rm(f.directory, { recursive: true }); }
});

test("native collection is not killed before the quote window and receipt write", async () => {
  const { RFQ_QUOTE_WINDOW_MS: quoteWindow } = await import("../scripts/research-turtle-rfq-server.mjs");
  assert.equal(quoteWindow, RFQ_QUOTE_WINDOW_MS);
  assert.equal(RFQ_QUOTE_WINDOW_MS, 1_200_000);
  assert.equal(RFQ_SLOT_TIMEOUT_MS, 1_320_000);
});

test("server timers pin three absolute UTC dates, do not catch up quotes, and finalize independently", async () => {
  const { nativeTimerUnits } = await load();
  const units = nativeTimerUnits();
  assert.equal(Object.keys(units).filter(k => k.endsWith(".timer")).length, 4);
  for (const phase of ["open", "mid", "close"]) {
    const timer = units[`binance-turtle-rfq-20261116-${phase}.timer`];
    for (const slot of RFQ_SCHEDULE.filter(s => s.phase === phase)) assert.ok(timer.includes(slot.at.replace("T", " ").replace(".000Z", " UTC")));
    assert.ok(timer.includes("Persistent=false"));
  }
  assert.ok(units["binance-turtle-rfq-20261116-final.timer"].includes("2026-11-18 20:55:00 UTC"));
  assert.ok(units["binance-turtle-rfq-20261116-final.timer"].includes("Persistent=true"));
  for (const phase of ["open", "mid", "close", "final"]) assert.match(units[`binance-turtle-rfq-20261116-${phase}.service`], /TimeoutStartSec=23min/);
  assert.ok(!Object.values(units).join().includes("TimeoutStartSec=12min"));
  assert.ok(!Object.values(units).join().includes("/Users/henry"));
  assert.ok(!Object.values(units).join().includes("restart binance-agentic"));
});
