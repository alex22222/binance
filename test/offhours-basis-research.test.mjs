import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildOffhoursBasisObservation, pairOffhoursBasisObservations, summarizeOffhoursBasisResearch } from "../src/offhours-basis-research.mjs";
import { assertOffhoursCodeUnchanged, collectOffhoursBasisResearch, loadOffhoursBasisHistory, offhoursPublicFetch, runOffhoursBasisResearch } from "../scripts/run-offhours-basis-research.mjs";
import { researchTradingDates } from "../src/weekly-research-calendar.mjs";
import { newYorkSessionBounds } from "../src/strategy-data.mjs";

const offAt = "2026-09-28T23:00:00.000Z";
const regularAt = "2026-09-29T13:30:03.000Z";
const instrument = { ticker: "SPY", symbol: "SPYon", chainId: "56", contractAddress: `0x${"1".repeat(40)}`, multiplier: "1.01", type: 1 };

// Explicit supplied evidence contract; no fixture is a real market observation.
function input(at = offAt, regular = false, asset = instrument) {
  return {
    ticker: asset.ticker, instrument: asset, observedAt: at, discoveredAt: at,
    dynamicIdentity: asset, dynamicRetrievedAt: at,
    rwaDynamic: { ticker: asset.ticker, symbol: asset.symbol, tokenInfo: { sharesMultiplier: asset.multiplier, price: "99999" } },
    assetStatus: { openState: true, reasonCode: "TRADING", marketStatus: regular ? "regular" : "overnight" },
    statusRetrievedAt: at, marketStatus: { openState: true, reasonCode: "TRADING" }, marketRetrievedAt: at,
    companyAction: { ticker: asset.ticker, status: "CLEAR", source: "FIXTURE_CALENDAR", checkedAt: at },
    tradeUsdt: 50,
    buyQuote: { instrument: asset, source: "FIXTURE_AMOUNT_QUOTE", requestedInputUsdt: 50, outputToken: regular ? 0.495 : 0.5, quotedAt: at },
    sellQuote: { instrument: asset, source: "FIXTURE_AMOUNT_QUOTE", requestedInputToken: regular ? 0.495 : 0.5, outputUsdt: 49.9, quotedAt: at },
    reference: {
      kind: "TRUSTED_FAIR_UNDERLYING", trusted: true, ticker: asset.ticker,
      fairUnderlyingPrice: 100, unit: "USDT_PER_UNDERLYING_SHARE", source: "FIXTURE_REFERENCE", methodology: "Explicit externally normalized ETF fair share value",
      observedAt: at, retrievedAt: at,
      futures: { root: asset.ticker === "SPY" ? "ES" : "NQ", contract: "FIXTURE_DEC26", price: 6000, source: "FIXTURE_FUTURES", observedAt: at, expiresAt: "2026-12-18T14:30:00Z" },
      assumptions: { roll: "December contract, no roll", carry: "Supplied financing adjustment", dividend: "Supplied dividend adjustment", etfMapping: "Explicit index-to-ETF mapping", currency: "Explicit USD/USDT parity assumption" }
    },
    nextSession: { source: "FIXTURE_CALENDAR", knownAt: at, previousCloseAt: "2026-09-28T20:00:00Z", openAt: "2026-09-29T13:30:00Z", closeAt: "2026-09-29T20:00:00Z" },
    estimatedRoundTripGasUsdt: 0.01, executionBufferPct: 0.02
  };
}

const observation = (...args) => buildOffhoursBasisObservation(input(...args));

test("F observations use amount quotes and a multiplied trusted ETF reference, never oracle price", () => {
  const result = observation();
  assert.equal(result.status, "COMPARABLE");
  assert.equal(result.evidenceLabel, "QUOTE_SHADOW");
  assert.equal(result.basis.theoreticalPrice, 101);
  assert.equal(result.basis.execution.buy.unitPriceUsdt, 100);
  assert.equal(result.basis.execution.buy.source, "FIXTURE_AMOUNT_QUOTE");
  assert.equal(result.automaticTradingEligible, false);
  assert.equal(result.basis.eligibleForShadowSignal, false);
  assert.deepEqual(result, observation());
  assert.equal(observation(regularAt, true).status, "COMPARABLE", "nonpositive edge must not select out valid data");
});

