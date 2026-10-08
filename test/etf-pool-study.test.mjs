import assert from "node:assert/strict";
import test from "node:test";
import { runStudy, spliceDefensive, studySignal } from "../scripts/etf-pool-study.mjs";

function rows(prices) {
  return prices.map(([date, open, close]) => ({ date, prices: {
    QQQ: { open, close }, SGOV: { open: 100, close: 100 }
  } }));
}
const input = () => ({ rows: rows([
  ["2026-09-23", 98, 98], ["2026-09-24", 99, 99], ["2026-09-25", 100, 100],
  ["2026-09-28", 100, 100], ["2026-09-29", 100, 90], ["2026-09-30", 80, 80],
  ["2026-10-01", 80, 80]
]), risk: ["QQQ"], momentumDays: 2, rsiPeriod: 2, startDate: "2026-09-28", roundTripCostPct: 0 });

test("close-triggered stop executes on next open without rewriting the preceding equity", () => {
  const result = runStudy(input());
  assert.equal(result.equityCurve.find(r => r.date === "2026-09-29").equityUsd, 45);
  assert.equal(result.equityCurve.find(r => r.date === "2026-09-29").holding, "QQQ");
  const sell = result.trades.find(t => t.side === "SELL");
  assert.equal(sell.signalDate, "2026-09-29");
  assert.equal(sell.date, "2026-09-30");
  assert.equal(sell.price, 80);
  assert.equal(result.metrics.endingEquityUsd, 40);
  assert.equal(result.metrics.maxDrawdownPct, 20);
});

test("unseen next-day price cannot change today's equity or today's decisions", () => {
  const a = input(), b = input(); b.rows[5].prices.QQQ.open = 10;
  const left = runStudy(a), right = runStudy(b);
  assert.deepEqual(left.equityCurve.slice(0, 2), right.equityCurve.slice(0, 2));
  assert.deepEqual(left.decisions, right.decisions);
  assert.notEqual(left.metrics.endingEquityUsd, right.metrics.endingEquityUsd);
});

test("35bps round trip is 17.5bps each side; fixed Gas is additive, not charged twice", () => {
  const result = runStudy({ ...input(), roundTripCostPct: 0.35, gasPerSideUsd: 0.02 });
  const [buy, sell] = result.trades;
  assert.ok(Math.abs(buy.spreadCostUsd - 50 * 0.00175) < 1e-12);
  assert.equal(buy.gasUsd, 0.02);
  assert.ok(Math.abs(buy.costUsd - (50 * 0.00175 + 0.02)) < 1e-12);
  assert.ok(Math.abs(sell.spreadCostUsd - sell.notionalUsd * 0.00175) < 1e-12);
  assert.equal(result.metrics.totalCostUsd, buy.costUsd + sell.costUsd);
  assert.ok(Math.abs(result.metrics.endingEquityUsd - (sell.notionalUsd - sell.costUsd)) < 1e-10);
});

test("fixed ticket cap leaves profits in cash and ledger reconstructs equity", () => {
  const config = input(); config.initialCapitalUsd = 100; config.maxTicketUsd = 50;
  const result = runStudy(config);
  assert.equal(result.trades[0].notionalUsd, 50);
  assert.equal(result.trades[0].cashAfterUsd, 50);
  assert.equal(result.metrics.endingEquityUsd, 90);
  assert.ok(result.equityCurve.every(r => Math.abs(r.equityUsd - r.cashUsd - r.units * r.markPrice) < 1e-9));
});

test("proxy splice preserves proxy returns and never fabricates pre-inception rows", () => {
  const proxy = [{ date: "2020-05-29", open: 99, close: 99 }, { date: "2020-06-01", open: 100, close: 100 }];
  const actual = [{ date: "2020-06-01", open: 200, close: 200 }];
  const result = spliceDefensive(actual, proxy);
  assert.equal(result.length, 2);
  assert.equal(result[0].close, 198);
  assert.equal(result[1].close / result[0].close, 100 / 99);
  assert.throws(() => spliceDefensive(actual, proxy.slice(0, 1)), /overlap/);
});

test("long lookback refuses synthetic warmup and monthly decisions use prior closes", () => {
  assert.throws(() => studySignal(input().rows, 3, ["QQQ"], 252, 14), /history/);
  const result = runStudy({ ...input(), frequency: "M", disasterPct: null });
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].date, "2026-10-01");
  assert.equal(result.decisions[0].signalDate, "2026-09-30");
  assert.equal(result.decisions[0].target, "CASH");
});

test("defensive holdings also receive stop protection and last-day signals do not create future fills", () => {
  const config = input();
  for (let i = 0; i < config.rows.length; i++) {
    config.rows[i].prices.SGOV = config.rows[i].prices.QQQ;
    config.rows[i].prices.QQQ = { open: 100, close: 100 };
  }
  const result = runStudy(config);
  assert.equal(result.trades.find(t => t.side === "SELL").ticker, "SGOV");
  const truncated = runStudy({ ...input(), rows: input().rows.slice(0, 5) });
  assert.equal(truncated.trades.length, 1);
  assert.equal(truncated.pendingExit.signalDate, "2026-09-29");
});

for (const [frequency, dates] of [
  ["W", ["2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-12", "2026-10-13"]],
  ["M", ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-30", "2026-11-02", "2026-11-03", "2026-12-01", "2026-12-02"]]
]) test(`${frequency} stop on next period open blocks that period and permits a later decision`, () => {
  const values = [98, 99, 100, 100, 90, 80, 110, 110, 110];
  const result = runStudy({ ...input(), frequency, startDate: dates[3],
    rows: rows(dates.map((date, i) => [date, values[i], values[i]])) });
  assert.equal(result.trades.find(t => t.side === "SELL").date, dates[5]);
  assert.ok(!result.decisions.some(d => d.date === dates[5]));
  assert.deepEqual(result.trades.filter(t => t.side === "BUY").map(t => t.date), [dates[3], dates[7]]);
});

test("same target remains invested without repeat costs; asset change charges both legs", () => {
  const source = input().rows.slice(0, 4);
  source.push({ date: "2026-10-05", prices: { QQQ: { open: 110, close: 110 }, SGOV: { open: 100, close: 100 } } });
  source.push({ date: "2026-10-06", prices: { QQQ: { open: 110, close: 110 }, SGOV: { open: 100, close: 100 } } });
  const same = runStudy({ ...input(), rows: source, roundTripCostPct: 0.35, disasterPct: null });
  assert.equal(same.decisions.length, 2);
  assert.equal(same.trades.length, 1);
  source[4].prices.QQQ.close = 90; source[5].prices.QQQ.close = 90;
  source[4].prices.SGOV.close = 101; source[5].prices.SGOV.close = 102;
  source.push({ date: "2026-10-12", prices: { QQQ: { open: 90, close: 90 }, SGOV: { open: 103, close: 103 } } });
  const changed = runStudy({ ...input(), rows: source, roundTripCostPct: 0.35, disasterPct: null });
  assert.deepEqual(changed.trades.map(t => t.side), ["BUY", "SELL", "BUY"]);
  assert.equal(changed.trades.at(-1).ticker, "SGOV");
  assert.equal(changed.trades[1].date, changed.trades[2].date);
  assert.ok(changed.trades[1].costUsd > 0 && changed.trades[2].costUsd > 0);
});
