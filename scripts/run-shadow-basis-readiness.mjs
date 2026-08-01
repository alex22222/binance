import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildShadowBasisReadiness } from "../src/shadow-basis-readiness.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const marketDataDirectory = resolve(projectRoot, "state/market-data");
const outputPath = resolve(projectRoot, "state/shadow-basis-readiness/latest.json");

async function readMarketRecords(directory) {
  let files;
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const file of files) {
    const content = await readFile(resolve(directory, file), "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (["shadow_basis_decision", "shadow_basis_checkpoint"].includes(record.recordType)) {
        records.push(record);
      }
    }
  }
  return records;
}

const records = await readMarketRecords(marketDataDirectory);
const report = buildShadowBasisReadiness(records);
await mkdir(dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await rename(temporaryPath, outputPath);

console.log(JSON.stringify({
  event: "shadow_basis_readiness_finished",
  outputPath,
  samples: report.samples,
  modelResearchEligible: report.modelResearchEligible,
  strategyPromotionEligible: report.strategyPromotionEligible,
  automaticTradingEligible: report.automaticTradingEligible,
  blockers: report.modelResearchBlockers
}));
