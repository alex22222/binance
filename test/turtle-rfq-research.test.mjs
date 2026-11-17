import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertResearchReadCommand, collectTurtleRfq, roundTripSample } from "../scripts/research-turtle-rfq.mjs";

test("disconnected preflight never invokes quotes, auth or public collection and saves a blocked report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turtle-rfq-"));
  try {
    const calls = [];
    const result = await collectTurtleRfq(directory, async args => { calls.push(args); return { data: { status: "UNCONNECTED" } }; }, async () => { throw new Error("Must not collect after blocked wallet preflight"); });
    assert.deepEqual(calls, [["wallet", "status"]]);
    assert.equal(result.status, "BLOCKED_WALLET_UNCONNECTED");
    assert.equal(result.pairedQuotes.length, 0);
    assert.equal(result.failures.length, 8);
    assert.equal(result.automaticTradingEligible, false);
  } finally { await rm(directory, { recursive: true }); }
});

test("research execution boundary rejects authentication, writes and modified quote scope", () => {
  for (const args of [["auth", "signin"], ["market-order", "swap"], ["wallet", "send"], ["wallet", "settings", "--update"], ["limit-order", "buy"]]) assert.throws(() => assertResearchReadCommand(args), /read-only/);
  assert.doesNotThrow(() => assertResearchReadCommand(["wallet", "status"]));
  const quote = ["market-order", "quote", "--fromTokenQty", "50", "--fromToken", "0x55d398326f99059fF775485246999027B3197955", "--toToken", "0x55d398326f99059fF775485246999027B3197955", "--binanceChainId", "56", "--slippage", "0.5"];
  assert.doesNotThrow(() => assertResearchReadCommand(quote));
  assert.throws(() => assertResearchReadCommand([...quote, "--force"]), /read-only/);
});

test("paired read-only quote cost keeps actual output quantity and never substitutes a candle or gas estimate", () => {
  const sample = roundTripSample("50", { toCoinAmount: "0.123456789123456789" }, { toCoinAmount: "49.80" }, "2026-11-16T15:00:00Z", "2026-11-16T15:00:03Z");
  assert.ok(Math.abs(sample.quotedRoundTripPct - 0.4) < 1e-10);
  assert.equal(sample.soldTokenQuantity, "0.123456789123456789");
  assert.equal(sample.gasIncluded, null);
  assert.throws(() => roundTripSample("50", { toCoinAmount: null }, { toCoinAmount: "49.8" }, sample.startedAt, sample.endedAt), /quantity/);
  assert.throws(() => roundTripSample("50", { toCoinAmount: "1" }, { toCoinAmount: "49.8" }, sample.startedAt, "2026-11-16T15:01:00Z"), /comparable/);
});

test("connected collection resolves unique contracts, uses exact reverse quantity and invokes only read commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turtle-rfq-"));
  const symbols = ["SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "GLD", "DBC"];
  const usdt = "0x55d398326f99059fF775485246999027B3197955";
  const calls = [];
  try {
    const result = await collectTurtleRfq(directory, async args => {
      calls.push(args);
      if (args[0] === "wallet") return { data: args[1] === "status" ? { status: "CONNECTED" } : { sessionExpireTime: "2026-12-01T00:00:00Z", secret: "MUST_NOT_PERSIST" } };
      assert.deepEqual(args.slice(0, 2), ["market-order", "quote"]);
      const from = args[args.indexOf("--fromToken") + 1], quantity = args[args.indexOf("--fromTokenQty") + 1];
      if (from !== usdt) assert.equal(quantity, "0.123456789123456789");
      return { data: { fromCoinAmount: quantity, toCoinAmount: from === usdt ? "0.123456789123456789" : "49.8", clientId: "MUST_NOT_PERSIST" }, sha256: "test-hash" };
    }, async url => ({ url, payload: { code: "000000", data: url.includes("detail/list") ? symbols.map(ticker => ({ ticker, symbol: ticker + "on", chainId: "56", assetType: 3, contractAddress: "contract-" + ticker })) : { openState: true, marketStatus: "regular" } } }));
    assert.equal(result.pairedQuotes.length, 24);
    assert.equal(result.status, "SINGLE_WINDOW_COLLECTED");
    assert.equal(result.regularPairedQuoteCount, 24);
    assert.equal(result.failures.length, 0);
    assert.equal(result.instruments[0].tokenSymbol, "SPYon");
    assert.equal(calls.filter(a => a[0] === "market-order").length, 48);
    assert.equal(result.pairedQuotes[0].sellRequest.fromTokenQty, "0.123456789123456789");
    assert.equal(result.pairedQuotes[0].buyResponse.fromCoinAmount, "50");
    assert.equal(JSON.stringify(result).includes("MUST_NOT_PERSIST"), false);
  } finally { await rm(directory, { recursive: true }); }
});

test("offhours quotes remain real RFQs but never count as qualifying regular-session samples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turtle-rfq-"));
  const symbols = ["SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "GLD", "DBC"];
  try {
    const result = await collectTurtleRfq(directory, async args => ({ data: args[0] === "wallet" ? (args[1] === "status" ? { status: "CONNECTED" } : {}) : { toCoinAmount: args[5] === "0x55d398326f99059fF775485246999027B3197955" ? "1" : "49.8" } }), async url => ({ payload: { code: "000000", data: url.includes("detail/list") ? symbols.map(ticker => ({ ticker, symbol: ticker + "on", chainId: "56", assetType: 3, contractAddress: "contract-" + ticker })) : { openState: true, marketStatus: "offhours" } } }));
    assert.equal(result.pairedQuotes.length, 24);
    assert.equal(result.regularPairedQuoteCount, 0);
    assert.equal(result.status, "OFFSESSION_QUOTES_ONLY");
    assert.ok(result.pairedQuotes.every(q => q.marketSession === "offhours" && q.regularSessionEligible === false));
  } finally { await rm(directory, { recursive: true }); }
});

test("closed ETF sessions retain all amounts as unavailable without a quote or fake zero-cost sample", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turtle-rfq-"));
  const symbols = ["SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "GLD", "DBC"];
  try {
    const result = await collectTurtleRfq(directory, async args => {
      assert.equal(args[0], "wallet");
      return { data: args[1] === "status" ? { status: "CONNECTED" } : {} };
    }, async url => ({ payload: { code: "000000", data: url.includes("detail/list") ? symbols.map(ticker => ({ ticker, symbol: ticker + "on", chainId: "56", assetType: 3, contractAddress: "contract-" + ticker })) : { openState: false, reasonCode: "MARKET_CLOSED" } } }));
    assert.equal(result.pairedQuotes.length, 0);
    assert.equal(result.failures.length, 24);
    assert.ok(result.failures.every(f => f.amount && f.reason === "MARKET_CLOSED"));
  } finally { await rm(directory, { recursive: true }); }
});
