import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runMonthlyTrendResearch } from "./run-monthly-trend-research.mjs";
import { runOffhoursBasisResearch } from "./run-offhours-basis-research.mjs";

const publicInputFailures = new Set([
  "DISCOVERY_IDENTITY_AMBIGUOUS", "DISCOVERY_IDENTITY_UNAVAILABLE", "INSTRUMENT_IDENTITY_UNVERIFIED",
  "DISCOVERY_STALE_OR_INVALID", "DYNAMIC_IDENTITY_MISMATCH", "INVALID_MULTIPLIER", "MULTIPLIER_MISMATCH",
  "MULTIPLIER_STALE_OR_INVALID", "MARKET_STATUS_STALE_OR_INVALID"
]);

// This receipt describes collection health, never strategy qualification or trading permission.
export async function runScheduledResearch({
  job,
  directory = resolve(import.meta.dirname, "../state/research/scheduled"),
  runMonthly = runMonthlyTrendResearch,
  runOffhours = runOffhoursBasisResearch,
  now = () => new Date().toISOString()
} = {}) {
  if (!["monthly", "offhours"].includes(job)) throw new Error("Usage: run-scheduled-research.mjs monthly|offhours");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const receipt = { schemaVersion: 1, id: randomUUID(), job, startedAt: now(), status: "RUNNING",
    automaticTradingEligible: false, artifact: null };
  const path = join(directory, `${job}.json`);
  async function save() {
    const temporary = join(directory, `.${job}-${receipt.id}.tmp`);
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
  await save();
  try {
    if (job === "monthly") {
      const { runDirectory, report } = await runMonthly();
      receipt.artifact = join(runDirectory, "report.json");
      receipt.evidenceLabel = "HISTORICAL_PROXY";
      receipt.researchDecision = report.verdicts || report.status;
      if (report.automaticTradingEligible !== false || !report.periods) {
        throw new Error(`MONTHLY_COLLECTION_BLOCKED: ${report.status || "INVALID_REPORT"}`);
      }
    } else {
      const { path: artifact, snapshot } = await runOffhours();
      receipt.artifact = artifact;
      receipt.evidenceLabel = snapshot.evidenceLabel;
      receipt.researchDecision = snapshot.summary.decision;
      receipt.validPairs = snapshot.summary.validPairs;
      receipt.reviewEligible = snapshot.summary.reviewEligible;
      receipt.collectionErrors = snapshot.errors;
      // Session pauses/conflicts remain observation vetoes, not transport failures.
      receipt.publicInputFailures = [...new Set(snapshot.observations.flatMap(row => row.vetoReasons)
        .filter(reason => publicInputFailures.has(reason)))];
      receipt.observations = snapshot.observations.map(({ ticker, status, comparable, vetoReasons }) => ({ ticker, status, comparable, vetoReasons }));
      if (snapshot.automaticTradingEligible !== false || snapshot.errors.length || receipt.publicInputFailures.length ||
        snapshot.observations.length !== 2 || new Set(snapshot.observations.map(row => row.ticker)).size !== 2 ||
        snapshot.observations.some(row => !["SPY", "QQQ"].includes(row.ticker) || row.automaticTradingEligible !== false)) {
        throw new Error("OFFHOURS_COLLECTION_BLOCKED: inspect the preserved snapshot and public input failures");
      }
    }
    receipt.status = "SUCCEEDED";
  } catch (error) {
    receipt.status = "FAILED";
    receipt.error = error.message;
  }
  receipt.completedAt = now();
  await save();
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: run-scheduled-research.mjs monthly|offhours");
  runScheduledResearch({ job: process.argv[2] }).then(receipt => {
    console.log(JSON.stringify(receipt));
    if (receipt.status !== "SUCCEEDED") process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
