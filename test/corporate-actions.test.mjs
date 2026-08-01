import assert from "node:assert/strict";
import test from "node:test";

import {
  createNasdaqCorporateActionLoader,
  parseNasdaqCorporateActions
} from "../src/corporate-actions.mjs";

const splitsPayload = {
  status: { rCode: 200 },
  data: {
    asOf: "Fri, Aug 1, 2026",
    rows: [
      { symbol: "NVDA", name: "NVIDIA", ratio: "10 : 1", executionDate: "8/1/2026" },
      { symbol: "OTHER", name: "Other", ratio: "2 : 1", executionDate: "8/20/2026" }
    ]
  }
};

const dividendsPayload = {
  status: { rCode: 200 },
  data: {
    timeframe: "Saturday, Aug 01, 2026",
    calendar: {
      rows: [{
        symbol: "NVDA",
        companyName: "NVIDIA",
        dividend_Ex_Date: "8/1/2026",
        payment_Date: "8/20/2026",
        record_Date: "8/1/2026",
        dividend_Rate: 0.25,
        announcement_Date: "7/20/2026"
      }]
    }
  }
};

test("blocks a symbol around official Nasdaq split or ex-dividend events", () => {
  const result = parseNasdaqCorporateActions({
    symbol: "NVDA",
    splitsPayload,
    dividendsPayload,
    checkedAt: "2026-08-01T15:00:00.000Z",
    blackoutCalendarDays: 1
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.source, "NASDAQ_OFFICIAL_CALENDARS");
  assert.deepEqual(result.events.map(({ type, effectiveDate }) => ({ type, effectiveDate })), [
    { type: "SPLIT", effectiveDate: "2026-08-01" },
    { type: "EX_DIVIDEND", effectiveDate: "2026-08-01" }
  ]);
  assert.deepEqual(result.vetoReasons, ["CORPORATE_ACTION_BLACKOUT"]);
});

test("returns explicit clear evidence when valid calendars contain no nearby event", () => {
  const result = parseNasdaqCorporateActions({
    symbol: "TSLA",
    splitsPayload,
    dividendsPayload,
    checkedAt: "2026-08-01T15:00:00.000Z"
  });

  assert.equal(result.status, "CLEAR");
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.vetoReasons, []);
});

test("treats an official calendar with null rows as an empty day, not a schema failure", () => {
  const result = parseNasdaqCorporateActions({
    symbol: "NVDA",
    splitsPayload: { status: { rCode: 200 }, data: { asOf: "Sat, Aug 1, 2026", rows: null } },
    dividendsPayload: {
      status: { rCode: 200 },
      data: { timeframe: {}, calendar: { asOf: "Sat, Aug 1, 2026", rows: null } }
    },
    checkedAt: "2026-08-01T15:00:00.000Z"
  });

  assert.equal(result.status, "CLEAR");
  assert.deepEqual(result.events, []);
});

test("shares one cached calendar request across symbols and fails closed on malformed data", async () => {
  let calls = 0;
  const load = createNasdaqCorporateActionLoader({
    fetchImpl: async (url) => {
      calls += 1;
      return {
        ok: true,
        json: async () => url.includes("/splits?") ? splitsPayload : dividendsPayload
      };
    }
  });

  const nvda = await load("NVDA", { nowMs: Date.parse("2026-08-01T15:00:00.000Z") });
  const tsla = await load("TSLA", { nowMs: Date.parse("2026-08-01T15:01:00.000Z") });
  assert.equal(calls, 2);
  assert.equal(nvda.status, "BLOCKED");
  assert.equal(tsla.status, "CLEAR");

  assert.throws(
    () => parseNasdaqCorporateActions({
      symbol: "NVDA",
      splitsPayload: { data: null },
      dividendsPayload,
      checkedAt: "2026-08-01T15:00:00.000Z"
    }),
    /Invalid Nasdaq corporate action response/
  );
});
