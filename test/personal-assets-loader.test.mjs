import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { verifyPersonalAssetsRelease } from "../ops/personal-assets/dashboard-loader.mjs";
import { initialize, resolve as resolveAssetModule } from "../ops/personal-assets/dashboard-hooks.mjs";

const modules = ["personal-assets-core.mjs", "personal-assets.mjs", "personal-assets-html.mjs", "personal-assets-client.mjs", "personal-assets-routes.mjs", "site-shell.mjs", "personal-assets-sync.mjs", "personal-assets-okx.mjs", "personal-assets-futu.mjs", "personal-assets-fx.mjs", "personal-assets-polymarket.mjs", "personal-assets-wallets.mjs", "personal-assets-ai.mjs"];
const codeFiles = ["dashboard-loader.mjs", "dashboard-hooks.mjs", ...modules.map((name) => `src/${name}`)];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const urlDirectory = (path) => pathToFileURL(path + sep).href;
const rootMetadata = async (path) => Object.assign(await lstat(path), { uid: 0 });

async function temporary(context) {
  const directory = await mkdtemp(join(tmpdir(), "personal-assets-loader-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

async function fixture(context) {
  const root = await temporary(context);
  await mkdir(join(root, "src"));
  for (const name of codeFiles) {
    if (name.startsWith("src/")) await writeFile(join(root, name), 'export const marker = "fixture";');
    else await copyFile(new URL(`../ops/personal-assets/${name}`, import.meta.url), join(root, name));
  }
  const manifest = { schemaVersion: 1, files: {} };
  for (const name of codeFiles) manifest.files[name] = hash(await readFile(join(root, name)));
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, manifest };
}

test("asset resolver maps only the thirteen approved modules and preserves outside imports", async () => {
  const source = "file:///original/src/";
  const release = "file:///release/src/";
  initialize({ source, release });
  const next = async (specifier) => ({ url: specifier });
  for (const name of modules) {
    assert.equal((await resolveAssetModule(`../src/${name}`, { parentURL: "file:///original/scripts/dashboard.mjs" }, next)).url, release + name);
    assert.equal((await resolveAssetModule(source + name, { parentURL: source + "original.mjs" }, next)).url, release + name);
    assert.equal((await resolveAssetModule(`./${name}`, { parentURL: release + "personal-assets-routes.mjs" }, next)).url, release + name);
  }
  for (const specifier of ["./bot.mjs", "./personal-assets-extra.mjs", "node:fs", "some-package", "file:///outside/src/site-shell.mjs", source + "site-shell.mjs?version=other"]) {
    assert.equal((await resolveAssetModule(specifier, { parentURL: source + "original.mjs" }, next)).url, specifier);
  }
  assert.equal((await resolveAssetModule("./shared.mjs", { parentURL: release + "personal-assets.mjs" }, next)).url, source + "shared.mjs");
  assert.equal((await resolveAssetModule("../scripts/helper.mjs", { parentURL: release + "personal-assets.mjs" }, next)).url, "file:///original/scripts/helper.mjs");
  const otherRelease = { parentURL: "file:///radar-release/src/btc-radar-html.mjs" };
  const afterRadar = async (specifier) => ({ url: specifier === "./site-shell.mjs" ? source + "site-shell.mjs" : specifier });
  assert.equal((await resolveAssetModule("./site-shell.mjs", otherRelease, afterRadar)).url, release + "site-shell.mjs");
});

test("release verifies all fifteen code hashes and permits a root-owned current symlink", async (context) => {
  const { root } = await fixture(context);
  const verified = await verifyPersonalAssetsRelease(root, { metadata: rootMetadata });
  assert.equal(verified.root, root);
  assert.equal(verified.release, urlDirectory(join(root, "src")));
  assert.equal(verified.source, "file:///opt/binance-agentic-stock-bot/src/");
  assert.equal(verified.loaderURL, pathToFileURL(join(root, "dashboard-loader.mjs")).href);
  const link = join(await temporary(context), "current");
  await symlink(root, link);
  assert.equal((await verifyPersonalAssetsRelease(link, { metadata: rootMetadata })).root, root);
  await assert.rejects(verifyPersonalAssetsRelease(link, { metadata: async (path) => {
    const info = await rootMetadata(path);
    return path === link ? Object.assign(info, { uid: 501 }) : info;
  } }), /root|own/i);
  for (const name of codeFiles) {
    const path = join(root, name);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("\n")]));
    await assert.rejects(verifyPersonalAssetsRelease(root, { metadata: rootMetadata }), /hash mismatch/i);
    await writeFile(path, original);
  }
});

