import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { evaluateBtcRadar, evaluateLegacyBtcRadar } from "../src/btc-radar-model.mjs";
import { buildPercentileHistory, percentileInputsAt, percentileScore, BTC_RADAR_WEIGHTS, scorePercentileFactors } from "../src/btc-radar-percentiles.mjs";
import { loadLeveragedAccountRisk, fedExpectations, createOkxReadOnlyClient, parseEtfFlows, loadRadarDailyHistory } from "../src/btc-radar-sources.mjs";
import { leverageRisk } from "../src/btc-radar-risk.mjs";
import { spearman, studyV3 } from "../scripts/btc-radar-study/v3.mjs";

const DAY = 86400000;
const now = Date.parse("2026-11-03T00:43:00Z");
const series = Array.from({ length: 366 }, (_, i) => ({ date: new Date(now - (366 - i) * DAY).toISOString().slice(0, 10), value: i }));

test("percentiles are trailing-calendar-year only, midrank ties, and never backfill unknown data", () => {
  assert.equal(percentileScore(1000, series, now).score, 100);
  assert.equal(percentileScore(-1, series, now).score, 0);
  assert.equal(percentileScore(5, series.map(r => ({ ...r, value: 5 })), now).score, 50);
  assert.equal(percentileScore(null, series, now).score, null);
  assert.equal(percentileScore(5, series.slice(-33), now).score, null);
  const future = { date: "2026-11-04", value: -1e9 };
  assert.deepEqual(percentileScore(1000, [...series, future], now), percentileScore(1000, series, now));
  assert.equal(percentileScore(1, series.map(r => ({ ...r, availableAt: "2026-11-04T00:00:00Z" })), now).score, null);
});

test("fixed factor weights sum to 100, extreme regimes span below 40 and above 70 without stretching", () => {
  assert.equal(Object.values(BTC_RADAR_WEIGHTS).reduce((a, b) => a + b, 0), 100);
  assert.ok(BTC_RADAR_WEIGHTS.rates <= 20);
  assert.equal(BTC_RADAR_WEIGHTS.flow, 20);
  assert.equal(BTC_RADAR_WEIGHTS.gold, 5);
  const features = Object.fromEntries(["yield2", "yield10Change", "etf5", "stable7", "premium", "momentum3", "vol7", "gold10", "funding3", "oi7"].map(k => [k, series]));
  const row = { yield2: 1000, yield10Change: 1000, etf5: -1, stable7: -1, premium: -1, momentum3: -1, vol7: -1, gold10: -1, funding3: 1000, oi7: 1000 };
  const high = scorePercentileFactors({ values: row, history: features, nowMs: now });
  const low = scorePercentileFactors({ values: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === -1 ? 1000 : -1])), history: features, nowMs: now });
  assert.ok(high.score >= 70);
  assert.ok(low.score < 40);
  assert.equal(scorePercentileFactors({ values: { ...row, etf5: null }, history: features, nowMs: now }).score, null);
  assert.ok(high.factors.find(f => f.key === "tech").rule.includes("波动压缩"));
  assert.equal(typeof evaluateLegacyBtcRadar, "function");
  assert.equal(evaluateBtcRadar({ ts: new Date(now).toISOString(), price: 100 }).score, null);
});

