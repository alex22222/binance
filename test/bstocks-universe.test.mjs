import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBstocksUniverse,
  compareBstocksUniverses,
  resolveLiveAllowedAssets
} from "../src/bstocks-universe.mjs";

const discoveredAt = "2026-08-01T01:02:03.000Z";

function rwa(ticker, contractAddress, overrides = {}) {
  return {
    ticker,
    chainId: "56",
    contractAddress,
    multiplier: "0.01",
    ...overrides
  };
}

test("discovers the full official BSC universe while keeping Live eligibility behind the configured allowlist", () => {
  const universe = buildBstocksUniverse([
    rwa("NVDA", "0xAa"),
    rwa("TSLA", "0xBb"),
    rwa("ETH", "0xCc", { chainId: "1" })
  ], {
    chainId: "56",
    liveAllowlist: ["nvda"],
    discoveredAt
  });

  assert.equal(universe.schemaVersion, 1);
  assert.equal(universe.discoveredAt, discoveredAt);
  assert.equal(universe.assets.length, 2);
  assert.deepEqual(universe.liveAllowedSymbols, ["NVDA"]);
  assert.deepEqual(universe.researchOnlySymbols, ["TSLA"]);
  assert.equal(universe.assets[0].instrumentId, "binance-web3-rwa:bsc:0xaa");
  assert.equal(universe.assets[0].underlyingSymbol, "NVDA");
  assert.equal(universe.assets[0].discoveryStatus, "LIVE_ALLOWED");
  assert.equal(universe.assets[1].discoveryStatus, "RESEARCH_ONLY");
  assert.equal(universe.ignoredOtherChainCount, 1);
  assert.deepEqual(universe.rejected, []);
});

test("resolves only explicitly allowed symbols and fails closed for missing or ambiguous identities", () => {
  const universe = buildBstocksUniverse([
    rwa("NVDA", "0xAa"),
    rwa("NVDA", "0xAb"),
    rwa("TSLA", "0xBb")
  ], {
    liveAllowlist: ["NVDA", "TSLA", "AAPL"],
    discoveredAt
  });

  assert.throws(
    () => resolveLiveAllowedAssets(universe, ["NVDA"]),
    /Ambiguous BSC contracts for NVDA/
  );
  assert.throws(
    () => resolveLiveAllowedAssets(universe, ["AAPL"]),
    /BSC contracts not found: AAPL/
  );

  const assets = resolveLiveAllowedAssets(universe, ["TSLA"]);
  assert.equal(assets.get("TSLA").contractAddress, "0xBb");
});

test("reports additions, removals, and contract changes between discovery snapshots", () => {
  const previous = buildBstocksUniverse([
    rwa("NVDA", "0xOld"),
    rwa("AAPL", "0xAapl")
  ], { liveAllowlist: ["NVDA"], discoveredAt });
  const current = buildBstocksUniverse([
    rwa("NVDA", "0xNew"),
    rwa("TSLA", "0xTsla")
  ], { liveAllowlist: ["NVDA"], discoveredAt: "2026-08-01T01:03:03.000Z" });

  assert.deepEqual(compareBstocksUniverses(previous, current), {
    addedInstrumentIds: ["binance-web3-rwa:bsc:0xnew", "binance-web3-rwa:bsc:0xtsla"],
    removedInstrumentIds: ["binance-web3-rwa:bsc:0xaapl", "binance-web3-rwa:bsc:0xold"],
    contractChanges: [{
      symbol: "NVDA",
      previousContractAddresses: ["0xOld"],
      currentContractAddresses: ["0xNew"]
    }],
    multiplierChanges: []
  });
});

test("reports multiplier changes without treating numeric formatting as a change", () => {
  const previous = buildBstocksUniverse([
    rwa("NVDA", "0xNvda", { multiplier: "1.0" }),
    rwa("TSLA", "0xTsla", { multiplier: "0.5" })
  ], { liveAllowlist: ["NVDA", "TSLA"], discoveredAt });
  const current = buildBstocksUniverse([
    rwa("NVDA", "0xNvda", { multiplier: "1.000" }),
    rwa("TSLA", "0xTsla", { multiplier: "0.25" })
  ], { liveAllowlist: ["NVDA", "TSLA"], discoveredAt });

  assert.deepEqual(compareBstocksUniverses(previous, current).multiplierChanges, [{
    instrumentId: "binance-web3-rwa:bsc:0xtsla",
    symbol: "TSLA",
    previousMultiplier: 0.5,
    currentMultiplier: 0.25
  }]);
});
