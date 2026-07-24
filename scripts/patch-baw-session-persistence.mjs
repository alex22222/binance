import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  readFile,
  realpath,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { patchBawSessionPersistence } from "../src/baw-session-patch.mjs";

const checkOnly = process.argv.includes("--check");
const globalNodeModules = execFileSync("/usr/local/bin/npm", ["root", "-g"], {
  encoding: "utf8"
}).trim();
const bawExecutable = process.env.BAW_CLI_PATH || join(
  globalNodeModules,
  "@binance",
  "agentic-wallet",
  "dist",
  "index.js"
);
const target = await realpath(bawExecutable);
const source = await readFile(target, "utf8");
const result = patchBawSessionPersistence(source);

if (checkOnly) {
  if (result.changed) {
    console.error(JSON.stringify({
      success: false,
      status: "PATCH_REQUIRED",
      target
    }));
    process.exit(1);
  }
  console.log(JSON.stringify({ success: true, status: "PATCH_PRESENT", target }));
  process.exit(0);
}

if (!result.changed) {
  console.log(JSON.stringify({ success: true, status: "ALREADY_PATCHED", target }));
  process.exit(0);
}

const fileStat = await stat(target);
const stamp = new Date().toISOString().replaceAll(":", "-");
const backup = `${target}.backup-before-session-persistence-${stamp}`;
const temporary = `${target}.tmp-${process.pid}`;
await copyFile(target, backup);
await chmod(backup, fileStat.mode);
await writeFile(temporary, result.source, { mode: fileStat.mode });
await rename(temporary, target);
console.log(JSON.stringify({
  success: true,
  status: "PATCH_APPLIED",
  target,
  backup
}));