test("F missing quote, reference and costs remain unavailable, never zero-cost or executable oracle", () => {
  const data = input();
  delete data.buyQuote; delete data.sellQuote; delete data.reference;
  delete data.estimatedRoundTripGasUsdt; delete data.executionBufferPct;
  const result = buildOffhoursBasisObservation(data);
  assert.equal(result.status, "NO_QUOTE");
  assert.equal(result.evidenceLabel, "OBSERVATION_ONLY");
  assert.ok(result.vetoReasons.includes("BUY_QUOTE_UNAVAILABLE"));
  assert.ok(result.vetoReasons.includes("REFERENCE_UNAVAILABLE"));
  assert.equal(result.basis.execution.buy.unitPriceUsdt, null);
  assert.equal(result.basis.theoreticalPrice, null);
  assert.equal(result.basis.allInCostPct, null);
  const quoted = input(); delete quoted.estimatedRoundTripGasUsdt;
  assert.equal(buildOffhoursBasisObservation(quoted).basis.allInCostPct, null);
});

test("F real global regular/null reason is normal, but paused globals and non-TRADING assets still veto", () => {
  const data = input(regularAt, true);
  data.marketStatus = { marketStatus: "regular", openState: true, reasonCode: null, reasonMsg: null };
  assert.equal(buildOffhoursBasisObservation(data).status, "COMPARABLE");
  for (const reasonCode of ["MARKET_PAUSED", "MARKET_MAINTENANCE", undefined]) {
    data.marketStatus.reasonCode = reasonCode;
    assert.ok(buildOffhoursBasisObservation(data).vetoReasons.includes("MARKET_NOT_TRADING"));
  }
  data.marketStatus.reasonCode = null;
  data.assetStatus.reasonCode = null;
  assert.ok(buildOffhoursBasisObservation(data).vetoReasons.includes("ASSET_NOT_TRADING"));
});

test("F code verdict refuses a changed or incomplete loaded-code hash manifest", () => {
  const hashes = { "src/offhours-basis-research.mjs": "abc", "src/executable-basis.mjs": "def" };
  assert.doesNotThrow(() => assertOffhoursCodeUnchanged(hashes, { ...hashes }));
  assert.throws(() => assertOffhoursCodeUnchanged(hashes, { ...hashes, "src/executable-basis.mjs": "changed" }), /CODE_CHANGED_DURING_RUN/);
  assert.throws(() => assertOffhoursCodeUnchanged(hashes, {}), /CODE_CHANGED_DURING_RUN/);
});

