import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceWeeklyEtfRotationPaper,
  initialWeeklyEtfRotationPaperState,
  weeklyEtfRotationAssets,
  weeklyEtfRotationSignal
} from "../src/weekly-etf-rotation-paper.mjs";

const riskTickers = ["QQQ", "IWM", "DGRW", "SPY"];

function dailySeries(closeAt, length = 30) {
  return Array.from({ length }, (_, index) => ({
    date: new Date(Date.parse("2026-01-01T00:00:00Z") + index * 86_400_000).toISOString().slice(0, 10),
    close: closeAt(index)
  }));
}

function signalSeries(closeByTicker) {
  return Object.fromEntries(riskTickers.map((ticker) => [ticker, dailySeries(closeByTicker[ticker])]));
}

test("selects the strongest weekly momentum candidate that passes RSI", () => {
  const signal = weeklyEtfRotationSignal(signalSeries({
    QQQ: (index) => 100 + index * 2,
    IWM: (index) => 100 + index,
    DGRW: (index) => 100 + index * 0.5,
    SPY: (index) => 150 - index
  }));

  assert.equal(signal.target, "QQQ");
  assert.equal(signal.candidates.length, 3);
  assert.equal(signal.allRiskAssets.find(({ ticker }) => ticker === "SPY").eligible, false);
});

test("uses IEI when every risk ETF is below the RSI threshold", () => {
  const signal = weeklyEtfRotationSignal(signalSeries(Object.fromEntries(
    riskTickers.map((ticker, tickerIndex) => [ticker, (index) => 200 - index * (tickerIndex + 1)])
  )));

  assert.equal(signal.target, "IEI");
  assert.equal(signal.candidates.length, 0);
});

test("charges costs only on actual weekly transactions", () => {
  const initial = initialWeeklyEtfRotationPaperState("2026-09-14T13:31:00.000Z", 50);
  const opened = advanceWeeklyEtfRotationPaper(initial, {
    at: "2026-09-14T13:31:00.000Z",
    sessionDate: "2026-09-14",
    week: "2026-09-14",
    regularOpen: true,
    decision: { signalDate: "2026-09-11", target: "QQQ", candidates: [] },
    prices: { QQQ: 100 }
  }, { roundTripCostPct: 1 });

  assert.equal(opened.state.position.symbol, "QQQ");
  assert.equal(opened.state.position.quantity, 0.4975);
  assert.equal(opened.state.totalCostUsdt, 0.25);

  const repeated = advanceWeeklyEtfRotationPaper(opened.state, {
    at: "2026-09-14T14:01:00.000Z",
    sessionDate: "2026-09-14",
    week: "2026-09-14",
    regularOpen: true,
    decision: { signalDate: "2026-09-11", target: "QQQ", candidates: [] },
    prices: { QQQ: 101 }
  }, { roundTripCostPct: 1 });

  assert.equal(repeated.state.totalCostUsdt, 0.25);
  assert.equal(repeated.state.trades.length, 0);
  assert.equal(repeated.events.at(-1).type, "PAPER_WEEK_ALREADY_EVALUATED");
});

test("switches the full Paper portfolio and reconciles both transaction sides", () => {
  const initial = initialWeeklyEtfRotationPaperState("2026-09-14T13:31:00.000Z", 50);
  const opened = advanceWeeklyEtfRotationPaper(initial, {
    at: "2026-09-14T13:31:00.000Z",
    sessionDate: "2026-09-14",
    week: "2026-09-14",
    regularOpen: true,
    decision: { signalDate: "2026-09-11", target: "QQQ", candidates: [] },
    prices: { QQQ: 100 }
  }, { roundTripCostPct: 1 }).state;

  const switched = advanceWeeklyEtfRotationPaper(opened, {
    at: "2026-09-21T13:31:00.000Z",
    sessionDate: "2026-09-21",
    week: "2026-09-21",
    regularOpen: true,
    decision: { signalDate: "2026-09-18", target: "IWM", candidates: [] },
    prices: { QQQ: 110, IWM: 55 }
  }, { roundTripCostPct: 1 });

  assert.equal(switched.state.trades.length, 1);
  assert.equal(switched.state.trades[0].from, "QQQ");
  assert.equal(switched.state.trades[0].to, "IWM");
  assert.ok(Math.abs(switched.state.trades[0].pnlUsdt - 4.451375) < 1e-9);
  assert.equal(switched.state.position.symbol, "IWM");
  assert.equal(switched.state.actualSwitches, 1);
  assert.equal(switched.events.filter(({ type }) => type === "PAPER_BUY_FILLED").length, 1);
  assert.equal(switched.events.filter(({ type }) => type === "PAPER_SELL_FILLED").length, 1);
});

test("resolves exactly one BSC ETF contract for every Paper symbol", () => {
  const assets = ["QQQ", "IWM", "DGRW", "SPY", "IEI"].map((ticker) => ({
    ticker,
    symbol: `${ticker}on`,
    chainId: "56",
    assetType: 3,
    contractAddress: `contract-${ticker}`
  }));

  assert.deepEqual(
    weeklyEtfRotationAssets([...assets, { ...assets[0], chainId: "1" }]).map(({ ticker }) => ticker),
    ["QQQ", "IWM", "DGRW", "SPY", "IEI"]
  );
  assert.throws(() => weeklyEtfRotationAssets(assets.filter(({ ticker }) => ticker !== "IEI")), /IEI/);
  assert.throws(() => weeklyEtfRotationAssets([...assets, { ...assets[0] }]), /QQQ/);
  assert.throws(() => weeklyEtfRotationAssets(assets.map((asset) => ({ ...asset, assetType: 1 }))), /QQQ/);
});
