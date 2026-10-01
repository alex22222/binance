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

test("weekly ETF Paper runs independently without wallet or Live access", async () => {
  const [service, timer] = await Promise.all([
    readFile(new URL("../deploy/binance-agentic-weekly-etf-paper.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/binance-agentic-weekly-etf-paper.timer", import.meta.url), "utf8")
  ]);
  assert.match(service, /ExecStart=\/usr\/bin\/node scripts\/run-weekly-etf-rotation-paper\.mjs/);
  assert.match(service, /ReadWritePaths=\/opt\/binance-agentic-stock-bot\/state\/weekly-etf-rotation-paper/);
  assert.doesNotMatch(service, /EnvironmentFile|BAW|BOT_LIVE/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(timer, /OnCalendar=Mon\.\.Fri/);
  assert.match(timer, /weekly-etf-paper\.service/);
});

test("BTC risk radar runs every four hours with read-only state access and optional OKX credentials", async () => {
  const [service, timer, installer, environment] = await Promise.all([
    readFile(new URL("../deploy/binance-agentic-btc-radar.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/binance-agentic-btc-radar.timer", import.meta.url), "utf8"),
    readFile(new URL("../deploy/install-systemd.sh", import.meta.url), "utf8"),
    readFile(new URL("../deploy/binance-agentic-btc-radar.env.example", import.meta.url), "utf8")
  ]);
  assert.match(service, /ExecStart=\/usr\/bin\/node scripts\/run-btc-radar\.mjs/);
  assert.match(service, /EnvironmentFile=-\/etc\/binance-agentic-btc-radar\.env/);
  assert.match(service, /ReadWritePaths=\/opt\/binance-agentic-stock-bot\/state\/btc-radar\n/);
  assert.match(service, /ProtectSystem=strict/);
  assert.doesNotMatch(service, /BOT_LIVE|BAW/);
  assert.match(timer, /OnCalendar=\*-\*-\* 00\/4:43:00 UTC/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /Unit=binance-agentic-btc-radar\.service/);
  assert.match(installer, /"\$project_dir\/state\/btc-radar"/);
  assert.match(installer, /binance-agentic-btc-radar\.timer/);
  assert.match(environment, /READ-ONLY/);
});
