#!/usr/local/bin/node

import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { buildBawEnvironment } from "../src/baw-runtime.mjs";

const realCliPath = process.env.BAW_REAL_CLI_PATH ||
  "/Users/henry/.npm-global/lib/node_modules/@binance/agentic-wallet/dist/index.js";
if (realpathSync(realCliPath) === realpathSync(process.argv[1])) {
  throw new Error("BAW_REAL_CLI_PATH resolves to the Keychain wrapper");
}

const instanceId = execFileSync("/usr/bin/security", [
  "find-generic-password",
  "-a",
  "henry",
  "-s",
  "binance-agentic-wallet-instance-id",
  "-w"
], { encoding: "utf8" }).trim();
const result = spawnSync(process.execPath, [
  realCliPath,
  ...process.argv.slice(2)
], {
  env: buildBawEnvironment({ environment: process.env, instanceId }),
  stdio: "inherit"
});

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
