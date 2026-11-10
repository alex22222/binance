// Reproducible read-only public-data study. Raw responses and failure evidence
// are generated artifacts, never live radar inputs. No private API or notifier.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadFedExpectations, loadRadarPercentileDatasets } from "../../src/btc-radar-sources.mjs";
import { buildPercentileHistory, percentileInputsAt, scorePercentileFactors } from "../../src/btc-radar-percentiles.mjs";
import { evaluateLegacyBtcRadar, pyRound } from "../../src/btc-radar-model.mjs";

const DAY = 86400000;
const avg = rows => rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : null;
export function spearman(pairs) {
  const ranks = values => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (let i = 0; i < order.length;) {
      let j = i + 1;
      while (j < order.length && order[j][0] === order[i][0]) j++;
      for (let k = i; k < j; k++) out[order[k][1]] = (i + j - 1) / 2;
      i = j;
    }
    return out;
  };
  if (pairs.length < 3) return null;
  const x = ranks(pairs.map(r => r[0])), y = ranks(pairs.map(r => r[1]));
  const mx = avg(x), my = avg(y);
  const denominator = Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0) * y.reduce((s, v) => s + (v - my) ** 2, 0));
  return denominator ? x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / denominator : null;
}

export function summarize(rows, priceOn) {
  const scores = rows.map(r => r.score).sort((a, b) => a - b);
  const q = p => scores.length ? scores[Math.floor((scores.length - 1) * p)] : null;
  return { days: scores.length, start: rows[0]?.date || null, end: rows.at(-1)?.date || null,
    distribution: { min: q(0), p10: q(0.1), median: q(0.5), p90: q(0.9), max: q(1),
      below40: scores.filter(v => v < 40).length, atLeast70: scores.filter(v => v >= 70).length },
    horizons: Object.fromEntries([1, 7].map(days => {
      const pairs = rows.flatMap(row => {
        const close = priceOn.get(new Date(Date.parse(row.date) + (days - 1) * DAY).toISOString().slice(0, 10));
        return close > 0 ? [[row.score, close / row.price - 1]] : [];
      });
      return [days, { matured: pairs.length, spearman: spearman(pairs),
        nonOverlappingWindows: Math.floor(pairs.length / days), note: "7日窗口重叠；未作显著性或收益预测声明" }];
    })) };
}

export function studyV3(datasets, { minimumDate = "2024-01-01" } = {}) {
  const history = buildPercentileHistory(datasets);
  const btc = [...(datasets.btc || [])].sort((a, b) => a.date.localeCompare(b.date));
  const priceOn = new Map(btc.map(row => [row.date, row.close]));
  const full = [], common = [], missing = {};
  for (let i = 60; i < btc.length; i++) {
    const date = new Date(Date.parse(btc[i].date) + DAY).toISOString().slice(0, 10);
    if (date < minimumDate) continue;
    const nowMs = Date.parse(`${date}T00:43:00Z`);
    const result = scorePercentileFactors(percentileInputsAt(history, nowMs));
    const row = { date, price: btc[i].close, score: result.score };
    if (result.score !== null) full.push(row);
    for (const f of result.factors) for (const c of f.components) if (c.score === null) missing[c.id] = (missing[c.id] || 0) + 1;
    const diagnostic = result.factors.filter(f => ["rates", "tech", "gold"].includes(f.key));
    if (diagnostic.some(f => f.score === null)) continue;
    // Compare ONLY the same available factors and dates. This is explicitly a
    // reduced-model diagnostic, not the requested full five-factor backtest.
    const closeInput = btc.slice(i - 59, i + 1).reverse().map(r => r.close);
    const gold = (datasets.gold || []).filter(r => r.date <= btc[i].date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15).map(r => r.close);
    const treasury = (datasets.treasury || []).filter(r => r.date <= btc[i].date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 11);
    if (gold.length < 15 || treasury.length < 11) continue;
    const legacy = evaluateLegacyBtcRadar({ price: row.price, btc_closes: closeInput, gold_closes: gold,
      funding: [0.0001], oi_7d_change_pct: 0, sentiment: null,
      fed: { p_hike_next: 0, p_cut_next: 0, p_hike_2026_any: 0, p_cut_2026_any: 0 }, treasury });
    const oldFactors = legacy.factors.filter(f => ["ust", "tech", "gold"].includes(f.key));
    common.push({ ...row, score: diagnostic.reduce((s, f) => s + f.score * f.weight, 0) / 60,
      oldScore: oldFactors.reduce((s, f) => s + f.score * f.weight, 0) / 45 });
  }
  const newSummary = summarize(full, priceOn);
  return { modelVersion: "pressure-v3-trailing-percentiles", fullModel: newSummary,
    distributionAcceptance: newSummary.distribution.below40 > 0 && newSummary.distribution.atLeast70 > 0,
    comparableReducedModels: { warning: "Only rates/technical/gold; flow and derivatives excluded in BOTH. Not full-model acceptance. Old inputs normalized to UTC completed candles for comparability, not exact live reproduction.",
      old: summarize(common.map(r => ({ ...r, score: r.oldScore })), priceOn), next: summarize(common, priceOn) },
    unavailableByMetricDays: missing,
    coverage: Object.fromEntries(Object.entries(history).map(([key, rows]) => [key, { n: rows.length, start: rows[0]?.date, end: rows.at(-1)?.date }])),
    limitations: ["Historical responses retrieved now may contain revisions, not point-in-time vintages.", "No fitted coefficients or score stretching; only trailing ranks; current observation excluded.", "ETF conservatively lagged two calendar days; Treasury one day. Missing data not filled with 50.", "No full-model performance claim if any factor has insufficient calibration.", "Descriptive development sample, not an untouched out-of-sample test."] };
}

