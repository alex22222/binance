import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("radar release remaps only its five modules, keeps shared dependencies and leaves Bot source intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-radar-release-"));
  const source = join(directory, "bot");
  const release = join(directory, "release");
  await Promise.all([mkdir(join(source, "src"), { recursive: true }), mkdir(join(source, "scripts"), { recursive: true }), mkdir(join(release, "src"), { recursive: true })]);
  for (const name of ["btc-radar-loader.mjs", "btc-radar-hooks.mjs"]) {
    await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(source, "scripts", name));
  }
  const original = 'export const identity = "legacy";';
  await writeFile(join(source, "src", "btc-radar-html.mjs"), original);
  await writeFile(join(source, "src", "btc-radar-risk.mjs"), 'export const risk = "legacy-risk";');
  await writeFile(join(source, "src", "site-shell.mjs"), 'export const shared = "original-shared";');
  await writeFile(join(release, "src", "btc-radar-risk.mjs"), 'export const risk = "new-risk";');
  await writeFile(join(release, "src", "site-shell.mjs"), 'throw new Error("must not load copied shared code");');
  await writeFile(join(release, "src", "btc-radar-html.mjs"), 'import {risk} from "./btc-radar-risk.mjs"; import {shared} from "./site-shell.mjs"; import {createHash} from "node:crypto"; export const identity = `new/${risk}/${shared}/${typeof createHash}`;');
  const current = join(directory, "current");
  await symlink(release, current);
  const run = (root) => spawnSync(process.execPath, ["--import", "./scripts/btc-radar-loader.mjs", "--input-type=module", "-e",
    'import {identity} from "./src/btc-radar-html.mjs"; console.log(identity);'], {
    cwd: source, env: { ...process.env, BTC_RADAR_CODE_ROOT: root }, encoding: "utf8", timeout: 10_000
  });
  const isolated = run(current);
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.equal(isolated.stdout.trim(), "new/new-risk/original-shared/function");
  assert.equal(await readFile(join(source, "src", "btc-radar-html.mjs"), "utf8"), original);
  assert.equal(run("").stdout.trim(), "legacy");
  assert.notEqual(run(join(directory, "missing")).status, 0, "a configured missing release must fail closed");
});