test("unsafe ownership, write permissions, file symlinks and missing manifest hashes fail closed", async (context) => {
  const { root, manifest } = await fixture(context);
  for (const path of [root, join(root, "src"), join(root, "manifest.json"), ...codeFiles.map((name) => join(root, name))]) {
    for (const override of [{ uid: 501 }, { mode: 0o100666 }]) {
      await assert.rejects(verifyPersonalAssetsRelease(root, { metadata: async (candidate) => {
        const info = await rootMetadata(candidate);
        return candidate === path ? Object.assign(info, override) : info;
      } }), /root|own|permission/i);
    }
  }
  const path = join(root, "src", "personal-assets-core.mjs");
  const copied = join(root, "copied-core.mjs");
  await copyFile(path, copied);
  await rm(path);
  await symlink(copied, path);
  await assert.rejects(verifyPersonalAssetsRelease(root, { metadata: rootMetadata }), /type|permission/i);
  await rm(path);
  await copyFile(copied, path);
  delete manifest.files["dashboard-hooks.mjs"];
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyPersonalAssetsRelease(root, { metadata: rootMetadata }), /manifest hash/i);
});

test("loader never activates for a Bot or another Dashboard entry despite configured code root", async (context) => {
  const directory = await temporary(context);
  const loader = new URL("../ops/personal-assets/dashboard-loader.mjs", import.meta.url).href;
  const program = `await import(${JSON.stringify(loader)}); console.log("unchanged");`;
  for (const name of ["bot.mjs", "serve-live-dashboard.mjs"]) {
    const entry = join(directory, name);
    await writeFile(entry, program);
    const child = spawnSync(process.execPath, ["--import", loader, entry], {
      env: { ...process.env, PERSONAL_ASSETS_CODE_ROOT: join(directory, "missing") }, encoding: "utf8", timeout: 10_000
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "unchanged");
  }
});

test("child process resolves released assets and shell while shared code and source stay intact", async (context) => {
  const directory = await temporary(context);
  const source = join(directory, "bot", "src");
  const release = join(directory, "release", "src");
  const radar = join(directory, "radar", "src");
  await mkdir(source, { recursive: true });
  await mkdir(release, { recursive: true });
  await mkdir(radar, { recursive: true });
  for (const name of modules) {
    await writeFile(join(source, name), `export const marker = ${JSON.stringify("original/" + name)};`);
    await writeFile(join(release, name), `export const marker = ${JSON.stringify("released/" + name)};`);
  }
  await writeFile(join(source, "shared.mjs"), 'export const marker = "original-shared";');
  await writeFile(join(release, "shared.mjs"), 'throw new Error("copied shared module must never execute");');
  await writeFile(join(release, "personal-assets-routes.mjs"), 'import {marker as model} from "./personal-assets.mjs"; import {marker as shell} from "./site-shell.mjs"; import {marker as shared} from "./shared.mjs"; export const marker = [model,shell,shared].join("|");');
  await writeFile(join(source, "btc-radar-html.mjs"), 'export const marker = "original-radar";');
  await writeFile(join(radar, "btc-radar-html.mjs"), 'import {marker} from "./site-shell.mjs"; export {marker};');
  const hook = new URL("../ops/personal-assets/dashboard-hooks.mjs", import.meta.url).href;
  const radarHook = new URL("../scripts/btc-radar-hooks.mjs", import.meta.url).href;
  const assetRegister = `register(${JSON.stringify(hook)}, {data:${JSON.stringify({ source: urlDirectory(source), release: urlDirectory(release) })}});`;
  const radarRegister = `register(${JSON.stringify(radarHook)}, {data:${JSON.stringify({ source: urlDirectory(source), release: urlDirectory(radar) })}});`;
  for (const registers of [[assetRegister, radarRegister], [radarRegister, assetRegister]]) {
    const program = `import { register } from "node:module";
    ${registers.join("\n")}
    const results = [];
    for (const name of ${JSON.stringify(modules)}) results.push((await import(${JSON.stringify(urlDirectory(source))} + name)).marker);
    results.push((await import(${JSON.stringify(pathToFileURL(join(source, "btc-radar-html.mjs")).href)})).marker);
    console.log(JSON.stringify(results));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result[4], "released/personal-assets.mjs|released/site-shell.mjs|original-shared");
    assert.equal(result[5], "released/site-shell.mjs");
    assert.equal(result[modules.length], "released/site-shell.mjs", "radar uses released shell in either hook registration order");
  }
  for (const name of modules) assert.equal(await readFile(join(source, name), "utf8"), `export const marker = ${JSON.stringify("original/" + name)};`);
});
