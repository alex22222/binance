#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hookModules, releaseFiles, supportingFiles } from "../ops/personal-assets/dashboard-release-files.mjs";

const payload = process.argv[2];
if (!payload) throw new Error("Usage: node scripts/prepare-dashboard-ui-payload.mjs <payload-dir>");

const root = fileURLToPath(new URL("..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

await mkdir(join(payload, "src"), { recursive: true });
for (const name of hookModules) {
  await cp(join(root, "src", name), join(payload, "src", name));
}
for (const name of ["dashboard-loader.mjs", "dashboard-hooks.mjs", "dashboard-release-files.mjs"]) {
  await cp(join(root, "ops/personal-assets", name), join(payload, name));
}
for (const file of supportingFiles) {
  try {
    await mkdir(dirname(join(payload, file)), { recursive: true });
    await cp(join(root, file), join(payload, file));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function walk(dir, prefix = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
    else {
      const dest = join(payload, "assets/personal-assets/ocr", rel);
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(dir, entry.name), dest);
    }
  }
}
await walk(join(root, "assets/personal-assets/ocr"));

const files = {};
async function hashWalk(dir, prefix = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await hashWalk(abs, rel);
    else if (entry.name !== "manifest.json") files[rel] = hash(await readFile(abs));
  }
}
await hashWalk(payload);
for (const file of releaseFiles) {
  if (!files[file]) throw new Error(`missing required ${file}`);
}
await writeFile(join(payload, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ payload, files: Object.keys(files).length }, null, 2)}\n`);