test("F fails closed on exact identity, time, amount, market, company action and multiplier errors", () => {
  const cases = [
    [d => { d.buyQuote.instrument = { ...instrument, chainId: "1" }; }, "BUY_QUOTE_IDENTITY_MISMATCH"],
    [d => { d.sellQuote.instrument = { ...instrument, contractAddress: `0x${"2".repeat(40)}` }; }, "SELL_QUOTE_IDENTITY_MISMATCH"],
    [d => { d.dynamicIdentity = { ...instrument, ticker: "QQQ" }; }, "DYNAMIC_IDENTITY_MISMATCH"],
    [d => { d.rwaDynamic.ticker = "QQQ"; }, "DYNAMIC_IDENTITY_MISMATCH"],
    [d => { d.rwaDynamic.tokenInfo.sharesMultiplier = 2; }, "MULTIPLIER_MISMATCH"],
    [d => { d.rwaDynamic.tokenInfo.sharesMultiplier = null; }, "INVALID_MULTIPLIER"],
    [d => { d.buyQuote.requestedInputUsdt = 49; }, "BUY_QUOTE_AMOUNT_MISMATCH"],
    [d => { d.sellQuote.requestedInputToken = 0.4; }, "SELL_QUOTE_AMOUNT_MISMATCH"],
    [d => { d.buyQuote.quotedAt = "2026-09-28T22:59:00Z"; }, "BUY_QUOTE_STALE"],
    [d => { d.sellQuote.quotedAt = "2026-09-28T23:00:01Z"; }, "SELL_QUOTE_TIME_INVALID"],
    [d => { d.statusRetrievedAt = "2026-09-28T22:00:00Z"; }, "MARKET_STATUS_STALE_OR_INVALID"],
    [d => { d.dynamicRetrievedAt = "2026-09-28T22:00:00Z"; }, "MULTIPLIER_STALE_OR_INVALID"],
    [d => { d.assetStatus.reasonCode = "ASSET_LIMITED"; }, "ASSET_NOT_TRADING"],
    [d => { d.marketStatus.openState = false; }, "MARKET_NOT_TRADING"],
    [d => { d.companyAction.status = "BLOCKED"; }, "COMPANY_ACTION_UNRESOLVED"],
    [d => { d.companyAction.ticker = "QQQ"; }, "COMPANY_ACTION_UNRESOLVED"],
    [d => { d.companyAction.checkedAt = "2026-09-30T00:00:00Z"; }, "COMPANY_ACTION_STALE_OR_INVALID"]
  ];
  for (const [change, reason] of cases) {
    const data = input(); change(data);
    const result = buildOffhoursBasisObservation(data);
    assert.equal(result.status, "UNCOMPARABLE", reason);
    assert.ok(result.vetoReasons.includes(reason), `${reason}: ${result.vetoReasons}`);
    assert.equal(result.automaticTradingEligible, false);
  }
});

test("F rejects stale stock closes, raw futures index levels and incomplete normalization provenance", () => {
  for (const change of [
    d => { d.reference.kind = "STOCK_CLOSE"; },
    d => { d.reference.unit = "INDEX_POINTS"; },
    d => { d.reference.trusted = false; },
    d => { delete d.reference.methodology; },
    d => { delete d.reference.assumptions.dividend; },
    d => { delete d.reference.assumptions.etfMapping; },
    d => { d.reference.futures.expiresAt = "2026-09-01T00:00:00Z"; },
    d => { d.reference.futures.root = "NQ"; },
    d => { d.reference.observedAt = "2026-09-28T20:00:00Z"; },
    d => { d.reference.retrievedAt = regularAt; }
  ]) {
    const data = input(); change(data);
    const result = buildOffhoursBasisObservation(data);
    assert.equal(result.status, "UNCOMPARABLE");
    assert.equal(result.basis.theoreticalPrice, null);
  }
});

test("F latest valid off-hours pairs once to the first regular snapshot, with no lookahead", () => {
  const early = observation("2026-09-28T22:00:00Z");
  const off = observation(); const regular = observation(regularAt, true);
  const lateRegular = observation("2026-09-29T14:00:00Z", true);
  const rows = [lateRegular, off, regular, early, off, regular];
  const result = pairOffhoursBasisObservations(rows, { asOf: lateRegular.observedAt });
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].offhoursId, off.id);
  assert.equal(result.pairs[0].regularId, regular.id);
  assert.equal(result.pairs[0].overnightId, "SPY:2026-09-29");
  assert.equal(result.pairs[0].automaticTradingEligible, false);
  assert.deepEqual(pairOffhoursBasisObservations(rows, { asOf: offAt }).pairs, []);
  assert.deepEqual(result, pairOffhoursBasisObservations([...rows].reverse(), { asOf: lateRegular.observedAt }));
});

test("F cannot skip an invalid first regular snapshot or pair across repeated regular sessions", () => {
  const bad = input(regularAt, true); delete bad.buyQuote;
  const first = buildOffhoursBasisObservation(bad);
  const later = observation("2026-09-29T13:31:00Z", true);
  const nextDay = observation("2026-09-30T13:30:03Z", true);
  for (const rows of [[observation(), first, later, nextDay], [observation(), nextDay]]) {
    const result = pairOffhoursBasisObservations(rows, { asOf: nextDay.observedAt });
    assert.equal(result.pairs.length, 0);
    assert.equal(result.rejectedPairs.length, 1);
  }
});

