import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { nyseSessionPlan } from "../src/strategy.mjs";
import { newYorkSessionBounds } from "../src/strategy-data.mjs";
import { weeklyEtfRotationAssets, WEEKLY_ETF_ROTATION_UNIVERSE } from "../src/weekly-etf-rotation-paper.mjs";
import { advanceFrequencyPaper, initialFrequencyPaper, frequencyDecisionDue, frequencyPaperDecisions, frequencyHash, FREQUENCY_PAPER_HASH } from "../src/etf-frequency-paper.mjs";

const root = resolve(import.meta.dirname, "..");
const exec = promisify(execFile);
const codeFiles = ["scripts/run-etf-frequency-paper.mjs", "src/etf-frequency-paper.mjs", "src/weekly-etf-rotation-paper.mjs", "src/weekly-research-calendar.mjs", "src/strategy.mjs", "src/strategy-data.mjs"];
const codeHash = async () => frequencyHash(await Promise.all(codeFiles.map(async file => [file, frequencyHash(await readFile(resolve(root, file), "utf8"))])));

async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o750 });
  await writeFile(file + ".tmp", JSON.stringify(value) + "\n", { mode: 0o640 });
  await rename(file + ".tmp", file);
}

export async function fetchFrequencyJson(url) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await exec("curl", ["-fsSL", "--max-time", "20", "-H", "Accept-Encoding: identity", "-A", "Mozilla/5.0", String(url)], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
      return { payload: JSON.parse(stdout), raw: stdout, url: String(url), collectedAt: new Date().toISOString(), sourceHash: frequencyHash(stdout) };
    } catch (error) { failure = error; }
  }
  throw failure;
}

export function frequencyDailyRows(payload, ticker, sessionDate) {
  const result = payload.chart?.result?.[0];
  if (!result || result.meta?.symbol !== ticker || result.meta?.currency !== "USD" || result.meta?.instrumentType !== "ETF" || result.meta?.exchangeTimezoneName !== "America/New_York") throw new Error(`Yahoo identity mismatch: ${ticker}`);
  const values = result.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(values) || values.length !== result.timestamp?.length) throw new Error(`Missing adjusted closes: ${ticker}`);
  return result.timestamp.map((timestamp, i) => ({ date: new Date(Number(timestamp) * 1000).toISOString().slice(0, 10), close: values[i] }))
    .filter(row => row.date < sessionDate);
}

export function frequencyTokenPrice(payload, ticker, bounds, nowMs) {
  if (payload.code !== "000000" || !Array.isArray(payload.data?.klineInfos)) throw new Error(`Token candles unavailable: ${ticker}`);
  const candle = payload.data.klineInfos.map(row => ({ open: Number(row[0]), price: Number(row[4]), close: Number(row[6]) }))
    .filter(row => row.open >= bounds.openMs && row.open < bounds.closeMs && row.close < nowMs && row.close >= row.open && Number.isFinite(row.price) && row.price > 0)
    .sort((a, b) => a.open - b.open).at(-1);
  if (!candle || nowMs - candle.close > 5 * 60000) throw new Error(`Stale completed token candle: ${ticker}`);
  return { price: candle.price, observedAt: new Date(candle.close).toISOString() };
}

