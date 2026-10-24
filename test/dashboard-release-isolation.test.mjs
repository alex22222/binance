import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stageDashboardRelease, sourceIdentity } from "../ops/dashboard-release/stage.mjs";
import { decideRenewal, digest } from "../ops/auth-renewal/core.mjs";
import { verifyPersonalAssetsRelease } from "../ops/personal-assets/dashboard-loader.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const code = ["dashboard-loader.mjs", "dashboard-hooks.mjs", "src/personal-assets-client.mjs",
  "src/personal-assets-core.mjs", "src/personal-assets-html.mjs", "src/personal-assets-routes.mjs",
  "src/personal-assets.mjs", "src/site-shell.mjs", "src/personal-assets-sync.mjs",
  "src/personal-assets-okx.mjs", "src/personal-assets-futu.mjs", "src/personal-assets-fx.mjs",
  "src/personal-assets-polymarket.mjs", "src/personal-assets-wallets.mjs",
  "src/personal-assets-ai.mjs", "src/personal-assets-funds.mjs"];
const supportingFiles = ["README.md", "docs/personal-assets-page.md",
  "scripts/sync-personal-assets.mjs", "scripts/snapshot-personal-assets.mjs",
  "deploy/binance-personal-assets-sync.service", "deploy/binance-personal-assets-sync.timer",
  "deploy/binance-personal-assets-daily-snapshot.service", "deploy/binance-personal-assets-daily-snapshot.timer"];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dashboard-release-isolation-"));
  const projectRoot = join(dir, "bot"), source = join(dir, "payload"), destination = join(dir, "ui/releases/v2");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src/strategy.mjs"), "export const rule = 'unchanged';\n");
  await writeFile(join(projectRoot, "src/site-shell.mjs"), "export const nav = ['/'];\n");
  const manifest = { schemaVersion: 1, files: {} };
  for (const file of code) {
    const text = file === "src/site-shell.mjs" ? "export const nav = ['/', '/assets'];\n" : "export const page = 'assets';\n";
    await writeFile(join(source, file), text);
    manifest.files[file] = hash(text);
  }
  await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
  return { dir, projectRoot, source, destination, manifest, expectedCodeHash: await sourceIdentity(projectRoot) };
}

async function fullFixture() {
  const x = await fixture();
  const ocr = ["NOTICE.txt", "tesseract.min.js", "tesseract.min.js.LICENSE.txt", "worker.min.js", "worker.min.js.LICENSE.txt",
    "core/LICENSE", "core/tesseract-core-lstm.wasm.js", "core/tesseract-core-relaxedsimd-lstm.wasm.js", "core/tesseract-core-simd-lstm.wasm.js",
    "lang/chi_sim.traineddata.gz", "lang/chi_tra.traineddata.gz", "lang/eng.traineddata.gz"];
  const tests = (await readdir(new URL("../test/", import.meta.url))).filter(name => /^personal-assets[a-zA-Z0-9.-]*\.test\.mjs$/.test(name));
  for (const file of [...code, ...supportingFiles, ...ocr.map(name => `assets/personal-assets/ocr/${name}`), ...tests.map(name => `test/${name}`)]) {
    const original = file.startsWith("dashboard-") ? `ops/personal-assets/${file}` : file;
    const bytes = await readFile(new URL(`../${original}`, import.meta.url));
    await mkdir(dirname(join(x.source, file)), { recursive: true });
    await writeFile(join(x.source, file), bytes);
    x.manifest.files[file] = hash(bytes);
  }
  await writeFile(join(x.source, "manifest.json"), JSON.stringify(x.manifest));
  return x;
}

function decision(codeHash, expected) {
  const nowMs = Date.parse("2026-10-24T11:00:00Z");
  const policy = { schemaVersion: 1, strategyId: "weekly-etf-dual-momentum-defense", consentedBy: "henry", policyId: "fixed",
    enabled: true, startsAt: "2026-10-22T04:00:49.002Z", hardDeadline: "2026-11-21T04:00:49.002Z",
    codeHash: expected, identityHash: "I", configHash: digest({}), controlHash: digest({ strategyId: "weekly-etf-dual-momentum-defense" }), approvalControlHash: "A" };
  const grant = { strategyId: policy.strategyId, type: "EXPERIMENTAL_EXCEPTION", expiresAt: "2026-10-29T02:36:49.374Z" };
  return decideRenewal({ policy, state: { schemaVersion: 1, policyHash: digest(policy), expectedGrantHash: digest(grant), generation: 0 },
    runtime: { codeHash, identity: { identityHash: "I" }, config: {}, control: { strategyId: policy.strategyId },
      approvalControlHash: "A", heartbeatAt: new Date(nowMs).toISOString() }, registry: { schemaVersion: 1, authorizations: [grant] },
    nowMs, evaluate: () => ({ allowed: true }) });
}