test("F identity and multiplier changes veto convergence even when both snapshots independently pass", () => {
  for (const asset of [
    { ...instrument, contractAddress: `0x${"2".repeat(40)}` },
    { ...instrument, multiplier: "1.02" }
  ]) {
    const regular = observation(regularAt, true, asset);
    assert.equal(regular.status, "COMPARABLE");
    const result = pairOffhoursBasisObservations([observation(), regular], { asOf: regularAt });
    assert.equal(result.pairs.length, 0);
    assert.ok(result.rejectedPairs[0].vetoReasons.some(r => /IDENTITY_CHANGED|MULTIPLIER_CHANGED/.test(r)));
  }
});

test("F a future calendar, unavailable window, or delayed open sample cannot create a pair", () => {
  for (const change of [
    d => { delete d.nextSession; },
    d => { d.nextSession.knownAt = regularAt; },
    d => { d.nextSession.openAt = "2026-09-30T13:30:00Z"; }
  ]) {
    const data = input(); change(data);
    const result = pairOffhoursBasisObservations([buildOffhoursBasisObservation(data), observation(regularAt, true)], { asOf: regularAt });
    assert.equal(result.pairs.length, 0);
  }
  const late = observation("2026-09-29T14:30:00Z", true);
  assert.equal(pairOffhoursBasisObservations([observation(), late], { asOf: late.observedAt }).pairs.length, 0);
});

test("F exact next trading session handles holidays, DST and early closes without skipping an open day", () => {
  for (const [previousCloseAt, openAt, closeAt, expected] of [
    ["2026-09-04T20:00:00Z", "2026-09-08T13:30:00Z", "2026-09-08T20:00:00Z", 1],
    ["2026-10-30T20:00:00Z", "2026-11-02T14:30:00Z", "2026-11-02T21:00:00Z", 1],
    ["2026-11-27T18:00:00Z", "2026-11-30T14:30:00Z", "2026-11-30T21:00:00Z", 1],
    ["2026-09-11T20:00:00Z", "2026-09-15T13:30:00Z", "2026-09-15T20:00:00Z", 0]
  ]) {
    const at = new Date(Date.parse(previousCloseAt) + 3_600_000).toISOString();
    const off = input(at);
    off.nextSession = { previousCloseAt, openAt, closeAt, knownAt: at, source: "FIXTURE_CALENDAR" };
    const regular = observation(new Date(Date.parse(openAt) + 3_000).toISOString(), true);
    const result = pairOffhoursBasisObservations([buildOffhoursBasisObservation(off), regular], { asOf: regular.observedAt });
    assert.equal(result.pairs.length, expected, openAt);
  }
});

test("F eight weeks and thirty independent nights allow review only, neither condition alone suffices", () => {
  const dates = researchTradingDates("2026-07-01", "2026-09-29");
  const nights = dates.slice(0, -1).map((date, i) => {
    const previousCloseAt = new Date(newYorkSessionBounds(date).closeMs).toISOString();
    const at = new Date(Date.parse(previousCloseAt) + 3_600_000).toISOString();
    const next = newYorkSessionBounds(dates[i + 1]);
    const off = input(at);
    off.nextSession = { previousCloseAt, openAt: new Date(next.openMs).toISOString(), closeAt: new Date(next.closeMs).toISOString(), knownAt: at, source: "FIXTURE_CALENDAR" };
    return [buildOffhoursBasisObservation(off), observation(new Date(next.openMs + 3_000).toISOString(), true)];
  });
  const asOf = nights.at(-1).at(-1).observedAt;
  const early = summarizeOffhoursBasisResearch(nights.slice(0, 30).flat(), { asOf });
  assert.equal(early.independentOvernightSessions, 30);
  assert.equal(early.reviewEligible, false);
  const sparse = summarizeOffhoursBasisResearch([...nights.slice(0, 28), nights.at(-1)].flat(), { asOf });
  assert.ok(sparse.spanWeeks >= 8);
  assert.equal(sparse.reviewEligible, false);
  const eligible = summarizeOffhoursBasisResearch([...nights.slice(0, 29), nights.at(-1)].flat(), { asOf });
  assert.equal(eligible.independentOvernightSessions, 30);
  assert.equal(eligible.reviewEligible, true);
  assert.equal(eligible.decision, "REVIEW_ONLY");
  assert.equal(eligible.automaticTradingEligible, false);
});

