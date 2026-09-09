import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { prepareCryptoFeatures, backtestCryptoMomentum, CURRENT_MOMENTUM_CONFIG } from "../src/crypto-momentum-backtest.mjs";

const startMs = Date.parse("2025-09-05T00:00:00Z");
const endMs = Date.parse("2026-09-05T00:00:00Z");
const warmupMs = startMs - 86_400_000;
const outputDir = path.resolve("artifacts/crypto-momentum-2026-09-05");
const dataDir = path.join(outputDir, "data");
await fs.mkdir(dataDir, { recursive: true });
const manifest = [];

async function download(symbol, period, stamp) {
  const filename = `${symbol}-1m-${stamp}.zip`;
  const url = `https://data.binance.vision/data/spot/${period}/klines/${symbol}/1m/${filename}`;
  const target = path.join(dataDir, filename);
  let buffer;
  let checksum;
  try {
    [buffer, checksum] = await Promise.all([fs.readFile(target), fs.readFile(`${target}.CHECKSUM`, "utf8")]);
  } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${response.status}: ${url}`);
    buffer = Buffer.from(await response.arrayBuffer());
    const check = await fetch(`${url}.CHECKSUM`, { signal: AbortSignal.timeout(30_000) });
    if (!check.ok) throw new Error(`Checksum ${check.status}: ${url}`);
    checksum = await check.text();
    await fs.writeFile(target, buffer);
    await fs.writeFile(`${target}.CHECKSUM`, checksum);
  }
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== checksum.trim().split(/\s+/)[0]) throw new Error(`Checksum mismatch: ${filename}`);
  manifest.push({ symbol, url, filename, sha256, bytes: buffer.length });
  console.log(`Verified ${filename} (${buffer.length} bytes)`);
  return target;
}

async function pooled(items, fn, concurrency = 4) {
  let cursor = 0;
  const results = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

async function monthFiles(symbol, month) {
  const monthly = await download(symbol, "monthly", month);
  if (monthly) return [monthly];
  const first = Date.parse(`${month}-01T00:00:00Z`);
  const dates = [];
  for (let ms = first; ms < endMs && new Date(ms).toISOString().startsWith(month); ms += 86_400_000) {
    if (ms >= warmupMs) dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return pooled(dates, async (date) => {
    const file = await download(symbol, "daily", date);
    if (!file) throw new Error(`Missing official daily archive: ${symbol} ${date}`);
    return file;
  });
}

async function loadCandles(symbol) {
  const months = [];
  for (let year = 2025, month = 8; year < 2026 || month <= 8; month++) {
    if (month === 12) { year++; month = 0; }
    months.push(`${year}-${String(month + 1).padStart(2, "0")}`);
  }
  const files = (await pooled(months, (month) => monthFiles(symbol, month), 2)).flat();
  const candles = [];
  for (const file of files) {
    const csv = execFileSync("unzip", ["-p", file], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    for (const line of csv.trim().split("\n")) {
      const row = line.split(",");
      const rawTime = Number(row[0]);
      const scale = rawTime > 1e14 ? 1000 : 1;
      const openTime = rawTime / scale;
      if (openTime < warmupMs || openTime >= endMs) continue;
      const [open, high, low, close] = row.slice(1, 5).map(Number);
      if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)
        || high < Math.max(open, close) || low > Math.min(open, close)) throw new Error(`Invalid OHLC: ${file}`);
      candles.push({ openTime, open, high, low, close, closeTime: Number(row[6]) / scale });
    }
  }
  candles.sort((a, b) => a.openTime - b.openTime);
  const expected = (endMs - warmupMs) / 60_000;
  if (candles.length !== expected) throw new Error(`${symbol}: expected ${expected} minutes, got ${candles.length}`);
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].openTime !== warmupMs + i * 60_000
      || candles[i].closeTime < candles[i].openTime
      || candles[i].closeTime >= candles[i].openTime + 60_000) throw new Error(`${symbol}: gap/duplicate/timestamp at ${i}`);
  }
  return candles;
}

const scenarios = [
  { name: "zero-cost-diagnostic", feePct: 0, slippagePct: 0 },
  { name: "low-cost", feePct: 0.05, slippagePct: 0.01 },
  { name: "base", feePct: 0.1, slippagePct: 0.02 },
  { name: "stress", feePct: 0.2, slippagePct: 0.05 }
];
const results = [];
const coverage = [];
for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
  const candles = await loadCandles(symbol);
  coverage.push({ symbol, minutes: candles.length, warmupMinutes: 1440, backtestMinutes: (endMs - startMs) / 60_000, missingMinutes: 0 });
  await fs.writeFile(path.join(outputDir, "data-manifest.json"), JSON.stringify(manifest, null, 2));
  const features = prepareCryptoFeatures(candles, CURRENT_MOMENTUM_CONFIG);
  for (const scenario of scenarios) {
    const result = backtestCryptoMomentum({ symbol, candles, features, startMs, endMs, ...scenario });
    results.push({ symbol, scenario: scenario.name, ...result.summary });
    await fs.writeFile(path.join(outputDir, `${symbol}-${scenario.name}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(results.at(-1)));
  }
  for (const entryPhaseMinutes of [5, 10]) {
    const result = backtestCryptoMomentum({ symbol, candles, features, startMs, endMs, ...scenarios[2], entryPhaseMinutes });
    results.push({ symbol, scenario: `base-phase-${entryPhaseMinutes}`, ...result.summary });
    await fs.writeFile(path.join(outputDir, `${symbol}-base-phase-${entryPhaseMinutes}.json`), JSON.stringify(result, null, 2));
  }
}
const sourceHashes = {};
for (const file of ["src/strategy-signals.mjs", "src/strategy-exit.mjs", "src/execution-accounting.mjs", "src/strategy.mjs", "src/crypto-momentum-backtest.mjs", "scripts/run-crypto-momentum-backtest.mjs"]) {
  sourceHashes[file] = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
await fs.writeFile(path.join(outputDir, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), start: new Date(startMs).toISOString(), endExclusive: new Date(endMs).toISOString(), config: CURRENT_MOMENTUM_CONFIG, sourceHashes, coverage, results }, null, 2));
console.log(`Completed: ${outputDir}/summary.json`);
