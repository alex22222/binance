import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCryptoWatch, runCryptoWatch, validateWatchlist } from "../src/crypto-watch.mjs";

const NOW = Date.parse("2026-10-31T00:00:00Z");
const DAY = 86_400_000;
const list = (instruments = [{ instId: "BTC-USDT", name: "Bitcoin", kind: "crypto" }]) => ({
  schemaVersion: 1, source: "OKX Desktop 自选 / 全部", sourceUrl: "https://www.okx.com/zh-hans/markets/favorite",
  syncedAt: new Date(NOW).toISOString(), instruments
});
const json = (value) => ({ ok: true, status: 200, json: async () => value });
function responses(overrides = {}) {
  return async (href, options) => {
    assert.equal(options.method, "GET");
    assert.equal(new URL(href).origin, "https://openapi.okx.com");
    assert.equal(options.headers?.["OK-ACCESS-KEY"], undefined);
    const url = new URL(href), instId = url.searchParams.get("instId");
    let data;
    if (url.pathname.endsWith("/ticker")) data = [{ instId, last: "110", open24h: "100", high24h: "115", low24h: "95", volCcy24h: "9000", bidPx: "109", askPx: "111", ts: String(NOW) }];
    else if (url.pathname.endsWith("/candles")) data = Array.from({ length: 9 }, (_, index) => [String(NOW - index * DAY), "100", "115", "95", String(110 - index), "1", "1", "1", index ? "1" : "0"]);
    else if (url.pathname.endsWith("/funding-rate")) data = [{ instId, fundingRate: "0.0001", fundingTime: String(NOW + 8 * 3_600_000), ts: String(NOW) }];
    else throw new Error("Unexpected URL");
    const replacement = overrides[url.pathname];
    if (replacement === "FAIL") throw new Error("offline");
    return json(replacement ? replacement(data, instId) : { code: "0", data });
  };
}
async function directory(watchlist = list()) {
  const path = await mkdtemp(join(tmpdir(), "crypto-watch-"));
  await writeFile(join(path, "watchlist.json"), JSON.stringify(watchlist));
  return path;
}

test("requires exact, unique instrument identities and explicit snapshot provenance", () => {
  assert.equal(validateWatchlist(list()).instruments[0].instId, "BTC-USDT");
  for (const value of [list([{ instId: "btc-usdt", name: "BTC", kind: "crypto" }]), list([{ instId: "BTC", name: "BTC", kind: "crypto" }]), list([list().instruments[0], list().instruments[0]]), { ...list(), syncedAt: "bad" }, list(Array.from({ length: 101 }, (_, index) => ({ instId: `A${index}-USDT`, name: "A", kind: "crypto" })))]) {
    assert.throws(() => validateWatchlist(value));
  }
  assert.equal(validateWatchlist(list([])).instruments.length, 0);
});

test("collects public daily metrics with spot/swap units kept distinct", async () => {
  const path = await directory(list([{ instId: "BTC-USDT", name: "Bitcoin", kind: "crypto" }, { instId: "GRASS-USDT-SWAP", name: "Grass", kind: "crypto" }]));
  const report = await runCryptoWatch({ directory: path, fetchImpl: responses(), now: () => new Date(NOW) });
  assert.equal(report.status, "OK");
  assert.equal(report.date, "2026-10-31");
  assert.equal(report.tokens.length, 2);
  const [spot, swap] = report.tokens;
  assert.ok(Math.abs(spot.change24hPct - 10) < 1e-9);
  assert.equal(spot.volume24hQuote, 9000);
  assert.equal(spot.fundingRatePct, null);
  assert.equal(swap.volume24hQuote, null, "derivative base-volume is never mislabeled quote turnover");
  assert.equal(swap.fundingRatePct, 0.01);
  assert.ok(Math.abs(spot.return7dPct - (109 / 102 - 1) * 100) < 1e-9);
  const view = await loadCryptoWatch({ directory: path, now: NOW });
  assert.equal(view.status, "AVAILABLE");
  assert.equal(view.lastAttempt.status, "OK");
  assert.equal(view.history.length, 1);
  assert.equal(JSON.parse(await readFile(join(path, "state.json"), "utf8")).lastRunAt, new Date(NOW).toISOString());
  assert.equal(JSON.parse(await readFile(join(path, "daily", "2026-10-31.json"), "utf8")).tokens[1].instId, "GRASS-USDT-SWAP");
});

