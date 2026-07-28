import assert from "node:assert/strict";
import test from "node:test";
import {
  addOpenPosition,
  entryCapacityDecision,
  findOpenPosition,
  migratePositionState,
  openPositions,
  removeOpenPosition
} from "../src/position-state.mjs";

const nvda = {
  symbol: "NVDA",
  address: "0x1111111111111111111111111111111111111111"
};
const tsla = {
  symbol: "TSLA",
  address: "0x2222222222222222222222222222222222222222"
};
const aapl = {
  symbol: "AAPL",
  address: "0x3333333333333333333333333333333333333333"
};

test("migrates a legacy single position without duplicating current arrays", () => {
  assert.deepEqual(migratePositionState({
    position: nvda,
    pendingOrder: null
  }), {
    positions: [nvda],
    pendingOrder: null
  });
  assert.deepEqual(openPositions({
    position: nvda,
    positions: [tsla]
  }), [tsla]);
});

test("allows three different stocks and rejects a duplicate or fourth position", () => {
  const state = migratePositionState({});
  addOpenPosition(state, nvda, 3);
  addOpenPosition(state, tsla, 3);
  addOpenPosition(state, aapl, 3);

  assert.equal(entryCapacityDecision(state, 3).allowed, false);
  assert.equal(entryCapacityDecision(state, 3).reason, "MAX_OPEN_POSITIONS");
  assert.throws(
    () => addOpenPosition(state, { ...nvda }, 3),
    /already open/i
  );
  assert.throws(
    () => addOpenPosition(state, {
      symbol: "MSFT",
      address: "0x4444444444444444444444444444444444444444"
    }, 3),
    /maximum open positions/i
  );
});

test("finds and removes only the matching stock position", () => {
  const state = migratePositionState({ positions: [nvda, tsla, aapl] });

  assert.equal(findOpenPosition(state, {
    symbol: "TSLA",
    address: tsla.address.toUpperCase()
  }), tsla);
  assert.equal(removeOpenPosition(state, tsla), tsla);
  assert.deepEqual(openPositions(state), [nvda, aapl]);
});
