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

test("trade review timer runs after both daylight and standard-time market close", async () => {
  const [service, timer] = await Promise.all([
    readFile(new URL("../deploy/binance-agentic-trade-review.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/binance-agentic-trade-review.timer", import.meta.url), "utf8")
  ]);

  assert.match(service, /ExecStart=\/usr\/bin\/node scripts\/run-trade-review\.mjs/);
  assert.match(service, /ReadWritePaths=\/opt\/binance-agentic-stock-bot\/state/);
  assert.match(timer, /OnCalendar=Mon\.\.Fri \*-\*-\* 22:15:00 UTC/);
  assert.match(timer, /Persistent=true/);
});

test("premarket timer covers daylight and standard time without changing execution", async () => {
  const [service, timer] = await Promise.all([
    readFile(new URL("../deploy/binance-agentic-premarket-brief.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/binance-agentic-premarket-brief.timer", import.meta.url), "utf8")
  ]);

  assert.match(service, /ExecStart=\/usr\/bin\/node scripts\/run-premarket-brief\.mjs/);
  assert.match(service, /ReadWritePaths=\/opt\/binance-agentic-stock-bot\/state/);
  assert.match(timer, /OnCalendar=Mon\.\.Fri \*-\*-\* 13:15:00 UTC/);
  assert.match(timer, /OnCalendar=Mon\.\.Fri \*-\*-\* 14:15:00 UTC/);
  assert.match(timer, /Persistent=true/);
});
