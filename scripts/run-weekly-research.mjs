import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { collectWeeklyResearch } from "../src/weekly-research-data.mjs";
import { finalizeWeeklyReport, loadWeeklyBundle, saveWeeklyBundle, weeklyAnalysisTemplate, weeklyReportStatus, weeklyRunId } from "../src/weekly-research-store.mjs";
import { evidenceGates } from "../src/weekly-research.mjs";
import { weeklyResearchHtml } from "../src/weekly-research-html.mjs";

const root = resolve(import.meta.dirname, "..");
const directory = join(root, "state/weekly-research");
const [command, suppliedId, analysisFile] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const id = suppliedId || weeklyRunId();
const execFileAsync = promisify(execFile);
if (command === "status") {
  const status = await weeklyReportStatus(directory, suppliedId);
  console.log(JSON.stringify({ ...status, report: status.report ? { id: status.report.id, generatedAt: status.report.generatedAt, validation: status.report.validation } : null }));
} else if (["collect", "recollect"].includes(command)) {
  if (id !== weeklyRunId()) throw new Error("Collection cannot be backdated");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, `${id}.collect.lock`);
  const lock = await open(lockPath, "wx", 0o600);
  try {
    if (command === "recollect") {
      const run = join(directory, id);
      try { await readFile(join(run, "report.json")); throw new Error("Cannot recollect a finalized report"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const archive = join(directory, "attempts");
      await mkdir(archive, { recursive: true, mode: 0o700 });
      await rename(run, join(archive, `${id}-${Date.now()}`));
    }
    try {
      const existing = await loadWeeklyBundle(directory, id);
      console.log(JSON.stringify({ id, status: "ALREADY_FROZEN", blockers: evidenceGates(existing) }));
      process.exitCode = 0;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      let config, universeSource;
      if (process.argv.includes("--production")) {
        const { stdout } = await execFileAsync("ssh", ["-i", "/Users/henry/.ssh/polymtrade_vultr_ed25519", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "root@173.199.122.23",
          'cd /opt/binance-agentic-stock-bot && node -e \'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync("config.json","utf8"));console.log(JSON.stringify({symbols:c.symbols}));\''], { timeout: 30000 });
        config = JSON.parse(stdout); universeSource = "PRODUCTION_CONFIG_READ_ONLY";
      } else {
        config = JSON.parse(await readFile(resolve(root, process.env.BOT_CONFIG || "config.json"), "utf8"));
        universeSource = "LOCAL_CONFIG_NOT_PRODUCTION_VERIFIED";
      }
      const result = await collectWeeklyResearch({ universe: config.symbols, universeSource });
      const saved = await saveWeeklyBundle(directory, id, result);
      await writeFile(join(directory, id, "analysis-template.json"), JSON.stringify(weeklyAnalysisTemplate(result.bundle), null, 2), { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ ...saved, status: "FROZEN", symbols: config.symbols.length, candidates: result.bundle.candidates.length,
        passedCandidates: result.bundle.candidates.filter((candidate) => candidate.passed).map((candidate) => candidate.id),
        path: join(directory, id, "bundle.json") }));
    }
  } finally { await lock.close(); await unlink(lockPath); }
} else if (command === "finalize") {
  if (!analysisFile) throw new Error("Provide a structured analysis JSON file");
  const analysis = JSON.parse(await readFile(resolve(analysisFile), "utf8"));
  const report = await finalizeWeeklyReport(directory, id, analysis);
  await writeFile(join(directory, id, "report.html"), weeklyResearchHtml(await weeklyReportStatus(directory, id)), { mode: 0o600 });
  console.log(JSON.stringify({ id: report.id, validation: report.validation, path: join(directory, id, "report.json") }));
} else if (command === "verify") {
  const bundle = await loadWeeklyBundle(directory, id);
  console.log(JSON.stringify({ id, reproducible: true, blockers: evidenceGates(bundle) }));
} else throw new Error("Usage: node scripts/run-weekly-research.mjs collect|recollect [--production] | status [week-id] | verify week-id | finalize week-id analysis.json");
