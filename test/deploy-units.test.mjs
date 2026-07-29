import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("post-close validation also refreshes non-executing Shadow outcomes", async () => {
  const unit = await readFile(
    new URL("../deploy/binance-agentic-strategy-validation.service", import.meta.url),
    "utf8"
  );

  assert.match(unit, /ExecStart=\/usr\/bin\/node scripts\/run-strategy-validation\.mjs/);
  assert.match(unit, /ExecStartPost=\/usr\/bin\/node scripts\/run-shadow-outcomes\.mjs/);
});