test("F invalid newest quote does not discard the latest valid off-hours quote, but intervening identity changes veto", () => {
  const off = observation();
  const bad = input("2026-09-29T00:00:00Z"); delete bad.buyQuote;
  const regular = observation(regularAt, true);
  const rows = [off, buildOffhoursBasisObservation(bad), regular];
  assert.equal(pairOffhoursBasisObservations(rows, { asOf: regularAt }).pairs[0].offhoursId, off.id);
  bad.instrument = { ...instrument, contractAddress: `0x${"4".repeat(40)}` };
  const changed = pairOffhoursBasisObservations([off, buildOffhoursBasisObservation(bad), regular], { asOf: regularAt });
  assert.equal(changed.pairs.length, 0);
  assert.ok(changed.rejectedPairs[0].vetoReasons.includes("IDENTITY_CHANGED"));
});

test("F missing absolute quote timestamps and sub-float multiplier changes fail closed", () => {
  const data = input();
  data.buyQuote.quotedAt = "2026-09-28T23:00:00";
  assert.equal(buildOffhoursBasisObservation(data).status, "UNCOMPARABLE");
  const precise = { ...instrument, multiplier: "1.010000000000000001" };
  const changed = { ...instrument, multiplier: "1.010000000000000002" };
  const pairs = pairOffhoursBasisObservations([observation(offAt, false, precise), observation(regularAt, true, changed)], { asOf: regularAt });
  assert.equal(pairs.pairs.length, 0);
  assert.ok(pairs.rejectedPairs[0].vetoReasons.includes("MULTIPLIER_CHANGED"));
});

test("F summary separates unavailable observations and counts distinct ticker-overnight pairs and dates", () => {
  const missing = input(); delete missing.buyQuote;
  const incomparable = input(); delete incomparable.reference;
  const qqq = { ...instrument, ticker: "QQQ", symbol: "QQQon", contractAddress: `0x${"3".repeat(40)}` };
  const summary = summarizeOffhoursBasisResearch([
    observation(), observation(regularAt, true), observation(offAt, false, qqq), observation(regularAt, true, qqq),
    buildOffhoursBasisObservation(missing), buildOffhoursBasisObservation(incomparable)
  ], { asOf: regularAt });
  assert.equal(summary.validPairs, 2);
  assert.equal(summary.independentOvernightSessions, 1);
  assert.equal(summary.noQuote, 1);
  assert.equal(summary.uncomparable, 1);
  assert.equal(summary.observationOnly, 2);
  assert.equal(summary.reviewEligible, false);
  assert.equal(summary.automaticTradingEligible, false);
});

function publicFetch(calls = [], failure = false) {
  return async (url, options) => {
    calls.push(String(url));
    assert.equal(options.method, "GET");
    assert.equal(options.headers["User-Agent"], "binance-web3/1.1 (Skill)");
    assert.ok(String(url).startsWith("https://www.binance.com/bapi/defi/"));
    if (failure) throw new Error("fixture provider unavailable");
    const qqq = { ...instrument, ticker: "QQQ", symbol: "QQQon", contractAddress: `0x${"3".repeat(40)}` };
    const asset = String(url).includes(qqq.contractAddress) ? qqq : instrument;
    const data = String(url).includes("detail/list") ? [instrument, qqq]
      : String(url).includes("dynamic/ai") ? input(offAt, false, asset).rwaDynamic
        : String(url).includes("asset/market") ? input().assetStatus : input().marketStatus;
    return { ok: true, json: async () => ({ code: "000000", success: true, data }) };
  };
}

