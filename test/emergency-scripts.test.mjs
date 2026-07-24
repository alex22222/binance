import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");

test("CLI emergency stop persists across restarts and resume requires explicit confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-emergency-cli-"));
  const configPath = join(directory, "config.json");
  const markerPath = join(directory, "EMERGENCY_STOP");
  await writeFile(configPath, JSON.stringify({
    emergencyStopFile: markerPath,
    emergencyStopHistoryDirectory: join(directory, "history"),
    processLockFile: join(directory, "bot.lock"),
    traceFile: join(directory, "trace.jsonl")
  }), "utf8");

  const stop = await execFileAsync(process.execPath, [
    resolve(projectRoot, "scripts", "emergency-stop.mjs"),
    "fault-injection"
  ], {
    env: { ...process.env, BOT_CONFIG: configPath }
  });
  assert.equal(JSON.parse(stop.stdout).emergencyStop, true);
  assert.match(await readFile(markerPath, "utf8"), /fault-injection/);

  await assert.rejects(() => execFileAsync(process.execPath, [
    resolve(projectRoot, "scripts", "emergency-resume.mjs")
  ], {
    env: { ...process.env, BOT_CONFIG: configPath }
  }), /--confirm/);

  const resume = await execFileAsync(process.execPath, [
    resolve(projectRoot, "scripts", "emergency-resume.mjs"),
    "--confirm"
  ], {
    env: { ...process.env, BOT_CONFIG: configPath }
  });
  assert.equal(JSON.parse(resume.stdout).emergencyStop, false);
});
