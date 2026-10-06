import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createOkxReadOnlyClient,
  dcaPosition,
  fedExpectations,
  loadBtcDailyRsi,
  loadDcaPosition,
  loadFearGreed,
  loadSentiment,
  parseTreasuryCsv,
  priceLadder,
  selectWeeklyEvent,
  wilderRsi,
  yesPrice
} from "../src/btc-radar-sources.mjs";

const market = (question, yes, extra = {}) => ({
  question,
  outcomes: JSON.stringify(["Yes", "No"]),
  outcomePrices: JSON.stringify([String(yes), String(1 - yes)]),
  ...extra
});

test("builds dip and reach ladders from Yes prices, keeping a resolved level at 1", () => {
  const ladder = priceLadder([
    market("Will Bitcoin reach $90,000 September 28-October 4?", 0.0355),
    market("Will Bitcoin reach $84,000 September 28-October 4?", 1, { closed: true }),
    market("Will Bitcoin reach $84,000 September 28-October 4?", 0.99),
    market("Will Bitcoin dip to $80,000 September 28-October 4?", 0.105),
    market("Will Bitcoin dip to $78,000 September 28-October 4?", 0.06),
    market("Unrelated market?", 0.5),
    { question: "Will Bitcoin dip to $70,000?", outcomes: "[]", outcomePrices: "[]" }
  ]);
  assert.deepEqual(ladder, { dips: { 80000: 0.105, 78000: 0.06 }, reaches: { 90000: 0.0355, 84000: 1 } });
  assert.equal(yesPrice({ outcomes: '["No","Yes"]', outcomePrices: '["0.2","0.8"]' }), 0.8);
  assert.equal(yesPrice({ outcomes: '["Yes","No"]', outcomePrices: '["1.4","0"]' }), null);
  assert.throws(() => priceLadder([market("Will Bitcoin reach $90,000 in October?", 0.4)]), /missing dip or reach/);
});

test("selects the current weekly price-hit event, not daily, monthly, or yearly ones", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const events = [
    { title: "What price will Bitcoin hit in October?", endDate: "2026-11-01T04:00:00Z" },
    { title: "What price will Bitcoin hit on October 1?", endDate: "2026-10-02T04:00:00Z" },
    { title: "What price will Bitcoin hit in 2026?", endDate: "2027-01-01T05:00:00Z" },
    { title: "What price will Bitcoin hit October 5-11?", endDate: "2026-10-12T04:00:00Z" },
    { title: "What price will Bitcoin hit September 21-27?", endDate: "2026-09-28T04:00:00Z" },
    { title: "What price will Bitcoin hit September 28-October 4?", endDate: "2026-10-05T04:00:00Z" }
  ];
  assert.equal(selectWeeklyEvent(events, now).title, "What price will Bitcoin hit September 28-October 4?");
  assert.equal(selectWeeklyEvent(events.slice(0, 3), now), null);
});