test("wrong ticker identity and stale timestamps fail the row without fabricated prices", async () => {
  for (const override of [(data) => ({ code: "0", data: [{ ...data[0], instId: "ETH-USDT" }] }), (data) => ({ code: "0", data: [{ ...data[0], ts: String(NOW - 3_600_000) }] }), (data) => ({ code: "0", data: [{ ...data[0], last: null }] })]) {
    const path = await directory();
    const report = await runCryptoWatch({ directory: path, fetchImpl: responses({ "/api/v5/market/ticker": override }), now: NOW });
    assert.equal(report.status, "FAILED");
    assert.equal(report.tokens[0].instId, "BTC-USDT");
    assert.equal(report.tokens[0].price, null);
    assert.equal(report.tokens[0].status, "FAILED");
  }
});

test("missing secondary data is partial and API error codes never count as an empty success", async () => {
  const path = await directory();
  const partial = await runCryptoWatch({ directory: path, fetchImpl: responses({ "/api/v5/market/candles": "FAIL" }), now: NOW });
  assert.equal(partial.status, "PARTIAL");
  assert.equal(partial.tokens[0].price, 110);
  assert.equal(partial.tokens[0].return7dPct, null);
  const failed = await runCryptoWatch({ directory: path, fetchImpl: responses({ "/api/v5/market/ticker": () => ({ code: "50011", data: [] }) }), now: NOW });
  assert.equal(failed.status, "FAILED");
});

test("total failure retains the previous valid report with a separate failed attempt", async () => {
  const path = await directory();
  const first = await runCryptoWatch({ directory: path, fetchImpl: responses(), now: NOW });
  await runCryptoWatch({ directory: path, fetchImpl: responses({ "/api/v5/market/ticker": "FAIL" }), now: NOW + DAY });
  const view = await loadCryptoWatch({ directory: path, now: NOW + DAY });
  assert.equal(view.status, "FAILED");
  assert.equal(view.latest.generatedAt, first.generatedAt);
  assert.equal(view.lastAttempt.status, "FAILED");
  assert.equal(view.history.length, 2);
  assert.equal(JSON.parse(await readFile(join(path, "daily", "2026-11-01.json"), "utf8")).status, "FAILED");
  assert.equal((await loadCryptoWatch({ directory: path, now: NOW + 3 * DAY })).stale, true);
  assert.equal((await loadCryptoWatch({ directory: path, now: NOW + 3 * DAY })).watchlistStale, true);
});

test("Shanghai date, missing files, and corrupted state are explicit", async () => {
  const path = await mkdtemp(join(tmpdir(), "crypto-watch-missing-"));
  assert.equal((await loadCryptoWatch({ directory: path, now: NOW })).status, "MISSING");
  await writeFile(join(path, "watchlist.json"), JSON.stringify(list([])));
  const empty = await runCryptoWatch({ directory: path, fetchImpl: responses(), now: NOW - 3_600_000 });
  assert.equal(empty.date, "2026-10-31");
  assert.equal(empty.status, "OK");
  await writeFile(join(path, "latest.json"), "{");
  assert.equal((await loadCryptoWatch({ directory: path, now: NOW })).status, "ERROR");
});

test("overlapping collectors cannot issue another set of network calls", async () => {
  const path = await directory();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const first = runCryptoWatch({ directory: path, now: NOW, fetchImpl: async (...args) => { started(); await blocked; return responses()(...args); } });
  await ready;
  await assert.rejects(runCryptoWatch({ directory: path, now: NOW, fetchImpl: () => { throw new Error("must not fetch"); } }), /already running/);
  release();
  await first;
});

test("dead process locks are recovered while active and incomplete locks remain untouched", async () => {
  const path = await directory();
  await writeFile(join(path, "collector.lock"), JSON.stringify({ pid: 2147483647, owner: "dead-test-process" }));
  assert.equal((await runCryptoWatch({ directory: path, fetchImpl: responses(), now: NOW })).status, "OK");
  await assert.rejects(readFile(join(path, "collector.lock")), { code: "ENOENT" });
  const active = JSON.stringify({ pid: process.pid, owner: "another-run" });
  await writeFile(join(path, "collector.lock"), active);
  await assert.rejects(runCryptoWatch({ directory: path, fetchImpl: responses(), now: NOW }), /already running/);
  assert.equal(await readFile(join(path, "collector.lock"), "utf8"), active);
  await writeFile(join(path, "collector.lock"), "");
  await assert.rejects(runCryptoWatch({ directory: path, fetchImpl: responses(), now: NOW }), /JSON|already running/);
  assert.equal(await readFile(join(path, "collector.lock"), "utf8"), "");
});

