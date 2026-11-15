import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RFQ_QUOTE_WINDOW_MS, RFQ_SCHEDULE, RFQ_SLOT_TIMEOUT_MS, dueRfqSlot, qualifyingRfqPairs, runScheduledRfq, summarizeScheduledRfq } from "../scripts/scheduled-turtle-rfq.mjs";

async function releaseFixture(directory) {
  await mkdir(join(directory, "scripts"), { recursive: true });
  await mkdir(join(directory, "src"), { recursive: true });
  const names = ["scripts/scheduled-turtle-rfq.mjs", "scripts/research-turtle-rfq-server.mjs", "scripts/research-turtle-rfq.mjs", "scripts/research-turtle-rfq-chain.mjs", "src/turtle-etf-universe.mjs"];
  for (const file of names) await writeFile(join(directory, file), "fixture");
  const sha = value => createHash("sha256").update(value).digest("hex");
  await writeFile(join(directory, "release.json"), JSON.stringify({ schemaVersion: 1, kind: "FINITE_TURTLE_RFQ_READ_ONLY", scheduleHash: sha(JSON.stringify(RFQ_SCHEDULE)), sources: Object.fromEntries(names.map(file => [file, sha("fixture")])) }));
}

test("nine exact slots map to three NY trading dates and Beijing start/end", () => {
  assert.equal(RFQ_SCHEDULE.length, 9);
  assert.equal(new Set(RFQ_SCHEDULE.map(s => s.sessionDate)).size, 3);
  assert.equal(Date.parse(RFQ_SCHEDULE[0].at), Date.parse("2026-11-16T22:45:00+08:00"));
  assert.equal(Date.parse(RFQ_SCHEDULE.at(-1).at), Date.parse("2026-11-19T04:30:00+08:00"));
  for (const slot of RFQ_SCHEDULE) {
    assert.equal(dueRfqSlot(Date.parse(slot.at), slot.phase).id, slot.id);
    assert.equal(dueRfqSlot(Date.parse(slot.at) - 1, slot.phase), null);
    assert.equal(dueRfqSlot(Date.parse(slot.at) + 600000, slot.phase), null);
  }
});

test("outside a finite slot performs no collector or wallet operation", async () => {
  const result = await runScheduledRfq({ phase: "open", nowMs: Date.parse("2026-11-15T12:00Z"), collect: () => { throw new Error("Must not collect"); } });
  assert.equal(result.status, "OUTSIDE_WINDOW_NO_WALLET_CALL");
});

test("remote wallet boundary rejects delayed first calls and any call after completion deadline", async () => {
  const { assertRfqExecutionTime } = await import("../scripts/research-turtle-rfq-server.mjs");
  const slot = RFQ_SCHEDULE[0], start = Date.parse(slot.at);
  assert.equal(typeof assertRfqExecutionTime, "function");
  assert.doesNotThrow(() => assertRfqExecutionTime(slot.at, true, start + 599999));
  assert.throws(() => assertRfqExecutionTime(slot.at, true, start + 600000), /window/);
  assert.doesNotThrow(() => assertRfqExecutionTime(slot.at, false, start + 600000));
  assert.throws(() => assertRfqExecutionTime(slot.at, false, start + 1200000), /window/);
  assert.throws(() => assertRfqExecutionTime(slot.at, true, start - 1), /window/);
});

test("concurrent status summaries use separate temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scheduled-rfq-"));
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => summarizeScheduledRfq(directory)));
    assert.equal(results.length, 12);
    assert.equal(JSON.parse(await readFile(join(directory, "progress.json"))).requiredPairs, 216);
  } finally { await rm(directory, { recursive: true }); }
});

test("a claimed failed slot is immutable and a duplicate run cannot collect again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scheduled-rfq-"));
  try {
    const release = join(directory, "release"); await releaseFixture(release);
    let calls = 0;
    const options = { directory: join(directory, "state"), releaseDirectory: release, phase: "open", nowMs: Date.parse(RFQ_SCHEDULE[0].at), collect: async () => { calls++; throw new Error("SOURCE_UNAVAILABLE"); } };
    assert.equal((await runScheduledRfq(options)).status, "FAILED_WITHOUT_BACKFILL");
    assert.equal((await runScheduledRfq(options)).status, "SLOT_ALREADY_CLAIMED_NO_REPEAT");
    assert.equal(calls, 1);
    const progress = JSON.parse(await readFile(join(options.directory, "progress.json")));
    assert.equal(progress.qualifyingPairs, 0);
    assert.equal(progress.automaticTradingEligible, false);
  } finally { await rm(directory, { recursive: true }); }
});

test("a changed frozen module blocks the collector before any wallet operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scheduled-rfq-"));
  try {
    await releaseFixture(directory);
    await writeFile(join(directory, "scripts/research-turtle-rfq.mjs"), "changed");
    await assert.rejects(() => runScheduledRfq({ directory: join(directory, "state"), releaseDirectory: directory, phase: "open", nowMs: Date.parse(RFQ_SCHEDULE[0].at), collect: async () => { throw new Error("Must not collect"); } }), /source changed/);
  } finally { await rm(directory, { recursive: true }); }
});