test("F default public transport uses bounded curl GET with skill headers, no retries or env override", async () => {
  const url = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=1";
  const response = await offhoursPublicFetch(url, { execFileImpl: async (command, args, options) => {
    assert.equal(command, "curl");
    assert.equal(args[args.indexOf("--request") + 1], "GET");
    assert.equal(args[args.indexOf("--max-time") + 1], "10");
    assert.ok(args.includes("User-Agent: binance-web3/1.1 (Skill)"));
    assert.ok(args.includes("Accept-Encoding: identity"));
    assert.equal(args.at(-1), url);
    assert.equal(options.timeout, 10_000);
    assert.equal(options.maxBuffer, 2 * 1024 * 1024);
    assert.equal(options.env, undefined);
    assert.ok(!args.includes("--retry"));
    return { stdout: '{"code":"000000","data":[],"success":true}' };
  } });
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { code: "000000", data: [], success: true });
  await assert.rejects(offhoursPublicFetch(url, { execFileImpl: async () => { throw new Error("curl timeout"); } }), /timeout/);
  await assert.rejects(offhoursPublicFetch(url, { execFileImpl: async () => ({ stdout: "not json" }) }), /JSON/);
  await assert.rejects(offhoursPublicFetch(url, { execFileImpl: async () => ({ stdout: "x".repeat(2 * 1024 * 1024 + 1) }) }), /2 MiB/);
});

test("F collector is offline injectable, public only, and defaults to no quote/reference", async () => {
  const calls = [];
  const collected = await collectOffhoursBasisResearch({ fetchImpl: publicFetch(calls), now: () => offAt });
  assert.equal(calls.length, 6);
  assert.equal(collected.evidenceLabel, "OBSERVATION_ONLY");
  assert.equal(summarizeOffhoursBasisResearch(collected.observations, { asOf: offAt }).evidenceLabel, "OBSERVATION_ONLY");
  assert.deepEqual(collected.observations.map(o => o.ticker), ["SPY", "QQQ"]);
  assert.ok(collected.observations.every(o => o.status === "NO_QUOTE" && o.basis.theoreticalPrice === null));
  const supplied = await collectOffhoursBasisResearch({ fetchImpl: publicFetch(), now: () => offAt,
    inputLoader: async ({ instrument: asset }) => input(offAt, false, asset) });
  assert.ok(supplied.observations.every(o => o.status === "COMPARABLE"));
});

test("F retains only SPY/QQQ discovery rows, with a full-response hash and explicit projection counts", async () => {
  const fetchImpl = publicFetch();
  const result = await collectOffhoursBasisResearch({ now: () => offAt, fetchImpl: async (url, options) => {
    const response = await fetchImpl(url, options);
    if (!String(url).includes("detail/list")) return response;
    const payload = await response.json();
    payload.data.push({ ...instrument, ticker: "NVDA", symbol: "NVDAon" });
    return { ok: true, json: async () => payload };
  } });
  const discovery = result.sources.find(source => source.url.includes("detail/list"));
  assert.equal(discovery.payload.data.length, 2);
  assert.deepEqual(discovery.projection, { kind: "SPY_QQQ_ONLY", totalRows: 3, retainedRows: 2 });
  assert.match(discovery.responseHash, /^[0-9a-f]{64}$/);
});

test("F history caps fail closed before reading or fetching and clearly require archival", async () => {
  let reads = 0;
  const fsImpl = {
    readdir: async () => Array.from({ length: 1000 }, (_, i) => `${i}.json`),
    stat: async () => ({ size: 1 }),
    readFile: async () => { reads += 1; throw new Error("unexpected read"); }
  };
  await assert.rejects(loadOffhoursBasisHistory("unused", { fsImpl }), /ARCHIVE_REQUIRED.*1000/);
  assert.equal(reads, 0);
  fsImpl.readdir = async () => ["large.json"];
  fsImpl.stat = async () => ({ size: 256 * 1024 + 1 });
  await assert.rejects(loadOffhoursBasisHistory("unused", { fsImpl }), /ARCHIVE_REQUIRED.*snapshot bytes/);
  fsImpl.readdir = async () => Array.from({ length: 300 }, (_, i) => `${i}.json`);
  fsImpl.stat = async () => ({ size: 256 * 1024 });
  await assert.rejects(loadOffhoursBasisHistory("unused", { fsImpl }), /ARCHIVE_REQUIRED.*total bytes/);
  assert.equal(reads, 0);
});