test("each observation uses its current response time during a slow collection", async () => {
  let current = NOW;
  const path = await directory();
  const fetchImpl = async (href, options) => {
    current += 11 * 60_000;
    const response = await responses()(href, options);
    const payload = await response.json();
    if (new URL(href).pathname.endsWith("/ticker")) payload.data[0].ts = String(current);
    return json(payload);
  };
  const report = await runCryptoWatch({ directory: path, fetchImpl, now: () => new Date(current) });
  assert.equal(report.status, "OK");
  assert.equal(report.tokens[0].observedAt, new Date(NOW + 11 * 60_000).toISOString());
});

function withNews(now = NOW, market = responses()) {
  return async (href, options) => {
    const url = new URL(href);
    if (url.hostname === "openapi.okx.com") return market(href, options);
    if (url.hostname === "www.okx.com") {
      const state = { appContext: { isSSRSuccess: true, serverSideProps: { isTransientCmsFailure: false, page: 1, cfLocale: "zh-CN" }, initialProps: { sectionData: { articleList: { pageNum: 1, pageSize: 15, total: 1, list: [{ id: "bitcoin-maintenance", slug: "bitcoin-maintenance", title: "OKX BTC wallet maintenance", publishTime: now - 60_000, categorySlug: "announcements", sectionSlug: "announcements-trading-updates" }] } } } } };
      return new Response(`<html><script type="application/json" id="appState">${JSON.stringify(state)}</script></html>`);
    }
    if (!["www.coindesk.com", "cointelegraph.com", "decrypt.co"].includes(url.hostname)) throw new Error("Unexpected news source");
    return new Response(`<rss><channel><title>Test feed</title><item><title>Bitcoin network update</title><link>https://${url.hostname}/news/bitcoin-update</link><pubDate>${new Date(now - 60_000).toUTCString()}</pubDate></item></channel></rss>`);
  };
}

test("daily collection persists news independently with original source times and a per-base digest", async () => {
  const path = await directory();
  const report = await runCryptoWatch({ directory: path, fetchImpl: withNews(), now: NOW });
  assert.equal(report.status, "OK");
  assert.equal(report.news.status, "OK");
  assert.equal(report.news.sources.length, 4);
  const view = await loadCryptoWatch({ directory: path, now: NOW });
  assert.equal(view.news.generatedAt, new Date(NOW).toISOString());
  assert.ok(view.news.byBase.find(row => row.base === "BTC").items.length >= 3);
  assert.equal(view.news.sources[0].items[0].publishedAt, new Date(NOW - 60_000).toISOString());
  assert.equal(JSON.parse(await readFile(join(path, "news.json"), "utf8")).status, "OK");
});

test("new news survives total market failure without relabeling the old market report", async () => {
  const path = await directory();
  const first = await runCryptoWatch({ directory: path, fetchImpl: withNews(), now: NOW });
  await runCryptoWatch({ directory: path, fetchImpl: withNews(NOW + DAY, async () => { throw new Error("Market offline"); }), now: NOW + DAY });
  const view = await loadCryptoWatch({ directory: path, now: NOW + DAY });
  assert.equal(view.status, "FAILED");
  assert.equal(view.latest.generatedAt, first.generatedAt);
  assert.equal(view.news.status, "OK");
  assert.equal(view.news.generatedAt, new Date(NOW + DAY).toISOString());
  assert.equal(view.news.byBase[0].items[0].publishedAt, new Date(NOW + DAY - 60_000).toISOString());
});

test("unreadable news never hides a valid market snapshot or pretends that no news exists", async () => {
  const path = await directory();
  await runCryptoWatch({ directory: path, fetchImpl: withNews(), now: NOW });
  await writeFile(join(path, "news.json"), "{");
  const view = await loadCryptoWatch({ directory: path, now: NOW });
  assert.equal(view.status, "AVAILABLE");
  assert.equal(view.latest.tokens[0].price, 110);
  assert.equal(view.news.status, "FAILED");
  assert.match(view.news.errors.join(" "), /无法读取/);
});