test("derives Fed expectations from the next decision and the current-year markets", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const decision = (month, endDate, hikes, cuts) => ({
    title: `Fed Decision in ${month}?`,
    endDate,
    markets: [
      market(`Will the Fed decrease interest rates by 50+ bps after the ${month} 2026 meeting?`, cuts[0], { groupItemTitle: "50+ bps decrease" }),
      market(`Will the Fed decrease interest rates by 25 bps after the ${month} 2026 meeting?`, cuts[1], { groupItemTitle: "25 bps decrease" }),
      market(`Will there be no change in Fed interest rates after the ${month} 2026 meeting?`, 0.6, { groupItemTitle: "No change" }),
      market(`Will the Fed increase interest rates by 25 bps after the ${month} 2026 meeting?`, hikes[0], { groupItemTitle: "25 bps increase" }),
      market(`Will the Fed increase interest rates by 50+ bps after the ${month} 2026 meeting?`, hikes[1], { groupItemTitle: "50+ bps increase" })
    ]
  });
  const events = [
    decision("December", "2026-12-10T04:59:00Z", [0.745, 0.0145], [0.0035, 0.0095]),
    decision("September", "2026-09-17T04:59:00Z", [0.9, 0], [0, 0]),
    decision("October", "2026-10-29T03:59:00Z", [0.335, 0.0055], [0.0025, 0.0045]),
    { title: "Another Fed rate hike in 2026?", endDate: "2026-12-10T04:59:00Z", markets: [market("Another Fed rate hike in 2026?", 0.815)] },
    { title: "How many Fed rate cuts in 2026?", endDate: "2027-01-01T04:59:00Z", markets: [market("Will no Fed rate cuts happen in 2026?", 0.9685), market("Will 1 Fed rate cut happen in 2026?", 0.0185)] }
  ];
  assert.deepEqual(fedExpectations(events, now), {
    next_meeting: "10月议息", p_hike_next: 0.3405, p_cut_next: 0.007, p_hike_2026_any: 0.815, p_cut_2026_any: 0.0315
  });
  const fallback = fedExpectations(events.slice(0, 3), now);
  assert.equal(fallback.p_hike_2026_any, 0.7595);
  assert.equal(fallback.p_cut_2026_any, 0.013);
  assert.throws(() => fedExpectations(events.slice(3), now), /Next Fed decision/);
});

test("parses Treasury yields newest first with ISO dates", () => {
  const csv = 'Date,"1 Mo","2 Yr","5 Yr","10 Yr"\n09/29/2026,4.02,4.89,5.01,5.26\n09/30/2026,4.03,4.88,5.05,5.29\n';
  assert.deepEqual(parseTreasuryCsv(csv), [
    { date: "2026-09-30", y2: 4.88, y10: 5.29 },
    { date: "2026-09-29", y2: 4.89, y10: 5.26 }
  ]);
  assert.throws(() => parseTreasuryCsv("Date,1 Mo\n09/30/2026,4.0"), /columns are missing/);
});

test("signs OKX read-only requests exactly as the v5 API specifies", async () => {
  const calls = [];
  const privateGet = createOkxReadOnlyClient({
    apiKey: "key", secretKey: "secret", passphrase: "phrase",
    now: () => new Date("2026-10-01T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      return { ok: true, status: 200, json: async () => ({ code: "0", data: [{ ok: true }] }) };
    }
  });
  assert.deepEqual(await privateGet("/api/v5/tradingBot/dca/ongoing-list", { algoOrdType: "contract_dca", algoId: undefined }), [{ ok: true }]);
  const requestPath = "/api/v5/tradingBot/dca/ongoing-list?algoOrdType=contract_dca";
  assert.equal(calls[0].url, `https://www.okx.com${requestPath}`);
  assert.equal(calls[0].headers["OK-ACCESS-KEY"], "key");
  assert.equal(calls[0].headers["OK-ACCESS-PASSPHRASE"], "phrase");
  assert.equal(calls[0].headers["OK-ACCESS-TIMESTAMP"], "2026-10-01T00:00:00.000Z");
  assert.equal(
    calls[0].headers["OK-ACCESS-SIGN"],
    createHmac("sha256", "secret").update(`2026-10-01T00:00:00.000ZGET${requestPath}`).digest("base64")
  );
  assert.throws(() => createOkxReadOnlyClient({ apiKey: "key", secretKey: "", passphrase: "phrase" }), /incomplete/);
  const rejecting = createOkxReadOnlyClient({
    apiKey: "key", secretKey: "secret", passphrase: "phrase",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: "50113", msg: "Invalid Sign" }) })
  });
  await assert.rejects(rejecting("/api/v5/orbit/currency-sentiment-query"), /50113 Invalid Sign/);
});