test("credits 24 exact regular-session pairs once, rejecting stale times and wrong reverse quantities", () => {
  const slot = RFQ_SCHEDULE[0], usdt = "0x55d398326f99059fF775485246999027B3197955";
  const instruments = ["SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "GLD", "DBC"].map((symbol, i) => ({ symbol, tokenSymbol: symbol + "on", contractAddress: "0x" + String(i + 1).padStart(40, "0"), statusSource: { payload: { data: { marketStatus: "regular" } } } }));
  const pairedQuotes = instruments.flatMap(a => ["50", "217.66", "250"].map(amount => ({ symbol: a.symbol, amount, contractAddress: a.contractAddress, regularSessionEligible: true,
    buyRequest: { fromToken: usdt, toToken: a.contractAddress, fromTokenQty: amount, binanceChainId: "56" }, sellRequest: { fromToken: a.contractAddress, toToken: usdt, fromTokenQty: "0.10", binanceChainId: "56" },
    buyResponse: { fromCoinSymbol: "USDT", toCoinSymbol: a.tokenSymbol, fromCoinAmount: amount, toCoinAmount: "0.1" }, sellResponse: { fromCoinSymbol: a.tokenSymbol, toCoinSymbol: "USDT", fromCoinAmount: "0.1", toCoinAmount: amount }, returnedUsdt: amount, quotedRoundTripPct: 0, startedAt: slot.at, endedAt: new Date(Date.parse(slot.at) + 2000).toISOString() })));
  const report = { walletStatus: "CONNECTED", context: { scope: "EXACT_RUNNING_BOT_CONTEXT" }, protection: { protectedFingerprintUnchanged: true, servicePidsUnchanged: true }, at: slot.at, market: { payload: { data: { marketStatus: "regular", openState: true } } }, instruments, pairedQuotes };
  assert.equal(qualifyingRfqPairs(report, slot).length, 24);
  report.pairedQuotes.push(report.pairedQuotes[0]);
  assert.equal(qualifyingRfqPairs(report, slot).length, 24);
  report.collectorProcess = { exitedSuccessfully: false };
  assert.equal(qualifyingRfqPairs(report, slot).length, 0);
  delete report.collectorProcess;
  report.pairedQuotes[1].sellRequest.fromTokenQty = "9";
  assert.equal(qualifyingRfqPairs(report, slot).length, 23);
  report.at = new Date(Date.parse(slot.at) - 1000).toISOString();
  assert.equal(qualifyingRfqPairs(report, slot).length, 0);
});

function savedQuoteReport(slot) {
  const usdt = "0x55d398326f99059fF775485246999027B3197955";
  const instrument = { symbol: "SPY", tokenSymbol: "SPYon", contractAddress: "0x" + "1".padStart(40, "0"), statusSource: { payload: { data: { marketStatus: "regular" } } } };
  const amount = "50";
  return { mode: "READ_ONLY", walletStatus: "CONNECTED", context: { scope: "EXACT_RUNNING_BOT_CONTEXT" }, protection: { protectedFingerprintUnchanged: true, servicePidsUnchanged: true }, at: slot.at, market: { payload: { data: { marketStatus: "regular", openState: true } } }, instruments: [instrument], collectorProcess: { exitedSuccessfully: true, exitCode: 0 }, pairedQuotes: [{ symbol: "SPY", amount, contractAddress: instrument.contractAddress, regularSessionEligible: true, buyRequest: { fromToken: usdt, toToken: instrument.contractAddress, fromTokenQty: amount, binanceChainId: "56" }, sellRequest: { fromToken: instrument.contractAddress, toToken: usdt, fromTokenQty: "0.10", binanceChainId: "56" }, buyResponse: { fromCoinSymbol: "USDT", toCoinSymbol: "SPYon", fromCoinAmount: amount, toCoinAmount: "0.1" }, sellResponse: { fromCoinSymbol: "SPYon", toCoinSymbol: "USDT", fromCoinAmount: "0.1", toCoinAmount: amount }, returnedUsdt: amount, quotedRoundTripPct: 0, startedAt: slot.at, endedAt: new Date(Date.parse(slot.at) + 2000).toISOString() }] };
}

test("quote collection is allowed through the 20 minute validity window", () => {
  assert.equal(RFQ_QUOTE_WINDOW_MS, 1_200_000);
  assert.ok(RFQ_SLOT_TIMEOUT_MS > RFQ_QUOTE_WINDOW_MS);
});

test("a saved quote report without a receipt is sealed once and is not collected again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scheduled-rfq-"));
  try {
    const release = join(directory, "release"); await releaseFixture(release);
    const slot = RFQ_SCHEDULE[0];
    const location = join(directory, "state", "slots", slot.id);
    await mkdir(location, { recursive: true });
    await writeFile(join(location, "claim.json"), JSON.stringify({ slot }));
    await writeFile(join(location, "quote-report.json"), JSON.stringify(savedQuoteReport(slot), null, 2));
    let calls = 0;
    const options = { directory: join(directory, "state"), releaseDirectory: release, phase: "open", nowMs: Date.parse(slot.at), collect: async () => { calls++; throw new Error("Must not collect"); } };
    const sealed = await runScheduledRfq(options);
    assert.equal(sealed.status, "PARTIAL_OR_BLOCKED");
    assert.equal(sealed.qualifyingPairs, 1);
    assert.equal(sealed.sealedFromSavedReport, true);
    assert.equal((await runScheduledRfq(options)).status, "SLOT_ALREADY_CLAIMED_NO_REPEAT");
    assert.equal(calls, 0);
    assert.equal(JSON.parse(await readFile(join(options.directory, "progress.json"))).qualifyingPairs, 1);
  } finally { await rm(directory, { recursive: true }); }
});

test("an offhours response is never credited to a scheduled regular slot", () => {
  assert.deepEqual(qualifyingRfqPairs({ walletStatus: "CONNECTED", context: { scope: "EXACT_RUNNING_BOT_CONTEXT" }, protection: { protectedFingerprintUnchanged: true, servicePidsUnchanged: true }, at: RFQ_SCHEDULE[0].at, pairedQuotes: [{ symbol: "SPY", amount: "50", regularSessionEligible: false }] }, RFQ_SCHEDULE[0]), []);
});
