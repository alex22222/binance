import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveRoundTripGasEstimate,
  gasCostFromReceipt,
  realizedTradePnl
} from "../src/execution-accounting.mjs";

test("calculates the actual gas cost from a BSC transaction receipt", () => {
  const result = gasCostFromReceipt({
    receipt: {
      transactionHash: "0xabc",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x12a05f200"
    },
    bnbUsdtPrice: 600
  });

  assert.equal(result.txHash, "0xabc");
  assert.equal(result.gasBnb, 0.000105);
  assert.equal(result.gasUsdt, 0.063);
});

test("subtracts both transaction gas charges from realized PnL", () => {
  assert.deepEqual(realizedTradePnl({
    proceedsUsdt: 51,
    costBasisUsdt: 50,
    entryGasUsdt: 0.04,
    exitGasUsdt: 0.05
  }), {
    grossPnlUsdt: 1,
    gasCostUsdt: 0.09,
    netPnlUsdt: 0.91
  });
});

test("uses configured gas until ten actual round trips exist, then uses P90", () => {
  const configured = effectiveRoundTripGasEstimate({
    configuredGasUsdt: 0.1,
    observations: [0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13]
  });
  assert.deepEqual(configured, {
    gasUsdt: 0.1,
    source: "CONFIGURED",
    sampleCount: 9
  });

  const observed = effectiveRoundTripGasEstimate({
    configuredGasUsdt: 0.1,
    observations: [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.2]
  });
  assert.deepEqual(observed, {
    gasUsdt: 0.09,
    source: "ACTUAL_P90",
    sampleCount: 10
  });
});