export async function runFrequencyPaper({ directory = resolve(root, "state/etf-frequency-paper"), nowMs = Date.now(), fetchJson = fetchFrequencyJson, elapsedMs = null } = {}) {
  const startedMs = Date.now();
  const now = new Date(nowMs).toISOString(), plan = nyseSessionPlan(nowMs), path = resolve(directory, "latest.json");
  const loadedCodeHash = await codeHash();
  let state;
  try { state = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; state = { ...initialFrequencyPaper(now), codeHash: loadedCodeHash }; }
  if (state.specificationHash !== FREQUENCY_PAPER_HASH || state.codeHash !== loadedCodeHash) throw new Error("Frozen Paper code/specification changed; new experiment identity required");
  await mkdir(directory, { recursive: true, mode: 0o750 });
  try {
    await writeFile(resolve(directory, "specification.json"), JSON.stringify({ specification: state.specification, specificationHash: state.specificationHash, codeHash: loadedCodeHash }) + "\n", { flag: "wx", mode: 0o640 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const frozen = JSON.parse(await readFile(resolve(directory, "specification.json"), "utf8"));
    if (frozen.specificationHash !== state.specificationHash || frozen.codeHash !== loadedCodeHash || frequencyHash(frozen.specification) !== state.specificationHash) throw new Error("Frozen specification mismatch");
  }
  const due = state.experiments.filter(ledger => frequencyDecisionDue(ledger, plan.date));
  const bounds = newYorkSessionBounds(plan.date);
  if (plan.closeTime === "13:00") bounds.closeMs = bounds.openMs + 3.5 * 3600000;
  if (!plan.regularOpen || nowMs < bounds.openMs + 60000 || (!due.length && !state.experiments.some(ledger => ledger.position))) {
    state.updatedAt = now; state.collectionStatus = !plan.regularOpen ? "MARKET_CLOSED" : "WAITING_FOR_NEXT_PERIOD";
    await atomicJson(path, state); return state;
  }
  try {
    let targets = {}, dailySourceHash = null;
    if (due.some(ledger => ledger.frequency !== "H")) {
      const dailyPath = resolve(directory, "sources", plan.date + ".json");
      let bundle;
      try { bundle = JSON.parse(await readFile(dailyPath, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        const sources = await Promise.all(["QQQ", "SPY", "SGOV"].map(async ticker => {
          const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`);
          url.searchParams.set("period1", String(Math.floor((Date.parse(plan.date) - 700 * 86400000) / 1000)));
          url.searchParams.set("period2", String(Math.floor((Date.parse(plan.date) + 86400000) / 1000)));
          url.searchParams.set("interval", "1d"); url.searchParams.set("events", "div,splits"); url.searchParams.set("includePrePost", "false");
          return [ticker, await fetchJson(url)];
        }));
        bundle = { sessionDate: plan.date, sources: Object.fromEntries(sources) };
        // Validate before freezing; no failed partial feed becomes a usable cache.
        frequencyPaperDecisions(Object.fromEntries(sources.map(([ticker, source]) => [ticker, frequencyDailyRows(source.payload, ticker, plan.date)])), plan.date);
        await mkdir(dirname(dailyPath), { recursive: true, mode: 0o750 });
        await writeFile(dailyPath, JSON.stringify(bundle) + "\n", { flag: "wx", mode: 0o640 });
      }
      if (bundle.sessionDate !== plan.date || Object.values(bundle.sources).some(source => source.sourceHash !== frequencyHash(source.raw))) throw new Error("Frozen source hash mismatch");
      targets = frequencyPaperDecisions(Object.fromEntries(Object.entries(bundle.sources).map(([ticker, source]) => [ticker, frequencyDailyRows(JSON.parse(source.raw), ticker, plan.date)])), plan.date);
      dailySourceHash = frequencyHash(bundle);
    }
    const assets = await fetchJson("https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=1");
    if (assets.payload.code !== "000000") throw new Error("Official asset list unavailable");
    const contracts = weeklyEtfRotationAssets(assets.payload.data, WEEKLY_ETF_ROTATION_UNIVERSE);
    const needed = new Set([...state.experiments.filter(ledger => ledger.position).map(ledger => ledger.position.symbol),
      ...due.map(ledger => ledger.frequency === "H" ? "SPY" : targets[ledger.ruleId]?.target).filter(ticker => ticker && ticker !== "CASH")]);
    const observations = await Promise.all(contracts.filter(asset => needed.has(asset.ticker)).map(async asset => {
      const url = new URL("https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/dex/market/token/kline/ai");
      for (const [key, value] of Object.entries({ chainId: "56", contractAddress: asset.contractAddress, interval: "1m", limit: "5", endTime: String(nowMs) })) url.searchParams.set(key, value);
      const source = await fetchJson(url);
      return [asset.ticker, { ...frequencyTokenPrice(source.payload, asset.ticker, bounds, nowMs), source }];
    }));
    const frozen = { at: now, dailySourceHash, assets, observations: Object.fromEntries(observations) };
    const sourceHash = frequencyHash(frozen);
    if (await codeHash() !== loadedCodeHash) throw new Error("Paper code changed during collection");
    const finalNowMs = nowMs + (elapsedMs ? elapsedMs() : Date.now() - startedMs);
    const finalPlan = nyseSessionPlan(finalNowMs);
    if (!finalPlan.regularOpen || finalPlan.date !== plan.date) throw new Error("Market closed during Paper collection");
    const next = advanceFrequencyPaper(state, { at: new Date(finalNowMs).toISOString(), sessionDate: plan.date, regularOpen: true, targets,
      prices: Object.fromEntries(observations.map(([ticker, value]) => [ticker, value.price])),
      observedAt: observations.map(([, value]) => value.observedAt).sort()[0] || new Date(finalNowMs).toISOString(), sourceHash });
    delete next.collectionError;
    // Freeze price provenance before committing the ledger; never send an order.
    await appendFile(resolve(directory, "observations.jsonl"), JSON.stringify({ ...frozen, sourceHash }) + "\n", { mode: 0o640 });
    await atomicJson(path, next); return next;
  } catch (error) {
    state.updatedAt = now; state.collectionStatus = "DATA_QUALITY_BLOCKED"; state.collectionError = error.message;
    await appendFile(resolve(directory, "failures.jsonl"), JSON.stringify({ at: now, error: error.message }) + "\n", { mode: 0o640 });
    await atomicJson(path, state); throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const state = await runFrequencyPaper();
  console.log(JSON.stringify({ status: state.collectionStatus, experiments: state.experiments.length, specificationHash: state.specificationHash, automaticTradingEligible: false }));
}