test("Fed mapping rejects closed contracts, question-label conflicts and next-year annual fallbacks", () => {
  const m = (id, groupItemTitle, question, yes, extra = {}) => ({ id, groupItemTitle, question, outcomes: '["No","Yes"]', outcomePrices: JSON.stringify([1 - yes, yes]), ...extra });
  const event = { id: "e1", slug: "dec-2026", title: "Fed Decision in December?", endDate: "2026-12-10T04:59:00Z", markets: [
    m("1", "25 bps increase", "Will the Fed increase rates after the December 2026 meeting?", 0.72),
    m("2", "25 bps decrease", "Will the Fed decrease rates after the December 2026 meeting?", 0.01),
    m("3", "No change", "Will there be no change after the December 2026 meeting?", 0.27)
  ] };
  const mapped = fedExpectations([event], now);
  assert.equal(mapped.p_hike_next, 0.72);
  assert.equal(mapped.p_hike_year_any, null, "next meeting odds are not an annual odds contract");
  assert.equal(mapped.contract.eventId, "e1");
  assert.equal(mapped.contract.markets[0].yesTokenOutcome, "Yes");
  assert.throws(() => fedExpectations([{ ...event, closed: true }], now), /Next Fed/);
  assert.throws(() => fedExpectations([{ ...event, endDate: "2027-12-10T04:59:00Z" }], now), /year|identity/);
  assert.throws(() => fedExpectations([{ ...event, markets: [m("1", "25 bps increase", "Will the Fed decrease rates after the December 2026 meeting?", 0.72)] }], now), /mapping|conflict|Incomplete/);
});

const p = (extra = {}) => ({ instType: "SWAP", instId: "HYPE-USDT-SWAP", posId: "h1", posSide: "net", pos: "-10", mgnMode: "cross", lever: "10", ...extra });
const o = (extra = {}) => ({ algoId: "stop1", instId: "HYPE-USDT-SWAP", posSide: "net", side: "buy", tdMode: "cross", ordType: "oco", state: "live", reduceOnly: "true", slTriggerPx: "60", slOrdPx: "-1", sz: "4", ...extra });
const riskFor = (positions, orders) => loadLeveragedAccountRisk(async (path, params = {}) =>
  path.endsWith("account/positions") ? positions : params.ordType === "oco" ? orders : []);

test("MARGIN uses posCcy for direction and compares only documented base-unit stop quantities", async () => {
  const margin = p({ instType: "MARGIN", instId: "HYPE-USDT", pos: "10", posCcy: "HYPE" });
  const stop = o({ instType: "MARGIN", instId: "HYPE-USDT", side: "sell" });
  const long = (await riskFor([margin], [stop])).positions[0];
  assert.equal(long.direction, "long");
  assert.equal(long.sizeUnit, "base");
  assert.equal(long.stopCoverage, 0.4);
  const short = (await riskFor([{ ...margin, posCcy: "USDT" }], [{ ...stop, side: "buy", slOrdPx: "65" }])).positions[0];
  assert.equal(short.direction, "short");
  assert.equal(short.sizeUnit, "base", "GET positions documents MARGIN pos in base units, not posCcy units");
  assert.equal(short.stopSize, 4);
  assert.equal(short.stopCoverage, 0.4);
  assert.equal((await riskFor([{ ...margin, posCcy: "USDT" }], [{ ...stop, sz: "10" }])).positions[0].stopCoverage, 0);
  const both = await riskFor([margin, { ...margin, posId: "h2", posCcy: "USDT" }], [stop, { ...stop, algoId: "s2", side: "buy", slOrdPx: "65", sz: "6" }]);
  assert.deepEqual(both.positions.map(row => row.stopCoverage), [0.4, 0.6]);
});

test("MARGIN market buys and unknown direction/unit/stop fields never become full coverage", async () => {
  const margin = p({ instType: "MARGIN", instId: "HYPE-USDT", pos: "10", posCcy: "USDT" });
  const stop = o({ instType: "MARGIN", instId: "HYPE-USDT", sz: "600" });
  for (const [position, order] of [
    [margin, stop], // Market-buy quote amount cannot be divided by the trigger price as guaranteed base coverage.
    [margin, { ...stop, slOrdPx: "" }],
    [margin, { ...stop, slOrdPx: "65", tgtCcy: "base_ccy" }], // tgtCcy is SPOT-only.
    [{ ...margin, posCcy: "" }, { ...stop, side: "sell" }],
    [{ ...margin, posCcy: "BTC" }, { ...stop, side: "sell" }],
    [{ ...margin, pos: "-10" }, stop],
    [{ ...margin, instType: "UNKNOWN" }, { ...stop, side: "sell" }],
    [{ ...margin, posCcy: "HYPE" }, { ...stop, side: "sell", closeFraction: "1", sz: "" }]
  ]) {
    const account = await riskFor([position], [order]);
    assert.equal(account.positions[0].stopCoverage, null, JSON.stringify([position, order]));
    assert.equal(account.positions[0].coverageLevel, "unknown");
    assert.equal(account.complete, false);
  }
  for (const sz of [undefined, "", "bad", " ", false, "-1"]) {
    const account = await riskFor([p()], [o({ sz }), o({ algoId: "other", sz: "10" })]);
    assert.equal(account.positions[0].stopCoverage, null, `invalid stop size ${String(sz)}`);
  }
});

