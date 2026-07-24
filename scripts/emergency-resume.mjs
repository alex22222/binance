import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearEmergencyStop } from "../src/reliability.mjs";
import { createTracer } from "../src/trace.mjs";

if (!process.argv.includes("--confirm")) {
  throw new Error("Emergency resume requires --confirm");
}

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = resolve(projectRoot, process.env.BOT_CONFIG || "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const markerPath = resolve(projectRoot, config.emergencyStopFile);
const historyDirectory = resolve(projectRoot, config.emergencyStopHistoryDirectory || "state/emergency-stop-history");
const archivedPath = await clearEmergencyStop(markerPath, historyDirectory);
const trace = createTracer(resolve(projectRoot, config.traceFile), { runId: randomUUID() });
await trace("emergency_stop", "cleared", {
  archived: Boolean(archivedPath),
  botRestarted: false
});
console.log(JSON.stringify({
  success: true,
  emergencyStop: false,
  archived: Boolean(archivedPath),
  botRestarted: false
}));
