import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activateEmergencyStop } from "../src/reliability.mjs";
import { createTracer } from "../src/trace.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = resolve(projectRoot, process.env.BOT_CONFIG || "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const markerPath = resolve(projectRoot, config.emergencyStopFile);
const lockPath = resolve(projectRoot, config.processLockFile);
const trace = createTracer(resolve(projectRoot, config.traceFile), { runId: randomUUID() });
const reason = process.argv.slice(2).join(" ").trim() || "operator";

await activateEmergencyStop(markerPath, { reason, requestedBy: "cli" });
let processSignalled = false;
try {
  const pid = Number((await readFile(lockPath, "utf8")).trim());
  if (Number.isInteger(pid) && pid > 1) {
    process.kill(pid, "SIGTERM");
    processSignalled = true;
  }
} catch (error) {
  if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
}
await trace("emergency_stop", "activated", { reason, processSignalled });
console.log(JSON.stringify({
  success: true,
  emergencyStop: true,
  reason,
  processSignalled
}));