test("audit redaction retains MARGIN identity and order units without executing the SSH script", async () => {
  const source = await readFile(new URL("../scripts/btc-radar-study/account-audit.mjs", import.meta.url), "utf8");
  const helpers = source.match(/const keys=new Set\([^\n]+\);\nconst safe=[^\n]+;/)?.[0];
  assert.ok(helpers, "only evaluate the isolated pure redaction helper, never import the audit entrypoint");
  const row = { posCcy: "USDT", ordType: "oco", tgtCcy: "", slOrdPx: "-1", secret: "not retained",
    closeOrderAlgo: [{ posCcy: "HYPE", ordType: "conditional", tgtCcy: "", secret: "not retained" }] };
  const safe = JSON.parse(runInNewContext(`${helpers}\nJSON.stringify(safe(row))`, { row }));
  assert.deepEqual(safe, { posCcy: "USDT", ordType: "oco", tgtCcy: "", slOrdPx: "-1",
    closeOrderAlgo: [{ posCcy: "HYPE", ordType: "conditional", tgtCcy: "" }] });
});
test("all leveraged symbols including HYPE are counted; OCO coverage is size/position and deduplicated", async () => {
  const calls = [];
  const rows = await loadLeveragedAccountRisk(async (path, params) => {
    calls.push([path, params]);
    if (path.endsWith("account/positions")) return [p(), p({ instId: "BTC-USDT-SWAP", posId: "b1", pos: "2", posSide: "long", lever: "3" })];
    return params.ordType === "oco" ? [o(), o(), o({ algoId: "wrong", side: "sell" }), o({ algoId: "notReducing", reduceOnly: "false" })] : [];
  });
  assert.equal(calls[0][1]?.instId, undefined);
  assert.ok(calls.some(([, x]) => x?.ordType === "oco"));
  assert.equal(rows.positions.length, 2);
  assert.equal(rows.positions[0].stopCoverage, 0.4);
  assert.equal(rows.positions[0].coverageLevel, "red");
  const risk = leverageRisk(rows, 60);
  assert.equal(risk.limit, 3);
  assert.equal(risk.positions[0].overLimit, true);
  assert.equal(risk.positions[1].overLimit, false);
  assert.equal(leverageRisk(rows, 70).positions[1].overLimit, true, "spot-only excludes even 1x perpetuals");
  assert.equal(leverageRisk(rows, 54.9).limit, 5);
  assert.equal(leverageRisk(rows, null).limit, null);
});

test("failed OCO reads are unknown not zero/100, closeFraction=1 is full and shorts must close with buy", async () => {
  const get = async (path, params) => path.endsWith("account/positions") ? [p()]
    : params.ordType === "oco" ? [o({ sz: "", closeFraction: "1" })] : [];
  assert.equal((await loadLeveragedAccountRisk(get)).positions[0].stopCoverage, 1);
  const failed = await loadLeveragedAccountRisk(async (path) => {
    if (path.endsWith("account/positions")) return [p()];
    throw new Error("HTTP 403");
  });
  assert.equal(failed.positions[0].stopCoverage, null);
  assert.equal(failed.complete, false);
});

