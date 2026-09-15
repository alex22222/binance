import assert from "node:assert/strict";
import test from "node:test";
import { TURTLE_ETF_UNIVERSE, turtleEtfAssets } from "../src/turtle-etf-universe.mjs";

const assets = TURTLE_ETF_UNIVERSE.map(({ symbol }) => ({
  ticker: symbol, chainId: "56", assetType: 3, contractAddress: `contract-${symbol}`
}));

test("resolves the ETF universe on BSC and retains verified contract identity", () => {
  const selected = turtleEtfAssets([...assets, { ticker: "SPY", chainId: "1", assetType: 3 }]);
  assert.equal(selected.length, 8);
  assert.equal(selected[0].contractAddress, "contract-SPY");
  assert.equal(new Set(selected.map(({ cluster }) => cluster)).size, 5);
});

test("rejects missing, ambiguous or non-ETF identities without a ticker fallback", () => {
  assert.throws(() => turtleEtfAssets(assets.slice(1)), /SPY/);
  assert.throws(() => turtleEtfAssets([...assets, assets[0]]), /SPY/);
  assert.throws(() => turtleEtfAssets(assets.map((asset) => ({ ...asset, assetType: 1 }))), /SPY/);
});
