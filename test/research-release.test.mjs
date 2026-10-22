import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hash = value => createHash("sha256").update(value).digest("hex");
const entry = "scripts/run-etf-frequency-paper.mjs";

test("frozen Paper dependencies survive Live updates without replacing its ledger or accepting changed code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-release-"));
  const live = join(directory, "live"), release = join(directory, "release");
  await mkdir(join(live, "scripts"), { recursive: true });
  await cp(new URL("../src/", import.meta.url), join(live, "src"), { recursive: true });
  await cp(new URL("../scripts/run-etf-frequency-paper.mjs", import.meta.url), join(live, entry));
  const execute = root => spawnSync(process.execPath, ["--input-type=module", "-e",
    'import {runFrequencyPaper} from "./scripts/run-etf-frequency-paper.mjs"; const state=await runFrequencyPaper({nowMs:Date.parse("2026-10-09T14:00:00Z"),fetchJson:()=>{throw new Error("unexpected network")}}); console.log(state.codeHash);'
  ], { cwd: root, encoding: "utf8", timeout: 10_000 });
  const initial = execute(live);
  assert.equal(initial.status, 0, initial.stderr);
  const stateDirectory = join(live, "state/etf-frequency-paper");
  const frozen = await readFile(join(stateDirectory, "specification.json"), "utf8");
  const ledger = JSON.parse(await readFile(join(stateDirectory, "latest.json")));
  await mkdir(join(release, "scripts"), { recursive: true });
  await cp(join(live, "src"), join(release, "src"), { recursive: true });
  await cp(join(live, entry), join(release, entry));
  await mkdir(join(release, "state"));
  await symlink(stateDirectory, join(release, "state/etf-frequency-paper"));
  await writeFile(join(live, "src/strategy.mjs"), (await readFile(join(live, "src/strategy.mjs"))) + "\n// subsequent Live release\n");
  assert.notEqual(execute(live).status, 0, "unisolated job must reject the changed shared module");
  const recovered = execute(release);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout.trim(), ledger.codeHash);
  assert.equal(await readFile(join(stateDirectory, "specification.json"), "utf8"), frozen);
  assert.deepEqual(JSON.parse(await readFile(join(stateDirectory, "latest.json"))).experiments, ledger.experiments);

  const { researchModuleDependencies, verifyResearchRelease } = await import("../scripts/verify-research-release.mjs");
  const queue = [entry], sources = {};
  while (queue.length) {
    const file = queue.shift();
    if (sources[file]) continue;
    const text = await readFile(join(release, file), "utf8");
    sources[file] = hash(text);
    for (const dependency of researchModuleDependencies(text, file)) queue.push(dependency);
  }
  await writeFile(join(release, "release.json"), JSON.stringify({ schemaVersion: 1, kind: "ETF_FREQUENCY_PAPER", entry, sources, paperCodeHash: ledger.codeHash }));
  assert.equal((await verifyResearchRelease(release)).paperCodeHash, ledger.codeHash);
  await cp(new URL("../scripts/verify-research-release.mjs", import.meta.url), join(release, "scripts/verify-research-release.mjs"));
  const current = join(directory, "current");
  await symlink(release, current);
  const paperUnit = await readFile(new URL("../deploy/binance-agentic-etf-frequency-paper.release.conf", import.meta.url), "utf8");
  const launchOptions = paperUnit.match(/ExecStartPre=\/usr\/bin\/node(.*?) \/opt/)[1].trim().split(" ").filter(Boolean);
  const throughCurrent = spawnSync(process.execPath, [...launchOptions, join(current, "scripts/verify-research-release.mjs")], { encoding: "utf8" });
  assert.equal(throughCurrent.status, 0, throughCurrent.stderr);
  assert.equal(JSON.parse(throughCurrent.stdout).paperCodeHash, ledger.codeHash, "symlink entry must actually verify the manifest, not silently exit zero");
  await writeFile(join(release, "src/strategy-signals.mjs"), "export const broken = true;\n");
  await assert.rejects(verifyResearchRelease(release), /hash mismatch/);
  assert.equal(await readFile(join(stateDirectory, "specification.json"), "utf8"), frozen);
  await assert.rejects(verifyResearchRelease(join(directory, "missing")), /ENOENT/);
});

test("separate Paper and validation units use closed releases without touching the Bot or enabling Live", async () => {
  const paper = await readFile(new URL("../deploy/binance-agentic-etf-frequency-paper.release.conf", import.meta.url), "utf8");
  const validation = await readFile(new URL("../deploy/binance-agentic-strategy-validation.release.conf", import.meta.url), "utf8");
  assert.match(paper, /WorkingDirectory=\/opt\/binance-agentic-etf-paper\/current/);
  assert.match(paper, /ExecStartPre=.*verify-research-release\.mjs/);
  assert.match(paper, /flock -n -E 75 \/opt\/binance-agentic-stock-bot\/state\/etf-frequency-paper\/runner\.lock/);
  assert.match(paper, /\/opt\/binance-agentic-etf-paper\/current\/scripts\/run-etf-frequency-paper\.mjs/);
  assert.match(validation, /WorkingDirectory=\/opt\/binance-agentic-validation\/current/);
  assert.match(validation, /ExecStartPre=.*verify-research-release\.mjs/);
  assert.match(validation, /BOT_CONFIG=\/opt\/binance-agentic-stock-bot\/config\.json/);
  assert.match(validation, /STRATEGY_VALIDATION_DIR=\/opt\/binance-agentic-stock-bot\/state\/strategy-validation/);
  assert.match(validation, /ReadWritePaths=\nReadWritePaths=\/opt\/binance-agentic-stock-bot\/state\/strategy-validation/);
  for (const unit of [paper, validation]) assert.doesNotMatch(unit, /EnvironmentFile|BOT_LIVE|stock-bot\.service|dashboard\.service/);
  for (const unit of [paper, validation]) assert.match(unit, /ExecStartPre=\/usr\/bin\/node --preserve-symlinks-main /);
  assert.match(paper, /runner\.lock \/usr\/bin\/node --preserve-symlinks-main /);
});

test("module closure rejects undeclared packages and imports that escape the release", async () => {
  const { researchModuleDependencies } = await import("../scripts/verify-research-release.mjs");
  assert.deepEqual(researchModuleDependencies('import {x} from "../src/a.mjs"; export {y} from "../src/b.mjs";', "scripts/run.mjs"), ["src/a.mjs", "src/b.mjs"]);
  assert.throws(() => researchModuleDependencies('import x from "../../../outside.mjs";', "src/a.mjs"), /escape/);
  assert.throws(() => researchModuleDependencies('import x from "unknown-package";', "src/a.mjs"), /Unsupported/);
});