test("OKX requests always carry browser User-Agent and remain GET only", async () => {
  let options;
  const get = createOkxReadOnlyClient({ apiKey: "test", secretKey: "test", passphrase: "test", fetchImpl: async (_, opts) => {
    options = opts;
    return { ok: true, json: async () => ({ code: "0", data: [] }) };
  } });
  await get("/api/v5/trade/orders-algo-pending", { ordType: "oco" });
  assert.match(options.headers["User-Agent"], /Mozilla\/5\.0/);
  assert.ok(!options.method || options.method === "GET");
  await assert.rejects(get("/api/v5/trade/order"), /read.only|allowlist/);
});

test("historical feature availability respects ETF publication lag and quote-currency normalization", () => {
  const dates = Array.from({ length: 20 }, (_, i) => new Date(Date.parse("2026-10-01") + i * DAY).toISOString().slice(0, 10));
  const history = buildPercentileHistory({
    btc: dates.map(date => ({ date, close: 100 })),
    coinbase: dates.map(date => ({ date, close: 99 })),
    usdt: dates.map(date => ({ date, close: 0.99 })),
    etf: dates.map(date => ({ date, flowUsd: 10 })),
    stablecoin: dates.map((date, i) => ({ date, supply: 100 + i }))
  });
  assert.equal(history.premium[0].value, 0, "USDT depeg is not a Coinbase discount");
  assert.equal(history.etf5[0].availableAt, "2026-10-07T00:00:00.000Z");
  assert.equal(percentileInputsAt(history, Date.parse("2026-10-06T23:00:00Z")).values.etf5, null);
  assert.equal(percentileInputsAt(history, Date.parse("2026-10-07T00:00:00Z")).values.etf5, 50);
  assert.equal(percentileInputsAt(history, Date.parse("2026-11-03T00:00:00Z")).values.premium, null, "old value is not restamped fresh");
  const gap = buildPercentileHistory({ btc: dates.filter((_, i) => i !== 8).map(date => ({ date, close: 100 })) });
  assert.ok(!gap.vol7.some(r => r.date === dates[10]), "missing daily closes cannot be compressed into a seven-day window");
  assert.equal(percentileScore(2, series, now, { observationDate: series.at(-1).date }).n, 364, "current raw observation does not rank itself");
});

test("ETF parser requires Total, converts USD millions, and never treats blank totals as zero", () => {
  const rows = Array.from({ length: 6 }, (_, i) => `<tr><td>${10 + i} Jan 2026</td><td>99</td><td>${i === 5 ? "-" : i === 0 ? "(12.5)" : "20"}</td><td>999</td></tr>`).join("");
  const flows = parseEtfFlows(`<table><tr><th>Date</th><th>IBIT</th><th>Total</th><th>Other</th></tr>${rows}</table>`);
  assert.equal(flows.length, 5);
  assert.equal(flows[0].flowUsd, -12.5e6);
  assert.equal(flows.at(-1).flowUsd, 20e6);
  assert.throws(() => parseEtfFlows("<html>Cloudflare challenge</html>"), /unavailable/);
});

test("complete candle collector ignores unfinished/future bars and fails on a stuck pagination cursor", async () => {
  const end = Date.parse("2026-11-03T00:00:00Z");
  const rows = Array.from({ length: 40 }, (_, i) => [String(end - i * DAY), "0", "0", "0", "100", "0", "0", "0", i === 0 ? "0" : "1"]);
  let ua;
  const values = await loadRadarDailyHistory("BTC-USDT", { nowMs: end, fetchImpl: async (_, options) => {
    ua = options.headers["User-Agent"];
    return { ok: true, json: async () => ({ code: "0", data: rows }) };
  } });
  assert.match(ua, /Mozilla/);
  assert.equal(values.at(-1).date, "2026-11-02");
  await assert.rejects(loadRadarDailyHistory("BTC-USDT", { nowMs: end, fetchImpl: async () => ({ ok: true,
    json: async () => ({ code: "0", data: [...rows, ...rows, ...rows].slice(0, 100) }) }) }), /cursor/);
});

