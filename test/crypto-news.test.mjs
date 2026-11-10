import assert from "node:assert/strict";
import test from "node:test";
import { collectCryptoNews, CRYPTO_NEWS_SOURCES, matchNewsToInstrument, parseNewsFeed, parseOkxAnnouncements } from "../src/crypto-news.mjs";

const NOW = Date.parse("2026-10-31T08:00:00Z");
const stamp = new Date(NOW - 3_600_000).toISOString();
const source = CRYPTO_NEWS_SOURCES.find(row => row.id === "coindesk");
const item = (title, url = "https://www.coindesk.com/markets/bitcoin-update", publishedAt = stamp) => `<item><title><![CDATA[${title}]]></title><link>${url.replaceAll("&", "&amp;")}</link><pubDate>${publishedAt}</pubDate><description>Full article text must not be copied</description></item>`;
const rss = (...items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Publisher</title>${items.join("")}</channel></rss>`;
const parse = text => parseNewsFeed(text, { source, now: NOW, fetchedAt: new Date(NOW).toISOString() });
const okxHtml = (rows = [{ slug: "okx-to-update-account-mode", title: "欧易账户模式调整公告", publishTime: NOW - 3_600_000 }], overrides = {}) => `<html><script type="application/json" id="appState">${JSON.stringify({ appContext: { isSSRSuccess: true, serverSideProps: { isTransientCmsFailure: false, page: 1, cfLocale: "zh-CN" }, initialProps: { sectionData: { articleList: { list: rows, total: rows.length, pageNum: 1, pageSize: 15 } } }, ...overrides } })}</script></html>`;
const instrument = (base, name = base) => ({ instId: `${base}-USDT`, name, kind: "crypto" });
function responses(content = {}) {
  return async (href, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.headers["User-Agent"], "Mozilla/5.0");
    const entry = CRYPTO_NEWS_SOURCES.find(row => row.url === href);
    assert.ok(entry, "only fixed public sources may be fetched");
    const value = content[entry.id];
    if (value === "FAIL") throw new Error("network failed");
    return new Response(value ?? (entry.kind === "announcement" ? okxHtml() : rss()), { status: 200 });
  };
}

test("RSS extracts headline evidence only, decodes entities, and canonicalizes duplicates", () => {
  const rows = parse(rss(item("Bitcoin &amp; markets &#8217; update", "https://www.coindesk.com/markets/bitcoin-update?utm_source=rss#tracking"), item("Duplicate", "https://www.coindesk.com/markets/bitcoin-update?utm_medium=feed")));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Bitcoin & markets ’ update");
  assert.equal(rows[0].url, "https://www.coindesk.com/markets/bitcoin-update");
  assert.equal(rows[0].publishedAt, stamp);
  assert.equal(rows[0].fetchedAt, new Date(NOW).toISOString());
  assert.equal(rows[0].sourceId, "coindesk");
  assert.doesNotMatch(JSON.stringify(rows), /Full article|description|summary/);
});

test("RSS rejects invalid documents and excludes unsafe links, stale dates and future publication", () => {
  for (const text of ["<html>challenge</html>", "<error>upstream unavailable</error>", "<rss><channel><item></channel></rss>", '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel/></rss>', "x".repeat(2_000_001)]) assert.throws(() => parse(text));
  const rows = parse(rss(item("Bitcoin phishing", "https://www.coindesk.com.evil.example/update"), item("Bitcoin userinfo", "https://user:secret@www.coindesk.com/update"), item("Bitcoin javascript", "javascript:alert(1)"), item("Bitcoin old", undefined, new Date(NOW - 8 * 86_400_000).toISOString()), item("Bitcoin future", undefined, new Date(NOW + 6 * 60_000).toISOString()), item("Bitcoin no date", undefined, "bad")));
  assert.deepEqual(rows, []);
  assert.deepEqual(parse(rss()), [], "a valid empty feed is distinguishable from a failed fetch");
});

test("conservative identities reject common-word and obsolete-symbol collisions", () => {
  const misses = [["HYPE", "Crypto market hype rises"], ["LIT", "Litentry LIT token rallies"], ["LIT", "New lighter electric car arrives as crypto prices rise"], ["LIT", "Lighter meals for a better world; Bitcoin exchange trading grows elsewhere"], ["CHIP", "AI chip stocks gain"], ["NFT", "NFT art market rebounds"], ["GRASS", "Grass lawns need water"], ["NEAR", "Bitcoin near record as protocols expand"], ["CRV", "Treasury yield curve steepens"], ["ZAMA", "Zama restaurant opens"], ["PUMP", "Bitcoin price pump triggers liquidations"]];
  for (const [base, title] of misses) assert.deepEqual(matchNewsToInstrument({ title }, instrument(base)), [], title);
  const matches = [["HYPE", "Hyperliquid expands its exchange"], ["LIT", "Lighter DEX announces perpetual market update"], ["CHIP", "USD.AI raises funding"], ["NFT", "AINFT launches new feature"], ["GRASS", "Grass DePIN network adds users"], ["NEAR", "NEAR Protocol upgrades"], ["CRV", "Curve Finance proposes change"], ["CRV", "$CRV holders vote"], ["UNI", "Uniswap introduces update"], ["LTC", "Litecoin transaction activity rises"], ["BTC", "Bitcoin ETF flows improve"], ["PAXG", "PAX Gold supply grows"], ["OKB", "OKB receives exchange update"], ["ZAMA", "Zama FHE protocol launches"], ["PUMP", "Pump.fun announces new feature"], ["SPCX", "SpaceX launches another mission"], ["ANTHROPIC", "Anthropic releases Claude update"]];
  for (const [base, title] of matches) assert.ok(matchNewsToInstrument({ title }, instrument(base)).length, title);
});

test("verified official announcements match exact uppercase instrument symbols without broad media aliases", () => {
  const official = title => ({ title, kind: "announcement", sourceId: "okx-announcements" });
  assert.deepEqual(matchNewsToInstrument(official("欧易调整HYPEUSDT永续合约参数"), instrument("HYPE")), ["HYPEUSDT"]);
  for (const base of ["LIT", "CHIP", "NFT"]) assert.deepEqual(matchNewsToInstrument(official("欧易关于 LIT、CHIP、NFT 的公告"), instrument(base)), [base]);
  assert.deepEqual(matchNewsToInstrument(official("欧易调整 FOONFT 交易参数"), instrument("NFT")), []);
  assert.deepEqual(matchNewsToInstrument({ title: "NFT art market update", kind: "news", sourceId: "coindesk" }, instrument("NFT")), []);
});

test("OKX global SSR requires a completed first-page result and keeps global notices separate", () => {
  const official = CRYPTO_NEWS_SOURCES.find(row => row.id === "okx-announcements");
  const rows = parseOkxAnnouncements(okxHtml(), { source: official, now: NOW, fetchedAt: new Date(NOW).toISOString() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "announcement");
  assert.equal(rows[0].url, "https://www.okx.com/zh-hans/help/okx-to-update-account-mode");
  for (const html of [okxHtml([], { isSSRSuccess: false }), okxHtml([], { serverSideProps: { isTransientCmsFailure: true, page: 1, cfLocale: "zh-CN" } }), okxHtml([], { serverSideProps: { isTransientCmsFailure: false, page: 2, cfLocale: "zh-CN" } }), "<html>Sign in</html>"]) assert.throws(() => parseOkxAnnouncements(html, { source: official, now: NOW, fetchedAt: new Date(NOW).toISOString() }));
});

test("collection shares per-base news, declares limited source coverage, and does not guess unknown identities", async () => {
  const report = await collectCryptoNews({ instruments: [instrument("GRASS", "Grass"), { ...instrument("GRASS"), instId: "GRASS-USDT-SWAP" }, instrument("BTC", "Bitcoin"), instrument("UNKNOWN")], now: NOW,
    fetchImpl: responses({ coindesk: rss(item("Grass DePIN network expands"), item("Bitcoin expands", "https://www.coindesk.com/markets/bitcoin-story")) }) });
  assert.equal(report.status, "OK");
  assert.equal(report.windowDays, 7);
  assert.equal(report.byBase.length, 3);
  assert.equal(report.byBase[0].items.length, 1);
  assert.equal(report.byBase[0].items[0].matchedTerms[0], "Grass");
  assert.equal(report.byBase[2].status, "UNSUPPORTED");
  assert.equal(report.announcements.length, 1);
  assert.equal(report.byBase[1].items.some(row => row.title.includes("账户模式")), false);
  for (const entry of report.sources) assert.match(entry.coverage, /部分|最新|非完整/);
});

test("failed sources use only same-source validated caches without restamping publication or fetch times", async () => {
  const first = await collectCryptoNews({ instruments: [instrument("BTC")], now: NOW, fetchImpl: responses({ coindesk: rss(item("Bitcoin update")) }) });
  const second = await collectCryptoNews({ instruments: [instrument("BTC")], previous: first, now: NOW + 3_600_000, fetchImpl: responses({ coindesk: "FAIL" }) });
  assert.equal(second.status, "PARTIAL");
  const cached = second.sources.find(row => row.id === "coindesk");
  assert.equal(cached.status, "CACHED");
  assert.equal(cached.items[0].fetchedAt, first.sources[0].items[0].fetchedAt);
  assert.equal(cached.items[0].publishedAt, stamp);
  assert.equal(cached.lastAttemptAt, new Date(NOW + 3_600_000).toISOString());
  assert.equal(second.byBase[0].status, "PARTIAL");
  const tampered = structuredClone(first);
  tampered.sources[0].url = "https://evil.example/feed";
  const rejected = await collectCryptoNews({ instruments: [instrument("BTC")], previous: tampered, now: NOW, fetchImpl: responses({ coindesk: "FAIL" }) });
  assert.equal(rejected.sources[0].status, "FAILED");
  assert.deepEqual(rejected.sources[0].items, []);
  const malformed = await collectCryptoNews({ instruments: [instrument("BTC")], previous: { sources: {} }, now: NOW, fetchImpl: responses({ coindesk: "FAIL" }) });
  assert.equal(malformed.sources[0].status, "FAILED", "JSON-valid malformed prior state cannot abort the whole collector");
  const cleared = await collectCryptoNews({ instruments: [instrument("BTC")], previous: first, now: NOW + 3_600_000, fetchImpl: responses() });
  assert.equal(cleared.sources[0].status, "OK");
  assert.deepEqual(cleared.sources[0].items, []);
  assert.equal(cleared.byBase[0].status, "NO_MATCHES");
});

test("the combined source pool preserves older matching headlines beyond the first hundred results", async () => {
  const coindesk = rss(...Array.from({ length: 100 }, (_, index) => item(`Market update ${index}`, `https://www.coindesk.com/markets/update-${index}`)));
  const decrypt = rss(item("SpaceX launches mission", "https://decrypt.co/12345/spacex-mission", new Date(NOW - 2 * 3_600_000).toISOString()));
  const report = await collectCryptoNews({ instruments: [instrument("SPCX")], now: NOW, fetchImpl: responses({ coindesk, decrypt }) });
  assert.equal(report.byBase[0].items.length, 1);
  assert.equal(report.byBase[0].items[0].sourceId, "decrypt");
});

test("all failed sources and overlarge responses remain explicit unavailable states", async () => {
  const report = await collectCryptoNews({ instruments: [instrument("BTC")], now: NOW, fetchImpl: responses(Object.fromEntries(CRYPTO_NEWS_SOURCES.map(row => [row.id, "FAIL"]))) });
  assert.equal(report.status, "FAILED");
  assert.equal(report.byBase[0].status, "UNAVAILABLE");
  assert.equal(report.errors.length, CRYPTO_NEWS_SOURCES.length);
  const bounded = await collectCryptoNews({ instruments: [instrument("BTC")], now: NOW, fetchImpl: async () => new Response("x".repeat(2_000_001)) });
  assert.equal(bounded.status, "FAILED");
});
