import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchPersonalAssetRates, getPersonalAssetRates, valuePersonalAssetState } from "../src/personal-assets-fx.mjs";

const at = new Date("2026-10-24T12:00:00Z");
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
function provider({ failFiat = false, failCoins = false, allFailed = false, cny = "7", dailyDate = "2026-10-23", coinTime = at.getTime() / 1000 - 10 } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    if (allFailed) throw new Error("synthetic private upstream response");
    if (url.startsWith("https://api.coinbase.com/")) {
      if (failFiat) return json({}, 503);
      return json({ data: { currency: "USD", rates: { USD: "1", CNY: cny, HKD: "8", EUR: "0.9", GBP: "0.8", JPY: "150", SGD: "1.3", AUD: "1.5", USDT: "1", USDC: "1" } } });
    }
    if (url.startsWith("https://api.frankfurter.dev/")) return json({ amount: 1, base: "USD", date: dailyDate, rates: { CNY: 6.9, HKD: 7.9, EUR: 0.88, GBP: 0.77, JPY: 149, SGD: 1.28, AUD: 1.48 } });
    if (url.startsWith("https://api.kraken.com/")) {
      if (failCoins) return json({}, 503);
      const usdt = url.includes("USDTUSD");
      return json({ error: [], result: { [usdt ? "USDTZUSD" : "USDCUSD"]: [[usdt ? "0.98" : "1.02", "1", coinTime, "b", "m", "", 1]], last: "synthetic-id" } });
    }
    throw new Error("Unexpected public host");
  };
  return { requests, fetchImpl };
}
async function fixture(context) {
  const stateDir = await mkdtemp(join(tmpdir(), "asset-fx-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test("automatic CNY cross rates use one USD basis and independent stablecoin market prices", async () => {
  const api = provider();
  const fx = await fetchPersonalAssetRates({ ...api, now: at });
  assert.equal(fx.rates.USD.value, 7);
  assert.equal(fx.rates.HKD.value, 7 / 8);
  assert.equal(fx.rates.JPY.value, 7 / 150);
  assert.equal(fx.rates.USDT.value, 0.98 * 7);
  assert.equal(fx.rates.USDC.value, 1.02 * 7);
  assert.equal(fx.rates.USD.asOf, null, "retrieval time is not invented market observation time");
  assert.equal(fx.rates.USD.timeBasis, "retrieved");
  assert.equal(fx.rates.USDT.asOf, new Date(at.getTime() - 10_000).toISOString());
  assert.deepEqual(fx.errors, []);
  assert.equal(api.requests.length, 3);
});

test("a failed current FX source falls back to explicitly dated daily reference rates", async () => {
  const fx = await fetchPersonalAssetRates({ ...provider({ failFiat: true }), now: at });
  assert.equal(fx.rates.USD.value, 6.9);
  assert.equal(fx.rates.HKD.value, 6.9 / 7.9);
  assert.equal(fx.rates.USD.date, "2026-10-23");
  assert.equal(fx.rates.USD.asOf, null);
  assert.equal(fx.rates.USD.timeBasis, "daily");
  assert.match(fx.errors.join(" "), /日参考/);
});

test("missing or stale stablecoin quotes stay unknown instead of pegged to USD", async () => {
  for (const options of [{ failCoins: true }, { coinTime: at.getTime() / 1000 - 90_000 }, { coinTime: at.getTime() / 1000 + 300 }]) {
    const fx = await fetchPersonalAssetRates({ ...provider(options), now: at });
    assert.equal(fx.rates.USDT, undefined);
    assert.equal(fx.rates.USDC, undefined);
    assert.equal(fx.rates.USD.value, 7);
    assert.match(fx.errors.join(" "), /未按 1 美元/);
  }
});

test("invalid numeric FX and very old daily references do not enter valuations", async () => {
  const fx = await fetchPersonalAssetRates({ ...provider({ cny: "Infinity", dailyDate: "2026-01-01" }), now: at });
  assert.equal(fx.rates.USD, undefined);
  assert.equal(fx.rates.HKD, undefined);
  assert.equal(fx.rates.USDT, undefined);
});

test("cache refresh is shared, private, bounded by TTL and independent of asset revisions", async (context) => {
  const stateDir = await fixture(context);
  const path = join(stateDir, "personal-assets.json");
  await writeFile(path, '{"revision":42,"unchanged":true}\n');
  const api = provider();
  const [one, two] = await Promise.all([getPersonalAssetRates({ stateDir, ...api, now: at }), getPersonalAssetRates({ stateDir, ...api, now: at })]);
  assert.equal(one.status, "fresh");
  assert.deepEqual(one, two);
  assert.equal(api.requests.length, 3);
  await getPersonalAssetRates({ stateDir, ...api, now: new Date(at.getTime() + 4 * 60_000) });
  assert.equal(api.requests.length, 3);
  await getPersonalAssetRates({ stateDir, ...api, now: new Date(at.getTime() + 6 * 60_000) });
  assert.equal(api.requests.length, 6);
  assert.equal((await stat(join(stateDir, "personal-assets-fx.json"))).mode & 0o777, 0o600);
  assert.equal(await readFile(path, "utf8"), '{"revision":42,"unchanged":true}\n');
});

test("failed refresh retains last successful rates with explicit stale status and safe errors", async (context) => {
  const stateDir = await fixture(context);
  await getPersonalAssetRates({ stateDir, ...provider(), now: at });
  const later = new Date(at.getTime() + 6 * 60_000);
  const fx = await getPersonalAssetRates({ stateDir, ...provider({ allFailed: true }), now: later });
  assert.equal(fx.status, "stale");
  assert.equal(fx.rates.USD.value, 7);
  assert.equal(fx.rates.USD.fetchedAt, at.toISOString());
  assert.equal(fx.rates.USD.stale, true);
  assert.doesNotMatch(JSON.stringify(fx), /synthetic private/);
  const expired = await getPersonalAssetRates({ stateDir, ...provider({ allFailed: true }), now: new Date(at.getTime() + 8 * 86_400_000) });
  assert.equal(expired.status, "unavailable");
  assert.deepEqual(expired.rates, {});
});

test("view replaces manual FX with automatic rates without changing original currencies or amounts", async (context) => {
  const stateDir = await fixture(context);
  const state = { revision: 9, snapshots: [], portfolio: { accounts: [], entries: [{ currency: "HKD", amount: 100 }], rates: { CNY: { value: 1, date: "2026-10-24" }, USD: { value: 99, date: "2026-10-24" } } } };
  const unchanged = JSON.stringify(state);
  const view = await valuePersonalAssetState(state, { stateDir, ...provider(), now: at });
  assert.equal(view.portfolio.rates.USD.value, 7);
  assert.equal(view.portfolio.rates.HKD.value, 7 / 8);
  assert.deepEqual(view.portfolio.entries, state.portfolio.entries);
  assert.equal(view.revision, 9);
  assert.equal(JSON.stringify(state), unchanged);
});

test("initial upstream failure never presents old manual rates as automatic live data", async (context) => {
  const stateDir = await fixture(context);
  const state = { revision: 2, portfolio: { accounts: [], entries: [], rates: { USD: { value: 99, date: "2026-10-24" } } } };
  const view = await valuePersonalAssetState(state, { stateDir, ...provider({ allFailed: true }), now: at });
  assert.equal(view.fx.status, "unavailable");
  assert.deepEqual(Object.keys(view.portfolio.rates), ["CNY"]);
});

test("an orphaned cache lock cannot permanently disable valuation refresh", async (context) => {
  const stateDir = await fixture(context);
  const lock = join(stateDir, "personal-assets-fx.json.lock");
  await writeFile(lock, "synthetic-owner");
  const api = provider();
  const result = await getPersonalAssetRates({ stateDir, ...api, now: at });
  assert.equal(result.status, "fresh");
  assert.equal(api.requests.length, 3);
  assert.equal(await readFile(lock, "utf8"), "synthetic-owner");
});

test("cache lifetime also respects original trade and daily reference observation dates", async (context) => {
  const stateDir = await fixture(context);
  const api = provider({ failFiat: true, dailyDate: "2026-10-18", coinTime: at.getTime() / 1000 - 23 * 3600 });
  await getPersonalAssetRates({ stateDir, ...api, now: at });
  const twoHoursLater = await getPersonalAssetRates({ stateDir, ...provider({ allFailed: true }), now: new Date(at.getTime() + 2 * 3600_000) });
  assert.equal(twoHoursLater.rates.USD.value, 6.9);
  assert.equal(twoHoursLater.rates.USDT, undefined);
  assert.equal(twoHoursLater.rates.USDC, undefined);
  const twoDaysLater = await getPersonalAssetRates({ stateDir, ...provider({ allFailed: true }), now: new Date(at.getTime() + 48 * 3600_000) });
  assert.equal(twoDaysLater.rates.USD, undefined);
  assert.equal(twoDaysLater.status, "unavailable");
});

test("a newly retrieved old market trade is marked delayed while fresh fiat rates remain current", async (context) => {
  const stateDir = await fixture(context);
  const fx = await getPersonalAssetRates({ stateDir, ...provider({ coinTime: at.getTime() / 1000 - 23 * 3600 }), now: at });
  assert.equal(fx.status, "stale");
  assert.equal(fx.rates.USDT.stale, true);
  assert.equal(fx.rates.USDC.stale, true);
  assert.equal(fx.rates.USD.stale, false);
  assert.equal(fx.rates.USDT.fetchedAt, at.toISOString());
});