test("OCO pagination reads beyond 100 and keeps partial/error/ambiguous results unknown", async () => {
  let pages = 0;
  const rows = await loadLeveragedAccountRisk(async (path, params = {}) => {
    if (path.endsWith("account/positions")) return [p()];
    if (params.ordType === "oco") {
      pages++;
      return params.after ? [o({ algoId: "cover", sz: "10" })] : Array.from({ length: 100 }, (_, i) => o({ algoId: String(i), instId: "OTHER-USDT-SWAP" }));
    }
    return [];
  });
  assert.equal(pages, 2);
  assert.equal(rows.positions[0].stopCoverage, 1);
  const ambiguous = await loadLeveragedAccountRisk(async (path, params = {}) => path.endsWith("account/positions") ? [p(), p({ posId: "h2" })]
    : params.ordType === "oco" ? [o({ sz: "10" })] : []);
  assert.equal(ambiguous.positions[0].stopCoverage, null);
});

test("all grid/DCA instrument subaccounts are inspected, not just BTC", async () => {
  const account = await loadLeveragedAccountRisk(async (path) => {
    if (path.endsWith("ongoing-list")) return [{ instId: "HYPE-USDT-SWAP", algoId: "h", direction: "short", lever: "7", state: "running" }];
    if (path.endsWith("position-details")) return [{ sz: "12" }];
    return [];
  });
  assert.equal(account.positions.length, 1);
  assert.equal(account.positions[0].instId, "HYPE-USDT-SWAP");
  assert.equal(account.positions[0].stopCoverage, null, "bot stop is not inferred from ordinary OCO orders");
  assert.equal(leverageRisk(account, 50).positions[0].overLimit, true);
});

test("malformed DCA/grid sizes fail closed instead of becoming a complete empty portfolio", async () => {
  for (const kind of ["dca", "grid"]) {
    const listing = kind === "dca" ? "/api/v5/tradingBot/dca/ongoing-list" : "/api/v5/tradingBot/grid/orders-algo-pending";
    const details = kind === "dca" ? "/api/v5/tradingBot/dca/position-details" : "/api/v5/tradingBot/grid/positions";
    for (const value of [undefined, null, "", " ", "bad", "Infinity", false, []]) {
      const account = await loadLeveragedAccountRisk(async path => path === listing
        ? [{ instId: "HYPE-USDT-SWAP", algoId: "h", direction: "short", state: "running" }]
        : path === details ? [{ [kind === "dca" ? "sz" : "pos"]: value, posSide: "short" }] : []);
      assert.equal(account.complete, false, `${kind}: ${JSON.stringify(value)}`);
      assert.ok(account.errors.some(message => message.includes(kind) && /size/i.test(message)));
    }
    const zero = await loadLeveragedAccountRisk(async path => path === listing
      ? [{ instId: "HYPE-USDT-SWAP", algoId: "h", direction: "short", state: "running" }]
      : path === details ? [{ [kind === "dca" ? "sz" : "pos"]: "0" }] : []);
    assert.equal(zero.complete, true, "an explicit numeric zero is a known empty position");
    assert.deepEqual(zero.positions, []);
    assert.deepEqual(zero.errors, []);
  }
});

test("backtest separates incomplete full model from reduced diagnostics and computes tied Spearman", () => {
  assert.equal(spearman([[1, 3], [2, 2], [3, 1]]), -1);
  assert.equal(spearman([[1, 1], [1, 2], [1, 3]]), null);
  const report = studyV3({});
  assert.equal(report.fullModel.days, 0);
  assert.equal(report.fullModel.horizons[1].spearman, null);
  assert.equal(report.distributionAcceptance, false);
});

test("malformed account sizes/sides are not silently dropped into an apparently empty portfolio", async () => {
  await assert.rejects(loadLeveragedAccountRisk(async path => path.endsWith("account/positions") ? [p({ pos: "bad" })] : []), /Position size/);
  await assert.rejects(loadLeveragedAccountRisk(async path => path.endsWith("account/positions") ? [p({ posSide: "" })] : []), /identity/);
});
