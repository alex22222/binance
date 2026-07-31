import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExternalMarketAttribution,
  buildPremarketBrief
} from "../src/market-context.mjs";

function candles(startMs, returns) {
  let close = 100;
  return [{ openTime: startMs, close }].concat(returns.map((value, index) => {
    close *= 1 + value;
    return { openTime: startMs + (index + 1) * 60_000, close };
  }));
}

test("attributes a trade decline to an aligned benchmark with beta and residual", () => {
  const startMs = Date.parse("2026-07-30T14:00:00.000Z");
  const benchmarkReturns = Array.from({ length: 30 }, (_, index) => (
    index % 2 ? -0.0015 : -0.0005
  ));
  const stockReturns = benchmarkReturns.map((value) => value * 2);
  const report = buildExternalMarketAttribution({
    trades: [{
      symbol: "MSFT",
      openedAt: new Date(startMs).toISOString(),
      completedAt: new Date(startMs + 30 * 60_000).toISOString(),
      realizedPnlUsdt: -1,
      amountUsdt: 50
    }],
    candlesBySymbol: {
      SPY: candles(startMs, benchmarkReturns),
      QQQ: candles(startMs, benchmarkReturns),
      MSFT: candles(startMs, stockReturns)
    }
  });

  assert.equal(report.status, "AVAILABLE");
  assert.equal(report.observedTrades, 1);
  assert.ok(report.trades[0].correlation > 0.99);
  assert.ok(Math.abs(report.trades[0].beta - 2) < 0.01);
  assert.ok(Math.abs(report.trades[0].residualReturnPct) < 0.1);
  assert.ok(report.marketAttributedLossSharePct > 99);
  assert.equal(report.lossDirectionAlignmentPct, 100);
});

test("does not blame a rising market for an idiosyncratic stock loss", () => {
  const startMs = Date.parse("2026-07-30T14:00:00.000Z");
  const report = buildExternalMarketAttribution({
    trades: [{
      symbol: "META",
      openedAt: new Date(startMs).toISOString(),
      completedAt: new Date(startMs + 30 * 60_000).toISOString(),
      realizedPnlUsdt: -1,
      amountUsdt: 50
    }],
    candlesBySymbol: {
      SPY: candles(startMs, Array.from({ length: 30 }, (_, index) => index % 2 ? 0.0015 : 0.0005)),
      QQQ: candles(startMs, Array.from({ length: 30 }, (_, index) => index % 2 ? 0.0015 : 0.0005)),
      META: candles(startMs, Array.from({ length: 30 }, (_, index) => index % 2 ? -0.0015 : -0.0005))
    }
  });

  assert.equal(report.marketAttributedLossSharePct, 0);
  assert.equal(report.lossDirectionAlignmentPct, 0);
  assert.ok(report.trades[0].residualReturnPct < 0);
});

test("builds a non-executing defensive premarket brief from breadth, volatility and news", () => {
  const brief = buildPremarketBrief({
    tradingDate: "2026-07-31",
    generatedAt: "2026-07-31T13:15:00.000Z",
    snapshots: [
      { symbol: "SPY", changePct: -0.8 },
      { symbol: "QQQ", changePct: -1.1 },
      { symbol: "IWM", changePct: -0.7 },
      { symbol: "^VIX", changePct: 6.2 },
      { symbol: "MSFT", changePct: -0.4 },
      { symbol: "NVDA", changePct: 0.1 }
    ],
    stockSymbols: ["MSFT", "NVDA"],
    headlines: [
      { title: "Federal Reserve decision raises volatility risk", source: "Example" }
    ],
    errors: []
  });

  assert.equal(brief.status, "AVAILABLE");
  assert.equal(brief.advice.level, "DEFENSIVE");
  assert.equal(brief.advice.executionEffect, "NONE");
  assert.equal(brief.market.breadthPositivePct, 50);
  assert.equal(brief.news.riskHeadlineCount, 1);
  assert.match(brief.advice.summary, /追涨/);
});

test("fails open as research-only when premarket inputs are insufficient", () => {
  const brief = buildPremarketBrief({
    tradingDate: "2026-07-31",
    snapshots: [{ symbol: "SPY", changePct: 0.2 }],
    stockSymbols: ["MSFT"],
    headlines: [],
    errors: ["QQQ unavailable"]
  });

  assert.equal(brief.status, "INSUFFICIENT_DATA");
  assert.equal(brief.advice.level, "DATA_INSUFFICIENT");
  assert.equal(brief.advice.executionEffect, "NONE");
});
