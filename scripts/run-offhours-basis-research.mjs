import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOffhoursBasisObservation, hashOffhoursEvidence, summarizeOffhoursBasisResearch } from "../src/offhours-basis-research.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDirectory = join(root, "state/research/offhours-basis");
const api = "https://www.binance.com/bapi/defi";
const rwa = "/public/wallet-direct/buw/wallet/market/token/rwa";
const MAX_SNAPSHOTS = 1000;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const execFileAsync = promisify(execFile);

async function readCodeHashes() {
  const hashes = {};
  for (const name of ["src/offhours-basis-research.mjs", "scripts/run-offhours-basis-research.mjs", "src/executable-basis.mjs",
    "src/weekly-research-calendar.mjs", "src/strategy-data.mjs", "src/strategy.mjs", "src/strategy-signals.mjs", "src/strategy-exit.mjs"]) {
    hashes[name] = createHash("sha256").update(await readFile(join(root, name))).digest("hex");
  }
  return hashes;
}

const loadedCodeHashes = Object.freeze(await readCodeHashes());

export function assertOffhoursCodeUnchanged(expected, actual) {
  if (hashOffhoursEvidence(expected) !== hashOffhoursEvidence(actual)) throw new Error("CODE_CHANGED_DURING_RUN: reload the runner before collecting evidence");
}