test("reproduces incident: navigation alone or a newly added page changes the original identity and halts renewal", async () => {
  for (const file of ["site-shell.mjs", "personal-assets.mjs"]) {
    const x = await fixture();
    assert.equal(decision(x.expectedCodeHash, x.expectedCodeHash).action, "KEEP");
    await writeFile(join(x.projectRoot, "src", file), "export const page = 'new non-trading page';\n");
    assert.equal(decision(await sourceIdentity(x.projectRoot), x.expectedCodeHash).reason, "CODE_OR_IDENTITY_CHANGED");
  }
});

test("isolated UI staging keeps source bytes and renewal identity unchanged, including navigation updates", async () => {
  const x = await fixture();
  const before = await sourceIdentity(x.projectRoot);
  const result = await stageDashboardRelease(x);
  assert.equal(await sourceIdentity(x.projectRoot), before);
  assert.equal(decision(await sourceIdentity(x.projectRoot), x.expectedCodeHash).action, "KEEP");
  assert.equal(result.liveCodeHash, before);
  assert.deepEqual(await readdir(join(x.projectRoot, "src")), ["site-shell.mjs", "strategy.mjs"]);
  assert.equal(await readFile(join(x.destination, "src/site-shell.mjs"), "utf8"), "export const nav = ['/', '/assets'];\n");
  assert.equal(await readFile(join(x.projectRoot, "src/site-shell.mjs"), "utf8"), "export const nav = ['/'];\n");
  assert.equal((await lstat(x.destination)).mode & 0o022, 0);
});

test("the complete personal-assets package passes dry run, stages and verifies with the current loader", async () => {
  const x = await fullFixture();
  const files = Object.keys(x.manifest.files);
  assert.ok(files.length >= 50, "include the full release, not only the original page modules");
  const checked = await stageDashboardRelease({ ...x, checkOnly: true });
  assert.equal(checked.files, files.length);
  await assert.rejects(lstat(x.destination), { code: "ENOENT" });
  const result = await stageDashboardRelease(x);
  assert.equal(result.files, files.length);
  for (const file of [...files, "manifest.json"]) {
    assert.deepEqual(await readFile(join(x.destination, file)), await readFile(join(x.source, file)));
  }
  const verified = await verifyPersonalAssetsRelease(x.destination, {
    metadata: async path => Object.assign(await lstat(path), { uid: 0 })
  });
  assert.equal(verified.root, await realpath(x.destination));
  assert.equal(await sourceIdentity(x.projectRoot), x.expectedCodeHash);
  assert.equal(decision(await sourceIdentity(x.projectRoot), x.expectedCodeHash).action, "KEEP");
});

test("every module required by the current assets loader must be present before staging", async () => {
  for (const file of code) {
    const x = await fixture();
    delete x.manifest.files[file];
    await writeFile(join(x.source, "manifest.json"), JSON.stringify(x.manifest));
    await assert.rejects(stageDashboardRelease(x), /missing required/i);
    await assert.rejects(lstat(x.destination), { code: "ENOENT" });
  }
});

test("supporting scripts, unit templates and documentation remain hash-checked before any write", async () => {
  for (const file of supportingFiles) {
    const x = await fixture();
    await mkdir(dirname(join(x.source, file)), { recursive: true });
    await writeFile(join(x.source, file), "tampered");
    x.manifest.files[file] = hash("expected");
    await writeFile(join(x.source, "manifest.json"), JSON.stringify(x.manifest));
    await assert.rejects(stageDashboardRelease(x), /hash mismatch/i);
    await assert.rejects(lstat(x.destination), { code: "ENOENT" });
    assert.equal(await sourceIdentity(x.projectRoot), x.expectedCodeHash);
  }
});

test("rejects original incident's direct-to-live destination before writing even one file", async () => {
  const x = await fixture();
  for (const destination of [x.projectRoot, join(x.projectRoot, "src"), join(x.projectRoot, "ui/release")]) {
    await assert.rejects(stageDashboardRelease({ ...x, destination }), /protected|outside/i);
    assert.equal(await sourceIdentity(x.projectRoot), x.expectedCodeHash);
  }
});