const bot = (overrides = {}) => ({
  algoId: "1", instId: "BTC-USDT-SWAP", direction: "long", state: "running", cTime: "100",
  ctVal: "0.0100", lever: "20", maxSafetyOrds: "10", pxSteps: "0.004", pxStepsMult: "1", totalPnl: "-12.3456",
  triggerParams: [{ triggerAction: "start", triggerPx: "0" }, { triggerAction: "stop", triggerPx: "77000" }],
  ...overrides
});
const details = { avgPx: "81250.4567891", fillSafetyOrds: "6", initPx: "82000", liqPx: "73100.0444", sz: "10.5", tpPx: "84500" };

test("maps a contract DCA bot to the radar position", () => {
  assert.deepEqual(dcaPosition(bot(), details), {
    avg: 81250.46, tp: 84500, sl: 77000, liq: 73100, sz_btc: 0.105, lever: 20,
    total_pnl: -12.35, safety_filled: 6, safety_max: 10, next_safety: 79704,
    manual_adds: 0, ladder: { pending: [], ctVal: 0.01, complete: false }
  });
  assert.equal(dcaPosition(bot({ triggerParams: [] }), details).sl, 0);
  assert.equal(dcaPosition(bot({ maxSafetyOrds: "6" }), details).next_safety, null);
  assert.equal(dcaPosition(bot({ pxStepsMult: "2" }), { ...details, fillSafetyOrds: "1" }).next_safety, 81016);
});

test("counts automatic safety fills apart from manual adds and keeps the live ladder", () => {
  const order = (ordType, state, px, sz) => ({ ordType, state, px, sz });
  const orders = [
    order("tp_order", "live", "84500", "10.5"),
    order("manual_add_order", "filled", "81900", "3"),
    order("safety_order", "live", "78700", "1.5"),
    order("safety_order", "live", "79500", "1.2"),
    order("safety_order", "filled", "80300", "1"),
    order("safety_order", "filled", "81100", "0.8"),
    order("init_order", "filled", "", "1")
  ];
  const mapped = dcaPosition(bot(), { ...details, fillSafetyOrds: "3", fillManualOrds: "1" }, orders);
  assert.equal(mapped.safety_filled, 2);
  assert.equal(mapped.manual_adds, 1);
  assert.equal(mapped.next_safety, 79500);
  assert.deepEqual(mapped.ladder, { pending: [[79500, 1.2], [78700, 1.5]], ctVal: 0.01, complete: true });
  const summaryOnly = dcaPosition(bot(), { ...details, fillSafetyOrds: "3", fillManualOrds: "1" }, [order("tp_order", "live", "84500", "10.5")]);
  assert.equal(summaryOnly.safety_filled, 2);
  assert.equal(summaryOnly.ladder.complete, false);
  assert.equal(summaryOnly.next_safety, Number((82000 * (1 - 0.004 * 3)).toFixed(1)));
});

test("follows the newest running BTC long bot and reports a stopped one", async () => {
  const requests = [];
  const privateGet = async (path, params) => {
    requests.push([path, params]);
    if (path.endsWith("ongoing-list")) {
      return [
        bot({ algoId: "old", cTime: "100" }),
        bot({ algoId: "new", cTime: "200" }),
        bot({ algoId: "eth", instId: "ETH-USDT-SWAP", cTime: "300" }),
        bot({ algoId: "short", direction: "short", cTime: "400" })
      ];
    }
    if (path.endsWith("history-list")) return [{ algoId: "gone", state: "stopped" }];
    if (path.endsWith("/orders")) return [{ ordType: "safety_order", state: "live", px: "81000", sz: "1" }];
    return [{ ...details, curCycleId: "7" }];
  };
  const followed = await loadDcaPosition(privateGet, { trackedAlgoId: "gone" });
  assert.equal(followed.algoId, "new");
  assert.deepEqual(followed.events, [
    { type: "STRATEGY_ENDED", algoId: "gone", state: "stopped" },
    { type: "STRATEGY_SWITCHED", algoId: "new", previousAlgoId: "gone" }
  ]);
  assert.deepEqual(requests.slice(-2), [
    ["/api/v5/tradingBot/dca/position-details", { algoId: "new", algoOrdType: "contract_dca" }],
    ["/api/v5/tradingBot/dca/orders", { algoId: "new", algoOrdType: "contract_dca", cycleId: "7", limit: "100" }]
  ]);
  assert.deepEqual(followed.position.ladder.pending, [[81000, 1]]);
  const withoutOrders = await loadDcaPosition(async (path, params) => {
    if (path.endsWith("/orders")) throw new Error("OKX /orders failed: 50001");
    return privateGet(path, params);
  }, {});
  assert.equal(withoutOrders.position.ladder.complete, false);
  assert.equal((await loadDcaPosition(privateGet, { pinnedAlgoId: "old", trackedAlgoId: "old" })).algoId, "old");
  const none = await loadDcaPosition(async () => [], {});
  assert.deepEqual(none, { position: null, algoId: null, events: [] });
});

