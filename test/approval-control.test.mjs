import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readApprovalControl, writeApprovalControl } from "../src/approval-control.mjs";

test("automatic approval defaults off and persists explicit changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "approval-control-"));
  const path = join(directory, "control.json");
  assert.equal((await readApprovalControl(path)).enabled, false);
  await writeApprovalControl(path, true);
  assert.equal((await readApprovalControl(path)).enabled, true);
});
