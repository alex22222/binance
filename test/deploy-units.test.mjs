import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("post-close Shadow outcomes refresh independently from validation failures", async () => {
  const [validationUnit, shadowUnit, shadowTimer] = await Promise.all([
    readFile(new URL("../deploy/binance-agentic-strategy-validation.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/binance-agentic-shadow-outcomes.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/binance-agentic-shadow-outcomes.timer", import.meta.url), "utf8")
  ]);

  assert.match(validationUnit, /ExecStart=\/usr\/bin\/node scripts\/run-strategy-validation\.mjs/);
  assert.doesNotMatch(validationUnit, /run-shadow-outcomes/);
  assert.match(shadowUnit, /ExecStart=\/usr\/bin\/node scripts\/run-shadow-outcomes\.mjs/);
  assert.match(shadowUnit, /ReadWritePaths=\/opt\/binance-agentic-stock-bot\/state/);
  assert.match(shadowTimer, /OnCalendar=Mon\.\.Fri \*-\*-\* 22:25:00 UTC/);
  assert.match(shadowTimer, /Persistent=true/);
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

test("Turtle Paper runs independently without wallet or bot service access", async () => {
  const [service, timer] = await Promise.all([
    readFile(new URL("../deploy/binance-agentic-turtle-paper.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/binance-agentic-turtle-paper.timer", import.meta.url), "utf8")
  ]);
  assert.match(service, /ExecStart=\/usr\/bin\/node scripts\/run-turtle-paper\.mjs/);
  assert.match(service, /ReadWritePaths=\/opt\/binance-agentic-stock-bot\/state\/turtle-paper/);
  assert.doesNotMatch(service, /EnvironmentFile|BAW|BOT_LIVE/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(timer, /OnCalendar=Mon\.\.Fri/);
  assert.match(timer, /turtle-paper\.service/);
});
