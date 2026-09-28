import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { captureSavedEvidence } from "../src/strategy-evidence-store.mjs";
import { readEvidence } from "../src/strategy-governance.mjs";

test("captures distinct evidence without retroactively binding legacy reports or changing sources", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "evidence-capture-"));
  const path = join(projectRoot, "state/strategy-validation/latest.json");
  await mkdir(dirname(path), { recursive: true });
  const report = JSON.stringify({ generatedAt: "2026-09-02T10:00:00Z", historical: {
    dataCoverage: { to: "2026-07-24T20:00:00Z" }, assumptions: { roundTripCostPct: 1 },
    strategies: [{ id: "adaptive-momentum", performance: { pnlUsdt: -2, trades: 1 } },
      { id: "residual-reversal", performance: { pnlUsdt: 0, trades: 0 } }]
  } });
  await writeFile(path, report);
  const input = { projectRoot, config: { traceFile: "state/missing.jsonl" } };
  const first = await captureSavedEvidence(input);
  const second = await captureSavedEvidence(input);
  assert.equal(first.errors.length, 0);
  assert.deepEqual(first.evidenceIds, second.evidenceIds);
  const entries = await readEvidence(join(projectRoot, "state/strategy-evidence"));
  assert.equal(entries.length, 2);
  assert.ok(entries.every(({ record }) => record.identity === null && record.bindingStatus === "UNBOUND_LEGACY"));
  assert.ok(entries.some(({ record }) => record.payload.performance.pnlUsdt === -2));
  assert.ok(entries.some(({ record }) => record.payload.performance.trades === 0));
  assert.equal(entries[0].record.dataCutoff, "2026-07-24T20:00:00Z");
  assert.equal(await readFile(path, "utf8"), report);
  await writeFile(path, "{");
  assert.equal((await captureSavedEvidence(input)).errors.length, 1);
  assert.equal((await readEvidence(join(projectRoot, "state/strategy-evidence"))).length, 2);
});
