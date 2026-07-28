import assert from "node:assert/strict";
import test from "node:test";
import {
  exactTokenBalance,
  sameTokenAmount
} from "../src/token-amount.mjs";

test("preserves the exact wallet balance used for a token sale", () => {
  assert.equal(
    exactTokenBalance([
      { balance: "0.775308912051018359" }
    ]),
    "0.775308912051018359"
  );
});

test("compares token quantities without losing 18-decimal precision", () => {
  assert.equal(sameTokenAmount("0.775308912051018359", "0.775308912051018359"), true);
  assert.equal(sameTokenAmount("1.0", "1.000000000000000000"), true);
  assert.equal(sameTokenAmount("0.775308912051018359", "0.7753089120510184"), false);
  assert.equal(sameTokenAmount(undefined, "0.775308912051018359"), false);
});
