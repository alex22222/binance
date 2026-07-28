import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeShadowOutcomeReport } from "../src/shadow-outcomes.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(
  await readFile(resolve(projectRoot, process.env.BOT_CONFIG || "config.json"), "utf8")
);
const outputPath = resolve(projectRoot, "state/shadow-outcomes/latest.json");
const report = await writeShadowOutcomeReport({
  marketDataDirectory: resolve(projectRoot, config.marketDataDirectory),
  outputPath
});

console.log(JSON.stringify({
  event: "shadow_outcomes_finished",
  outputPath,
  candidates: report.candidates,
  horizons: report.horizons
}, null, 2));