async function main() {
  const directory = resolve(process.argv.find(arg => arg.startsWith("--output="))?.slice(9) || "artifacts/btc-radar-v3-study");
  const cache = resolve(directory, "datasets.json");
  await mkdir(directory, { recursive: true });
  if (process.argv.includes("--audit-fed")) {
    const fed = await loadFedExpectations();
    await writeFile(resolve(directory, "fed-contract.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), ...fed }, null, 2));
  }
  let collected;
  if (process.argv.includes("--fetch")) {
    collected = await loadRadarPercentileDatasets({ nowMs: Date.now() });
    await writeFile(cache, JSON.stringify(collected, null, 2));
  } else collected = JSON.parse(await readFile(cache, "utf8"));
  const raw = JSON.stringify(collected);
  const report = { generatedAt: new Date().toISOString(), sourceFetchedAt: collected.fetchedAt,
    datasetsSha256: createHash("sha256").update(raw).digest("hex"), sourceErrors: collected.errors,
    ...studyV3(collected.datasets) };
  if (process.argv.includes("--collect-baseline")) {
    const code = `import {readFile} from 'node:fs/promises';const d=JSON.parse(await readFile('/opt/binance-agentic-stock-bot/state/btc-radar/daily.json','utf8'));console.log(JSON.stringify(d));`;
    const { stdout } = await promisify(execFile)("ssh", ["-i", join(homedir(), ".ssh", "polymtrade_vultr_ed25519"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=12", "root@173.199.122.23", `node --input-type=module -e '${code.replaceAll("'", "'\\''")}'`], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(resolve(directory, "recorded-daily.json"), stdout);
  }
  try {
    const daily = JSON.parse(await readFile(resolve(directory, "recorded-daily.json"), "utf8"));
    const prices = new Map(daily.closes.map(r => [r.date, r.close]));
    const rows = daily.snapshots.flatMap(row => {
      let score = row.score;
      if (row.modelVersion === "legacy") {
        const weights = { fed: 20, ust: 20, gold: 10, tech: 15, deriv: 10 };
        if (!Object.keys(weights).every(key => Number.isFinite(row.f?.[key]))) return [];
        score = pyRound(Object.entries(weights).reduce((s, [key, w]) => s + row.f[key] * w, 0) / 75, 1);
      } else if (row.modelVersion !== "pressure-v2-no-touch-probability") return [];
      return [{ date: row.date, price: row.price, score }];
    });
    report.recordedV2 = { ...summarize(rows, prices), note: "Recorded daily prices/factors; legacy days mechanically reweighted to v2. Not reconstructed v3 and not the reduced-model cohort." };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