export async function offhoursPublicFetch(url, { execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl("curl", ["-fsS", "--request", "GET", "--max-time", "10", "--max-filesize", "2097152",
    "--header", "Accept: application/json", "--header", "Accept-Encoding: identity",
    "--header", "User-Agent: binance-web3/1.1 (Skill)", "--url", String(url)],
  { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
  if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) throw new Error("Public response exceeds 2 MiB");
  const payload = JSON.parse(stdout);
  return { ok: true, json: async () => payload };
}

// A supplied JSON file has { observations: [{ ticker, buyQuote, sellQuote, reference,
// companyAction, nextSession, estimatedRoundTripGasUsdt, executionBufferPct }] }.
// See test/offhours-basis-research.test.mjs input() for the explicit evidence schema.
// Public oracle prices are stored for context only and never converted into quotes.
export async function collectOffhoursBasisResearch({
  fetchImpl = offhoursPublicFetch,
  now = () => new Date().toISOString(),
  inputLoader,
  inputFile
} = {}) {
  if (inputLoader && inputFile) throw new Error("Supply either inputFile or inputLoader, not both");
  const sources = [], errors = [], observations = [], inputs = [];
  const startedAt = now();
  async function request(url, projectDiscovery = false) {
    try {
      const response = await fetchImpl(url, { method: "GET", headers: {
        "Accept": "application/json", "Accept-Encoding": "identity", "User-Agent": "binance-web3/1.1 (Skill)"
      }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.code !== "000000" || payload.success === false || payload.data == null) throw new Error("Invalid Binance public response");
      const retrievedAt = now(), responseHash = hashOffhoursEvidence(payload);
      let projection = null;
      if (projectDiscovery) {
        if (!Array.isArray(payload.data)) throw new Error("Invalid Binance discovery list");
        const totalRows = payload.data.length;
        payload.data = payload.data.filter(row => ["SPY", "QQQ"].includes(row?.ticker));
        projection = { kind: "SPY_QQQ_ONLY", totalRows, retainedRows: payload.data.length };
      }
      sources.push({ url, retrievedAt, responseHash, contentHash: hashOffhoursEvidence(payload), projection, payload });
      return { data: payload.data, retrievedAt };
    } catch (error) {
      const retrievedAt = now();
      sources.push({ url, retrievedAt, error: error.message });
      errors.push({ source: url, reason: "PUBLIC_INPUT_UNAVAILABLE", message: error.message });
      return { data: null, retrievedAt };
    }
  }
  let suppliedRows = null, suppliedFailure = null, inputFileHash = null;
  if (inputFile) {
    try {
      if ((await stat(resolve(inputFile))).size > MAX_SNAPSHOT_BYTES) throw new Error("Supplied input exceeds 256 KiB");
      const raw = await readFile(resolve(inputFile), "utf8");
      const supplied = JSON.parse(raw);
      if (!Array.isArray(supplied?.observations)) throw new Error("Input file must contain an observations array");
      suppliedRows = supplied.observations;
      inputFileHash = hashOffhoursEvidence(supplied);
    } catch (error) {
      suppliedFailure = error.message;
    }
  }
  const [discovery, market] = await Promise.all([
    request(`${api}/v1${rwa}/stock/detail/list/ai?type=1`, true),
    request(`${api}/v1${rwa}/market/status/ai`)
  ]);
  for (const ticker of ["SPY", "QQQ"]) {
    const inputErrors = [];
    const matches = (Array.isArray(discovery.data) ? discovery.data : []).filter(
      row => row?.ticker === ticker && String(row.chainId) === "56" && Number(row.type) === 1
    );
    const instrument = matches.length === 1 ? matches[0] : null;
    if (!instrument) inputErrors.push(matches.length > 1 ? "DISCOVERY_IDENTITY_AMBIGUOUS" : "DISCOVERY_IDENTITY_UNAVAILABLE");
    const params = instrument ? new URLSearchParams({ chainId: "56", contractAddress: instrument.contractAddress }) : null;
    const [status, dynamic] = instrument ? await Promise.all([
      request(`${api}/v1${rwa}/asset/market/status/ai?${params}`),
      request(`${api}/v2${rwa}/dynamic/ai?${params}`)
    ]) : [{ data: null, retrievedAt: null }, { data: null, retrievedAt: null }];
    let supplied = {};
    try {
      if (suppliedFailure) throw new Error(suppliedFailure);
      if (inputLoader) supplied = await inputLoader({ ticker, instrument, observedAt: now() }) || {};
      else if (suppliedRows) {
        const matches = suppliedRows.filter(row => row?.ticker === ticker);
        if (matches.length !== 1) throw new Error(`Expected one supplied evidence row for ${ticker}`);
        supplied = matches[0];
      }
    } catch (error) {
      inputErrors.push("SUPPLIED_INPUT_UNAVAILABLE");
      errors.push({ ticker, source: "LOCAL_SUPPLIED_INPUT", reason: "SUPPLIED_INPUT_UNAVAILABLE", message: error.message });
    }
    // Never let supplied evidence override discovery, public status, measured collection
    // times, or the research-only boundary. The dynamic response is request-bound.
    const input = {
      ticker, instrument, discoveredAt: discovery.retrievedAt, observedAt: now(),
      assetStatus: status.data, statusRetrievedAt: status.retrievedAt,
      marketStatus: market.data, marketRetrievedAt: market.retrievedAt,
      rwaDynamic: dynamic.data, dynamicIdentity: instrument, dynamicRetrievedAt: dynamic.retrievedAt,
      tradeUsdt: 50, buyQuote: supplied.buyQuote, sellQuote: supplied.sellQuote,
      reference: supplied.reference, companyAction: supplied.companyAction, nextSession: supplied.nextSession,
      estimatedRoundTripGasUsdt: supplied.estimatedRoundTripGasUsdt, executionBufferPct: supplied.executionBufferPct,
      inputErrors
    };
    inputs.push(input);
    observations.push(buildOffhoursBasisObservation(input));
  }
  return { schemaVersion: 1, candidate: "F", startedAt, completedAt: now(), automaticTradingEligible: false,
    evidenceLabel: observations.some(observation => observation.comparable) ? "OBSERVATION_ONLY_AND_QUOTE_SHADOW" : "OBSERVATION_ONLY",
    inputFileHash, observations, inputs, sources, errors };
}

export async function loadOffhoursBasisHistory(directory, { fsImpl = { readdir, stat, readFile } } = {}) {
  const observations = [], manifest = [];
  let names;
  try { names = await fsImpl.readdir(directory); } catch (error) { if (error.code !== "ENOENT") throw error; names = []; }
  names = names.filter(name => name.endsWith(".json")).sort();
  if (names.length >= MAX_SNAPSHOTS) throw new Error("ARCHIVE_REQUIRED: off-hours history reached 1000 snapshots; preserve/archive evidence before another run");
  let totalBytes = 0;
  // Preflight all sizes before parsing anything. Never silently truncate the history.
  for (const name of names) {
    const { size } = await fsImpl.stat(join(directory, name));
    if (size > MAX_SNAPSHOT_BYTES) throw new Error(`ARCHIVE_REQUIRED: snapshot bytes exceed 256 KiB: ${name}`);
    totalBytes += size;
    if (totalBytes > MAX_HISTORY_BYTES) throw new Error("ARCHIVE_REQUIRED: total bytes exceed 64 MiB");
  }
  for (const name of names) {
    const saved = JSON.parse(await fsImpl.readFile(join(directory, name), "utf8"));
    const { contentHash, ...content } = saved;
    if (contentHash !== hashOffhoursEvidence(content) || saved.schemaVersion !== 1 || saved.candidate !== "F" ||
      !Array.isArray(saved.observations)) throw new Error(`Off-hours snapshot integrity failure: ${name}`);
    observations.push(...saved.observations);
    manifest.push({ id: saved.id, contentHash });
  }
  return { observations, snapshotCount: names.length, totalBytes, manifestHash: hashOffhoursEvidence(manifest) };
}

export async function runOffhoursBasisResearch({ directory = defaultDirectory, ...options } = {}) {
  const { observations: history, ...historyManifest } = await loadOffhoursBasisHistory(directory);
  assertOffhoursCodeUnchanged(loadedCodeHashes, await readCodeHashes());
  const collection = await collectOffhoursBasisResearch(options);
  assertOffhoursCodeUnchanged(loadedCodeHashes, await readCodeHashes());
  const id = `${new Date(collection.completedAt).toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const { pairs, rejectedPairs, ...summary } = summarizeOffhoursBasisResearch([...history, ...collection.observations], { asOf: collection.completedAt });
  const currentIds = new Set(collection.observations.map(observation => observation.id));
  const snapshot = { ...collection, id, codeHashes: loadedCodeHashes, history: historyManifest,
    summary: { ...summary, rejectedPairCount: rejectedPairs.length, pairingManifestHash: hashOffhoursEvidence([...pairs, ...rejectedPairs].map(pair => pair.id)) },
    currentPairs: pairs.filter(pair => currentIds.has(pair.regularId)),
    currentRejectedPairs: rejectedPairs.filter(pair => currentIds.has(pair.regularId)) };
  const frozen = { ...snapshot, contentHash: hashOffhoursEvidence(snapshot) };
  const bytes = JSON.stringify(frozen, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > MAX_SNAPSHOT_BYTES || historyManifest.totalBytes + Buffer.byteLength(bytes) > MAX_HISTORY_BYTES) {
    throw new Error("ARCHIVE_REQUIRED: new snapshot exceeds snapshot bytes (256 KiB) or total bytes (64 MiB) cap; nothing written");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.json`);
  // Unique immutable snapshots only: no latest pointer and no shared Live state.
  await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
  return { id, path, contentHash: frozen.contentHash, snapshot: frozen };
}

async function main(args) {
  if (args.length && !(args.length === 2 && args[0] === "--input")) {
    throw new Error("Usage: node scripts/run-offhours-basis-research.mjs [--input evidence.json]");
  }
  const result = await runOffhoursBasisResearch({ inputFile: args[1] });
  console.log(JSON.stringify({ id: result.id, path: result.path, contentHash: result.contentHash,
    errors: result.snapshot.errors, summary: result.snapshot.summary }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