test("F preserves unavailable public and supplied input failures instead of claiming zero opportunities", async () => {
  const failed = await collectOffhoursBasisResearch({ fetchImpl: publicFetch([], true), now: () => offAt });
  assert.equal(failed.observations.length, 2);
  assert.ok(failed.errors.length > 0);
  assert.ok(failed.observations.every(o => !o.comparable));
  const badLoader = await collectOffhoursBasisResearch({ fetchImpl: publicFetch(), now: () => offAt,
    inputLoader: async () => { throw new Error("fixture missing quotes"); } });
  assert.equal(badLoader.errors.length, 2);
  assert.ok(badLoader.observations.every(o => o.vetoReasons.includes("SUPPLIED_INPUT_UNAVAILABLE")));
});

test("F explicit local file is optional, fail-closed and cannot override collection identity or time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "offhours-input-F-"));
  const path = join(directory, "evidence.json");
  const qqq = { ...instrument, ticker: "QQQ", symbol: "QQQon", contractAddress: `0x${"3".repeat(40)}` };
  const spyInput = input(); spyInput.observedAt = "2099-01-01T00:00:00Z";
  await writeFile(path, JSON.stringify({ observations: [spyInput, input(offAt, false, qqq)] }));
  const result = await collectOffhoursBasisResearch({ inputFile: path, now: () => offAt, fetchImpl: publicFetch() });
  assert.ok(result.inputFileHash);
  assert.ok(result.observations.every(o => o.comparable && o.observedAt === offAt));
  const missing = await collectOffhoursBasisResearch({ inputFile: join(directory, "absent.json"), now: () => offAt, fetchImpl: publicFetch() });
  assert.ok(missing.observations.every(o => o.vetoReasons.includes("SUPPLIED_INPUT_UNAVAILABLE")));
  await writeFile(path, JSON.stringify({ observations: [input(), input()] }));
  const duplicate = await collectOffhoursBasisResearch({ inputFile: path, now: () => offAt, fetchImpl: publicFetch() });
  assert.ok(duplicate.observations.every(o => o.vetoReasons.includes("SUPPLIED_INPUT_UNAVAILABLE")));
});

test("F runner writes unique verifiable immutable run snapshots without a Live or latest file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "offhours-F-"));
  const options = { directory, fetchImpl: publicFetch(), now: () => offAt };
  const first = await runOffhoursBasisResearch(options);
  const bytes = await readFile(first.path, "utf8");
  const second = await runOffhoursBasisResearch(options);
  assert.notEqual(first.id, second.id);
  assert.equal(await readFile(first.path, "utf8"), bytes);
  assert.equal(second.snapshot.summary.totalObservations, 2, "identical observations are deduplicated across runs");
  assert.equal(second.snapshot.summary.pairs, undefined);
  assert.equal(second.snapshot.priorRuns, undefined);
  assert.equal(second.snapshot.history.snapshotCount, 1);
  assert.match(second.snapshot.history.manifestHash, /^[0-9a-f]{64}$/);
  for (const name of ["src/offhours-basis-research.mjs", "scripts/run-offhours-basis-research.mjs", "src/executable-basis.mjs", "src/weekly-research-calendar.mjs", "src/strategy-data.mjs", "src/strategy.mjs"]) {
    assert.match(first.snapshot.codeHashes[name], /^[0-9a-f]{64}$/);
  }
  assert.ok(first.snapshot.currentPairs.length === 0);
  assert.deepEqual((await readdir(directory)).sort(), [first.id + ".json", second.id + ".json"].sort());
  const forged = JSON.parse(bytes); forged.contentHash = "bad";
  await writeFile(join(directory, "forged.json"), JSON.stringify(forged));
  await assert.rejects(runOffhoursBasisResearch(options), /integrity/);
});