test("an external path symlinked into production cannot bypass isolation", async () => {
  const x = await fixture(), alias = join(x.dir, "alias");
  await symlink(x.projectRoot, alias);
  await assert.rejects(stageDashboardRelease({ ...x, destination: join(alias, "new-ui") }), /protected|symlink/i);
  assert.equal(await sourceIdentity(x.projectRoot), x.expectedCodeHash);
});

test("trade changes remain protected; no UI-only release accepts or rebinds changed trading code", async () => {
  for (const change of ["modify", "add", "remove"]) {
    const x = await fixture();
    if (change === "remove") {
      const { unlink } = await import("node:fs/promises");
      await unlink(join(x.projectRoot, "src/strategy.mjs"));
    } else await writeFile(join(x.projectRoot, "src", change === "add" ? "new-risk-rule.mjs" : "strategy.mjs"), "export const risk = 'changed';\n");
    const changedHash = await sourceIdentity(x.projectRoot);
    assert.equal(decision(changedHash, x.expectedCodeHash).reason, "CODE_OR_IDENTITY_CHANGED");
    await assert.rejects(stageDashboardRelease(x), /identity|changed/i);
    await assert.rejects(lstat(x.destination), { code: "ENOENT" });
  }
});

test("all payload paths and hashes are checked before writes; trade, credential and traversal paths fail closed", async () => {
  for (const file of ["src/strategy.mjs", "src/extra-page.mjs", "state/private.json", "strategy-governance/authorizations.json", "config.json", ".env",
    "scripts/run-monthly-trend-research.mjs", "scripts/sync-personal-assets-extra.mjs", "ops/auth-renewal/run.mjs",
    "deploy/binance-agentic-stock-bot.service", "deploy/binance-personal-assets-sync.service.d/override.conf",
    "../escape.mjs", "/absolute.mjs", "src/../strategy.mjs"]) {
    const x = await fixture();
    x.manifest.files[file] = "a".repeat(64);
    await writeFile(join(x.source, "manifest.json"), JSON.stringify(x.manifest));
    await assert.rejects(stageDashboardRelease(x), /payload|path|module/i);
    await assert.rejects(lstat(x.destination), { code: "ENOENT" });
    assert.equal(await sourceIdentity(x.projectRoot), x.expectedCodeHash);
  }
  const x = await fixture();
  await writeFile(join(x.source, "src/site-shell.mjs"), "tampered");
  await assert.rejects(stageDashboardRelease(x), /hash/i);
  await assert.rejects(lstat(x.destination), { code: "ENOENT" });
});

test("dry run does not publish, overwrite an existing release or follow a payload symlink", async () => {
  const x = await fixture();
  await stageDashboardRelease({ ...x, checkOnly: true });
  await assert.rejects(lstat(x.destination), { code: "ENOENT" });
  await stageDashboardRelease(x);
  await assert.rejects(stageDashboardRelease(x), /exist/i);
  const empty = await fixture();
  await mkdir(empty.destination, { recursive: true });
  await assert.rejects(stageDashboardRelease(empty), /exist/i);
  assert.deepEqual(await readdir(empty.destination), []);
  const y = await fixture();
  const { unlink } = await import("node:fs/promises");
  await unlink(join(y.source, "src/site-shell.mjs"));
  await symlink(join(y.projectRoot, "src/site-shell.mjs"), join(y.source, "src/site-shell.mjs"));
  await assert.rejects(stageDashboardRelease(y), /symlink|type/i);
  assert.equal(await sourceIdentity(y.projectRoot), y.expectedCodeHash);
});

test("the CLI validates its arguments even when invoked through a current symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-stage-cli-"));
  const link = join(directory, "current.mjs");
  await symlink(new URL("../ops/dashboard-release/stage.mjs", import.meta.url), link);
  const child = spawnSync(process.execPath, [link], { encoding: "utf8", timeout: 10000 });
  assert.notEqual(child.status, 0, "a symlink entry must not silently skip the CLI and report success");
  assert.match(child.stderr, /Use as root: node stage\.mjs/);
});

test("importing the staging API from stdin does not execute the production CLI", () => {
  const module = new URL("../ops/dashboard-release/stage.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: `await import(${JSON.stringify(module)}); console.log("imported");`, encoding: "utf8", timeout: 10000
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "imported");
});
