import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as model from "../src/personal-assets.mjs";
import { nextAssetRefreshAt } from "../src/personal-assets-core.mjs";

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "asset-daily-schedule-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { stateDir, path: join(stateDir, "personal-assets-refresh.json") };
}
const before = new Date("2026-10-25T22:59:59Z"), due = new Date("2026-10-25T23:00:00Z");

test("refresh slots default to daily 07:00 Beijing and accept a configured minute across midnight", () => {
  assert.equal(nextAssetRefreshAt(before), due.toISOString());
  assert.equal(nextAssetRefreshAt(due), "2026-10-26T23:00:00.000Z");
  assert.equal(nextAssetRefreshAt("2026-10-25T23:01:00Z", "08:15"), "2026-10-26T00:15:00.000Z");
  for (const value of ["7:00", "24:00", "07:60", "07:00:00", null]) assert.throws(() => nextAssetRefreshAt(before, value));
});

test("daily refresh settings persist privately without writing financial or credential state", async t => {
  const { stateDir, path } = await fixture(t);
  const ledger = join(stateDir, "personal-assets.json"); await writeFile(ledger, "financial sentinel");
  const initial = await model.readAssetRefreshSchedule({ stateDir, now: before });
  assert.equal(initial.time, "07:00"); assert.equal(initial.timeZone, "Asia/Shanghai");
  assert.equal(initial.nextRunAt, due.toISOString()); assert.equal(initial.frequency, "daily");
  assert.deepEqual(await readdir(stateDir), ["personal-assets.json"]);
  const saved = await model.configureAssetRefreshSchedule({ stateDir, time: "08:15", now: before });
  assert.equal(saved.nextRunAt, "2026-10-26T00:15:00.000Z");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(ledger, "utf8"), "financial sentinel");
  const bytes = await readFile(path, "utf8");
  for (const time of ["", "7:00", "24:00", "07:60", {}, null]) {
    await assert.rejects(model.configureAssetRefreshSchedule({ stateDir, time, now: before }), { statusCode: 400 });
    assert.equal(await readFile(path, "utf8"), bytes);
  }
});

test("a daily run is claimed once under concurrency, including failure and changing the time later that day", async t => {
  const { stateDir } = await fixture(t);
  assert.equal(await model.claimAssetRefresh({ stateDir, now: before }), null);
  const claims = await Promise.all(Array.from({ length: 5 }, () => model.claimAssetRefresh({ stateDir, now: due })));
  const claim = claims.find(Boolean); assert.equal(claims.filter(Boolean).length, 1);
  await model.configureAssetRefreshSchedule({ stateDir, time: "21:00", now: due });
  await model.completeAssetRefresh({ stateDir, attemptedAt: claim.attemptedAt, failed: true, now: new Date(due.getTime() + 1000) });
  assert.equal(await model.claimAssetRefresh({ stateDir, now: new Date("2026-10-26T13:00:00Z") }), null);
  const status = await model.readAssetRefreshSchedule({ stateDir, now: due });
  assert.equal(status.time, "21:00"); assert.equal(status.nextRunAt, "2026-10-27T13:00:00.000Z");
  assert.ok(status.lastError); assert.ok(status.lastCompletedAt);
  const next = await model.claimAssetRefresh({ stateDir, now: new Date("2026-10-27T13:00:00Z") }); assert.ok(next);
  await assert.rejects(model.completeAssetRefresh({ stateDir, attemptedAt: claim.attemptedAt, now: new Date("2026-10-27T13:01:00Z") }), { statusCode: 409 });
});

test("corrupt, public or symlinked refresh settings fail closed before any daily claim", async t => {
  const { stateDir, path } = await fixture(t);
  await writeFile(path, "not json", { mode: 0o600 });
  await assert.rejects(model.claimAssetRefresh({ stateDir, now: due }), { statusCode: 500 });
  await rm(path); await model.configureAssetRefreshSchedule({ stateDir, time: "07:00", now: before });
  await chmod(path, 0o644); await assert.rejects(model.readAssetRefreshSchedule({ stateDir, now: due }), { statusCode: 500 });
  await rm(path); const target = join(stateDir, "other.json"); await writeFile(target, "untouched"); await symlink(target, path);
  await assert.rejects(model.configureAssetRefreshSchedule({ stateDir, time: "08:00", now: due }), { statusCode: 500 });
  assert.equal(await readFile(target, "utf8"), "untouched");
});

test("the collector skips all source and FX work after today's run has already been claimed", async t => {
  const { stateDir, path } = await fixture(t);
  const now = new Date(); await model.configureAssetRefreshSchedule({ stateDir, time: "00:00", now });
  assert.ok(await model.claimAssetRefresh({ stateDir, now }));
  const bytes = await readFile(path, "utf8");
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/sync-personal-assets.mjs"], {
    cwd: resolve("."), env: { ...process.env, PERSONAL_ASSETS_DIR: stateDir, PERSONAL_ASSETS_FX_DISABLED: "1" },
  });
  assert.equal(JSON.parse(stdout).skipped, true); assert.equal(await readFile(path, "utf8"), bytes);
  assert.deepEqual(await readdir(stateDir), ["personal-assets-refresh.json"]);
});