test("reads BTC news sentiment ratios and rejects malformed ones", async () => {
  const response = (sentiment) => async () => [{ details: [{ ccy: "BTC", sentiment }] }];
  assert.deepEqual(await loadSentiment(response({ bullishRatio: "0.53", bearishRatio: "0.11" })), { bull: 0.53, bear: 0.11 });
  await assert.rejects(loadSentiment(response({ bullishRatio: "", bearishRatio: "0.11" })), /bullish ratio/);
  await assert.rejects(loadSentiment(response({ bullishRatio: "1.2", bearishRatio: "0.11" })), /outside 0-1/);
});

test("computes Wilder's RSI from completed UTC daily candles and from the live candle", async () => {
  assert.equal(wilderRsi([1, 2, 1, 3], 2), 100 - 100 / 6);
  assert.equal(wilderRsi(Array.from({ length: 20 }, (_, index) => index)), 100);
  assert.equal(wilderRsi(Array.from({ length: 20 }, (_, index) => 20 - index)), 0);
  assert.equal(wilderRsi(Array(20).fill(5)), 50);
  assert.throws(() => wilderRsi([1, 2, 3]), /needs more than 14/);

  const start = Date.parse("2026-08-01T00:00:00Z");
  const requests = [];
  const rows = Array.from({ length: 40 }, (_, index) => [
    String(start + index * 86_400_000), "0", "0", "0", String(index === 39 ? 100 + 38 - 30 : 100 + index), "0", "0", "0", index === 39 ? "0" : "1"
  ]).reverse();
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return { ok: true, status: 200, json: async () => ({ code: "0", data: rows }) };
  };
  assert.deepEqual(await loadBtcDailyRsi({ fetchImpl }), { closed: 100, intraday: 30.2, date: "2026-09-08" });
  assert.match(requests[0], /instId=BTC-USDT&bar=1Dutc&limit=300/);
  const short = async () => ({ ok: true, status: 200, json: async () => ({ code: "0", data: rows.slice(0, 20) }) });
  await assert.rejects(loadBtcDailyRsi({ fetchImpl: short }), /too short for RSI/);
});

test("reads the Fear & Greed Index with a Chinese label and its UTC date", async () => {
  const response = (entry) => async () => ({ ok: true, status: 200, json: async () => ({ data: [entry] }) });
  const timestamp = String(Date.parse("2026-10-01T00:00:00Z") / 1000);
  assert.deepEqual(
    await loadFearGreed({ fetchImpl: response({ value: "74", value_classification: "Greed", timestamp }) }),
    { value: 74, label: "贪婪", date: "2026-10-01" }
  );
  assert.equal((await loadFearGreed({ fetchImpl: response({ value: "12", value_classification: "Extreme Fear", timestamp }) })).label, "极度恐惧");
  await assert.rejects(loadFearGreed({ fetchImpl: response({ value: "101", value_classification: "Greed", timestamp }) }), /outside 0-100/);
  await assert.rejects(loadFearGreed({ fetchImpl: response({ value: "", timestamp }) }), /not a finite number/);
});
