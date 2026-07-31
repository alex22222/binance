import assert from "node:assert/strict";
import test from "node:test";
import {
  createReplayFrames,
  createReplayRecorder
} from "../src/replay-engine.mjs";

test("creates unique monotonic replay frames with an explicit time frontier", () => {
  const first = Date.parse("2026-07-27T13:30:00.000Z");
  const second = first + 60_000;
  assert.deepEqual(createReplayFrames([second, first, first]), [
    {
      sequence: 1,
      marketTime: first,
      frontierTime: second
    },
    {
      sequence: 2,
      marketTime: second,
      frontierTime: second + 60_000
    }
  ]);
});

test("rejects invalid replay timestamps and intervals", () => {
  assert.throws(() => createReplayFrames([Date.now(), NaN]), /timestamp/);
  assert.throws(() => createReplayFrames([Date.now()], { intervalMs: 0 }), /interval/);
});

test("records ordered events and rejects a regressing time frontier", () => {
  const start = Date.parse("2026-07-27T13:30:00.000Z");
  const [first, second] = createReplayFrames([start, start + 60_000]);
  const recorder = createReplayRecorder({ includeEvents: true });

  recorder.record("SIGNAL", first, { symbol: "NVDA" });
  recorder.record("ORDER_INTENT", first, { orderId: "buy-1" });
  recorder.record("ORDER_FILLED", second, { orderId: "buy-1" });

  assert.deepEqual(recorder.snapshot(), {
    eventCounts: {
      SIGNAL: 1,
      ORDER_INTENT: 1,
      ORDER_FILLED: 1
    },
    events: [
      {
        sequence: 1,
        type: "SIGNAL",
        marketTime: first.marketTime,
        frontierTime: first.frontierTime,
        symbol: "NVDA"
      },
      {
        sequence: 2,
        type: "ORDER_INTENT",
        marketTime: first.marketTime,
        frontierTime: first.frontierTime,
        orderId: "buy-1"
      },
      {
        sequence: 3,
        type: "ORDER_FILLED",
        marketTime: second.marketTime,
        frontierTime: second.frontierTime,
        orderId: "buy-1"
      }
    ]
  });
  assert.throws(
    () => recorder.record("INVALID", first, {}),
    /frontier/
  );
});

test("counts events without retaining the optional detailed event log", () => {
  const [frame] = createReplayFrames([Date.parse("2026-07-27T13:30:00.000Z")]);
  const recorder = createReplayRecorder();
  recorder.record("SIGNAL", frame, { symbol: "NVDA" });

  assert.deepEqual(recorder.snapshot(), {
    eventCounts: { SIGNAL: 1 }
  });
});
