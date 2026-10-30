import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { fetchWalletAssets } from "../src/personal-assets-wallets.mjs";

const time = new Date("2026-10-24T12:30:00.000Z");
const now = () => time;
const credentials = { apiKey: "synthetic-wallet-key", secret: "synthetic-wallet-secret", passphrase: "synthetic-wallet-passphrase" };
const evm = `0x${"a1".repeat(20)}`;
const otherEvm = `0x${"b2".repeat(20)}`;
const solana = "11111111111111111111111111111112";
const usdtEth = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const usdtSol = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const unknownEth = `0x${"c3".repeat(20)}`;
const balancePath = "/api/v6/dex/balance/all-token-balances-by-address";
const defiPath = "/api/v6/defi/user/asset/platform/list";
const wallets = [{ chainIndex: "1", address: evm }, { chainIndex: "501", address: solana }];
const token = (wallet, contract, symbol, balance, tokenPrice, extra = {}) => ({ address: wallet.address, chainIndex: wallet.chainIndex,
  tokenContractAddress: contract, symbol, balance, tokenPrice, rawBalance: "", isRiskToken: false, ...extra });
function fixture() {
  return {
    balances: {
      "1": [token(wallets[0], "", "ETH", "0.25", "2000"), token(wallets[0], usdtEth, "USDT", "100.125", "1")],
      "501": [token(wallets[1], "", "SOL", "2", "100"), token(wallets[1], usdtSol, "USDT", "3.5", "1")],
    },
    defi: { assetStatus: 1, updateAt: time.getTime(), walletIdPlatformList: [] },
    quote: { error: [], result: { USDTZUSD: [["0.998", "2", time.getTime() / 1000, "b", "m", ""]], last: "1" } },
  };
}
function fakeFetch(data = fixture(), intercept) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input); calls.push({ url: input, init });
    const response = intercept?.(url, init);
    if (response) return response;
    if (url.hostname === "api.kraken.com") return Response.json(data.quote);
    assert.equal(url.origin, "https://web3.okx.com");
    if (url.pathname === balancePath) return Response.json({ code: "0", data: [{ tokenAssets: data.balances[url.searchParams.get("chains")] }] });
    if (url.pathname === defiPath) return Response.json({ code: 0, data: data.defi });
    throw new Error("Unexpected synthetic endpoint");
  };
  return { fetchImpl, calls };
}
const run = (options = {}) => fetchWalletAssets({ provider: "okxweb3", credentials, wallets, now, ...options });

test("wallet sync signs only fixed read queries, prices verified contracts, and keeps retrieval time honest", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await run({ fetchImpl });
  assert.equal(result.provider, "okxweb3");
  assert.equal(result.currency, "USD");
  assert.ok(Math.abs(result.total - (500 + 200 + (100.125 + 3.5) * 0.998)) < 1e-9);
  assert.equal(result.holdings.length, 4);
  assert.equal(result.holdings[1].category, "稳定币");
  assert.equal(result.holdings[1].rawQuantity, "100.125");
  assert.deepEqual(result.unpricedAssets, []);
  assert.equal(result.valuationComplete, true);
  assert.equal(result.breakdownComplete, true);
  assert.equal(result.observedAt, null);
  assert.equal(result.timeBasis, "retrieved");
  assert.equal(result.fetchedAt, time.toISOString());
  assert.equal(result.asOf, "2026-10-24");
  assert.equal(result.coverage.some((line) => line.includes("NFT") && line.includes("不含")), true);
  for (const call of calls) {
    const url = new URL(call.url); const init = call.init;
    assert.equal(init.redirect, "error"); assert.ok(init.signal instanceof AbortSignal);
    if (url.hostname === "api.kraken.com") {
      assert.equal(url.pathname, "/0/public/Trades"); assert.equal(url.searchParams.get("pair"), "USDTUSD");
      assert.equal(init.headers["OK-ACCESS-KEY"], undefined); continue;
    }
    assert.ok([balancePath, defiPath].includes(url.pathname));
    assert.equal(init.headers["OK-ACCESS-KEY"], credentials.apiKey);
    const signed = `${time.toISOString()}${init.method}${url.pathname}${url.search}${init.body || ""}`;
    assert.equal(init.headers["OK-ACCESS-SIGN"], createHmac("sha256", credentials.secret).update(signed).digest("base64"));
    if (init.method === "GET") {
      assert.equal(url.searchParams.get("excludeRiskToken"), "1"); assert.equal(url.searchParams.get("filter"), "1");
    } else {
      const body = JSON.parse(init.body);
      assert.equal(body.walletAddressList.length, 1);
      assert.ok(wallets.some((w) => w.address === body.walletAddressList[0].walletAddress && w.chainIndex === body.walletAddressList[0].chainIndex));
    }
  }
  for (const secret of Object.values(credentials)) assert.equal(JSON.stringify(result).includes(secret), false);
});

test("wallet external identity is stable across EVM case, provider and input order", async () => {
  const a = await run(fakeFetch());
  const reordered = [{ ...wallets[1] }, { ...wallets[0], address: `0x${evm.slice(2).toUpperCase()}` }];
  const b = await run({ ...fakeFetch(), provider: "tokenpocket", wallets: reordered });
  const canonical = [`1:${evm}`, `501:${solana}`].sort().join("|");
  assert.equal(a.externalAccountId, `wallets:${createHash("sha256").update(canonical).digest("hex")}`);
  assert.equal(a.externalAccountId, b.externalAccountId); assert.ok(a.externalAccountId.length <= 200);
  assert.equal(b.provider, "tokenpocket");
});

test("Solana wallet identity preserves case instead of applying EVM address normalization", async () => {
  const ids = [];
  for (const suffix of ["a", "A"]) {
    const wallet = { chainIndex: "501", address: "1".repeat(31) + suffix };
    const data = fixture(); data.balances["501"] = [token(wallet, "", "SOL", "1", "100")];
    ids.push((await run({ ...fakeFetch(data), wallets: [wallet] })).externalAccountId);
  }
  assert.notEqual(ids[0], ids[1]);
});

test("all positive unknown and unpriced tokens retain exact quantities without synthetic zero amounts", async () => {
  const data = fixture();
  data.balances["1"].push(token(wallets[0], unknownEth, "USDT", "12345678901234567890.123456789012345678", "500", { isRiskToken: true }));
  data.balances["501"].push(token(wallets[1], "11111111111111111111111111111113", "ZERO", "1.000000001", "99"));
  data.balances["1"][0].tokenPrice = "";
  const result = await run(fakeFetch(data));
  assert.equal(result.valuationComplete, false); assert.equal(result.unpricedAssets.length, 3);
  assert.equal(result.unpricedAssets.find((r) => r.contract === unknownEth).quantity, "12345678901234567890.123456789012345678");
  assert.ok(result.unpricedAssets.every((r) => !Object.hasOwn(r, "amount") && r.reason));
  assert.equal(result.holdings.some((r) => r.symbol === "ZERO"), false);
  assert.equal(result.total, result.holdings.reduce((sum, row) => sum + row.amount, 0));
});

test("missing or stale actual USDT quotes leave USDT unpriced and never assume a fixed dollar peg", async () => {
  for (const quote of [{ error: ["untrusted upstream secret"] }, { error: [], result: {} },
    { error: [], result: { USDTZUSD: [["1", "2", time.getTime() / 1000 - 3600]] } }]) {
    const data = fixture(); data.quote = quote;
    const result = await run(fakeFetch(data));
    assert.equal(result.valuationComplete, false); assert.equal(result.total, 700);
    assert.equal(result.unpricedAssets.length, 2);
    assert.ok(result.unpricedAssets.every((r) => r.symbol === "USDT"));
    assert.equal(JSON.stringify(result).includes("untrusted upstream secret"), false);
  }
});

test("DeFi rows, missing scope, stale data and updating aggregates stay unverified without adding their value", async () => {
  for (const defi of [{ assetStatus: 1, updateAt: time.getTime() },
    { assetStatus: 2, updateAt: time.getTime(), walletIdPlatformList: [] },
    { assetStatus: 1, updateAt: time.getTime() - 3600_000, walletIdPlatformList: [] },
    { assetStatus: 1, updateAt: time.getTime(), walletIdPlatformList: [{ platformList: [{ platformName: "Polymarket", analysisPlatformId: 1, currencyAmount: "99999" }] }] }]) {
    const data = fixture(); data.defi = defi;
    const result = await run(fakeFetch(data));
    assert.equal(result.valuationComplete, false);
    assert.ok(Math.abs(result.total - (700 + 103.625 * 0.998)) < 1e-9);
    assert.ok(result.warnings.some((w) => w.includes("DeFi") && w.includes("核实")));
    assert.equal(result.holdings.some((h) => h.amount === 99999), false);
  }
});

test("wallet sync validates credentials, provider, address formats and duplicate bindings before networking", async () => {
  for (const options of [{ credentials: null }, { credentials: { ...credentials, secret: "\nsecret" } },
    { provider: "constructor" }, { wallets: [] }, { wallets: [{ chainIndex: "10", address: evm }] }, { wallets: [{ chainIndex: 1, address: evm }] },
    { wallets: [{ chainIndex: "1", address: solana }] }, { wallets: [{ chainIndex: "501", address: evm }] },
    { wallets: [{ chainIndex: "501", address: "2".repeat(44) + "0" }] }, { wallets: [wallets[0], wallets[0]] }]) {
    let called = false;
    await assert.rejects(run({ ...options, fetchImpl: async () => { called = true; } }), (e) => e.statusCode === 400);
    assert.equal(called, false);
  }
});

test("foreign-wallet, wrong-chain, duplicate and malformed balance rows cannot become a valid snapshot", async () => {
  for (const change of [
    (d) => { d.balances["1"][0].address = otherEvm; },
    (d) => { d.balances["501"][0].address = "1111111111111111111111111111111A"; },
    (d) => { d.balances["1"][0].chainIndex = "137"; },
    (d) => { d.balances["1"][0].symbol = "USDT"; },
    (d) => { d.balances["1"].push({ ...d.balances["1"][1], tokenContractAddress: `0x${usdtEth.slice(2).toUpperCase()}` }); },
    (d) => { d.balances["1"][0].balance = "NaN"; },
    (d) => { d.balances["1"][0].balance = "-1"; },
    (d) => { d.balances["1"][0].balance = "1e3"; },
    (d) => { d.balances["1"][1].tokenContractAddress = "https://attacker.invalid"; },
  ]) {
    const data = fixture(); change(data);
    await assert.rejects(run(fakeFetch(data)), /响应|数据|资产|余额/);
  }
});

test("verified empty token scope returns zero, while unknown-only positive holdings remain partially unvalued", async () => {
  const data = fixture(); data.balances["1"] = []; data.balances["501"] = [];
  let result = await run(fakeFetch(data));
  assert.equal(result.total, 0); assert.equal(result.valuationComplete, true); assert.deepEqual(result.holdings, []);
  data.balances["1"] = [token(wallets[0], unknownEth, "UNKNOWN", "4", "")];
  result = await run(fakeFetch(data));
  assert.equal(result.total, 0); assert.equal(result.valuationComplete, false);
  assert.deepEqual(result.holdings, []); assert.equal(result.unpricedAssets[0].quantity, "4");
});

test("wallet sync caps aggregate valuation and inventory rather than truncating valid-looking responses", async () => {
  for (const change of [
    (d) => { d.balances["1"][0].balance = "1000000000000"; },
    (d) => { d.balances["1"][0].balance = "1".repeat(121); },
    (d) => { d.balances["1"] = Array.from({ length: 1000 }, () => d.balances["1"][0]); },
  ]) {
    const data = fixture(); change(data);
    await assert.rejects(run(fakeFetch(data)), /资产|响应/);
  }
});

test("rate limits and DeFi request failures never become successful complete valuations", async () => {
  for (const response of [new Response("private upstream text", { status: 429 }), Response.json({ code: "50011", msg: credentials.secret })]) {
    await assert.rejects(run(fakeFetch(fixture(), (url) => url.pathname === balancePath ? response : undefined)), (e) => e.statusCode === 429 && !e.message.includes(credentials.secret));
  }
  const result = await run(fakeFetch(fixture(), (url) => url.pathname === defiPath ? new Response(credentials.secret, { status: 403 }) : undefined));
  assert.equal(result.valuationComplete, false); assert.ok(result.total > 0);
  assert.equal(JSON.stringify(result).includes(credentials.secret), false);
});

test("Developer auth and IP rejection is actionable without masquerading as expired dashboard login", async () => {
  for (const response of [new Response(credentials.secret, { status: 401 }), new Response(credentials.apiKey, { status: 403 }),
    Response.json({ code: "50103", msg: credentials.secret }), Response.json({ code: "50114", msg: credentials.passphrase })]) {
    await assert.rejects(run(fakeFetch(fixture(), (url) => url.pathname === balancePath ? response : undefined)), (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /OnchainOS.*开发者凭据.*权限.*IP.*核对/);
      assert.equal(Object.values(credentials).some((secret) => error.message.includes(secret)), false);
      return true;
    });
  }
});

test("upstream failures, redirects, invalid JSON and size limits fail safely without exposing secrets or bodies", async () => {
  for (const response of [new Response("secret " + credentials.secret, { status: 401 }),
    new Response("secret", { status: 302, headers: { location: "https://attacker.invalid" } }),
    new Response("{not-json"), new Response("{}", { headers: { "content-length": "1000001" } }),
    Response.json({ code: "50114", msg: credentials.passphrase }),
    Response.json({ code: "0", data: [{ tokenAssets: [], has_more: true }] }),
    new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1_000_001)); c.close(); } }))]) {
    const { fetchImpl } = fakeFetch(fixture(), (url) => url.pathname === balancePath ? response : undefined);
    await assert.rejects(run({ fetchImpl }), (error) => {
      assert.equal(Object.values(credentials).some((s) => String(error).includes(s)), false);
      return error.statusCode >= 400;
    });
  }
  await assert.rejects(run({ fetchImpl: async () => { throw new Error(credentials.secret); } }), (e) => !e.message.includes(credentials.secret));
});

test("Binance Agentic public BSC balances price native BNB and verified USDT without using a fixed dollar peg", async () => {
  const wallet = { chainIndex: "56", address: evm };
  const contract = "0x55d398326f99059ff775485246999027b3197955";
  const data = fixture();
  data.balances["56"] = [token(wallet, "", "BNB", "0.00751513166666367", "718.7"),
    token(wallet, contract, "USDT", "216.824327908410984083", "1.25"),
    token(wallet, unknownEth, "SPYon", "0.279566661108909015", "759.725")];
  const { fetchImpl, calls } = fakeFetch(data);
  const result = await run({ provider: "binanceagentic", wallets: [wallet], fetchImpl });
  assert.equal(result.provider, "binanceagentic"); assert.match(result.accountLabel, /币安Agentic Wallet.*BNB Smart Chain/);
  assert.equal(result.holdings.length, 2);
  assert.ok(Math.abs(result.total - (0.00751513166666367 * 718.7 + 216.824327908410984083 * 0.998)) < 1e-9);
  assert.equal(result.holdings.find(row => row.symbol === "USDT").rawQuantity, "216.824327908410984083");
  assert.equal(result.unpricedAssets[0].quantity, "0.279566661108909015");
  assert.equal(result.valuationComplete, false);
  assert.equal(calls.filter(call => new URL(call.url).hostname === "api.kraken.com").length, 1);
  assert.ok(result.warnings.some(line => /BSC.*Binance-Peg/.test(line)));
});

test("OKX Agentic X Layer identifies USDt0 by chain and official contract and uses actual provider USD price", async () => {
  const wallet = { chainIndex: "196", address: evm };
  const contract = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
  const data = fixture();
  data.balances["196"] = [token(wallet, "", "OKB", "0.013505097240135695", "106.5"),
    token(wallet, contract, "USD₮0", "8.493422", "0.99869")];
  const { fetchImpl, calls } = fakeFetch(data);
  const result = await run({ provider: "okxagentic", wallets: [wallet], fetchImpl });
  assert.equal(result.provider, "okxagentic"); assert.match(result.accountLabel, /OKX Agentic Wallet.*X Layer/);
  assert.equal(result.holdings.length, 2); assert.equal(result.unpricedAssets.length, 0);
  assert.ok(Math.abs(result.total - (0.013505097240135695 * 106.5 + 8.493422 * 0.99869)) < 1e-12);
  const stable = result.holdings.find(row => row.contract === contract);
  assert.equal(stable.symbol, "USDT0"); assert.equal(stable.category, "稳定币");
  assert.equal(stable.rawQuantity, "8.493422");
  assert.ok(result.warnings.some(line => /USDT0.*提供商.*报价时点/.test(line)));
  assert.equal(result.observedAt, null); assert.equal(result.timeBasis, "retrieved");
  assert.equal(calls.some(call => new URL(call.url).hostname === "api.kraken.com"), false);
});

test("Agentic source-priced tokens never accept a matching symbol on a foreign contract or invalid prices", async () => {
  const wallet = { chainIndex: "196", address: evm };
  const contract = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
  for (const row of [token(wallet, unknownEth, "USD₮0", "8", "1"),
    token(wallet, contract, "USD₮0", "8", ""), token(wallet, contract, "USD₮0", "8", "0"),
    token(wallet, contract, "USD₮0", "8", "0.99", { isRiskToken: true })]) {
    const data = fixture(); data.balances["196"] = [row];
    const result = await run({ provider: "okxagentic", wallets: [wallet], ...fakeFetch(data) });
    assert.equal(result.holdings.length, 0); assert.equal(result.unpricedAssets.length, 1);
    assert.equal(result.unpricedAssets[0].quantity, "8"); assert.equal(result.valuationComplete, false);
  }
  const data = fixture(); data.balances["196"] = [token(wallet, "", "ETH", "1", "2000")];
  await assert.rejects(run({ provider: "okxagentic", wallets: [wallet], ...fakeFetch(data) }), /响应|资产/);
});

test("verified BSC SPYon is valued per token, distinguished from ETF shares, and never identified by symbol alone", async () => {
  const wallet = { chainIndex: "56", address: evm };
  const contract = "0x6a708ead771238919d85930b5a0f10454e1c331a";
  const data = fixture();
  data.balances["56"] = [token(wallet, contract, "SPYon", "0.279566661108909015", "759.725"),
    token(wallet, unknownEth, "SPYon", "100", "759.725")];
  const { fetchImpl, calls } = fakeFetch(data);
  const result = await run({ provider: "binanceagentic", wallets: [wallet], fetchImpl });
  assert.equal(result.holdings.length, 1); assert.equal(result.unpricedAssets.length, 1);
  assert.equal(result.unpricedAssets[0].contract, unknownEth);
  assert.equal(result.holdings[0].contract, contract); assert.equal(result.holdings[0].category, "股票ETF");
  assert.match(result.holdings[0].name, /SPYon.*Ondo.*代币化ETF/);
  assert.equal(result.holdings[0].rawQuantity, "0.279566661108909015");
  assert.ok(Math.abs(result.total - 0.279566661108909015 * 759.725) < 1e-12);
  assert.ok(result.warnings.some(line => /SPYon.*每代币.*不.*股数/.test(line)));
  assert.equal(calls.some(call => new URL(call.url).hostname === "api.kraken.com"), false);
  data.balances["56"][0].isRiskToken = true;
  const risk = await run({ provider: "binanceagentic", wallets: [wallet], ...fakeFetch(data) });
  assert.equal(risk.holdings.length, 0); assert.equal(risk.unpricedAssets.length, 2);
});

test("issuer-verified BSC SGOVon uses exact token quantity and provider USD price without inferring ETF shares", async () => {
  const wallet = { chainIndex: "56", address: evm };
  const contract = "0xc008c5f579ec1450f20099c39f587547e27c7523";
  const quantity = "2.084735639804123758";
  const data = fixture();
  data.balances["56"] = [token(wallet, contract, "untrusted-name", quantity, "102.75"), token(wallet, unknownEth, "SGOVon", "100", "102.75")];
  const { fetchImpl, calls } = fakeFetch(data);
  const result = await run({ provider: "binanceagentic", wallets: [wallet], fetchImpl });
  assert.equal(result.holdings.length, 1);
  assert.equal(result.holdings[0].symbol, "SGOVon");
  assert.equal(result.holdings[0].category, "债券");
  assert.equal(result.holdings[0].rawQuantity, quantity);
  assert.match(result.holdings[0].name, /SGOVon.*Ondo.*代币化.*债.*ETF/);
  assert.ok(Math.abs(result.total - Number(quantity) * 102.75) < 1e-10);
  assert.equal(result.unpricedAssets.length, 1);
  assert.equal(result.unpricedAssets[0].contract, unknownEth);
  assert.ok(result.warnings.some(line => /SGOVon.*每代币.*不.*股数/.test(line)));
  assert.equal(result.observedAt, null);
  assert.equal(result.timeBasis, "retrieved");
  assert.equal(calls.length, 2); // Existing balance and DeFi reads only; no added quote requests.
  for (const change of [row => { row.isRiskToken = true; }, row => { row.tokenPrice = "0"; }]) {
    const copy = structuredClone(data); change(copy.balances["56"][0]);
    const withheld = await run({ provider: "binanceagentic", wallets: [wallet], ...fakeFetch(copy) });
    assert.equal(withheld.holdings.length, 0);
    assert.equal(withheld.unpricedAssets.length, 2);
  }
  const ethWallet = { chainIndex: "1", address: evm };
  data.balances["1"] = [token(ethWallet, contract, "SGOVon", quantity, "102.75")];
  const wrongChain = await run({ wallets: [ethWallet], ...fakeFetch(data) });
  assert.equal(wrongChain.holdings.length, 0);
  assert.equal(wrongChain.unpricedAssets.length, 1);
});

const zeroMint = "EmcxFTNVDqyLHp11NvwvLZ4D7LKGbG9i7B8RF7dwpump";
const zeroQuoteUrl = `https://api.jup.ag/price/v3?ids=${zeroMint}`;
const zeroPrice = 0.00023619741294875424;
function zeroFixture() {
  const data = fixture();
  data.balances["501"].push(token(wallets[1], zeroMint, "untrusted-symbol", "309.248658", "999999"));
  return data;
}
function zeroFetch(data = zeroFixture(), options = {}) {
  const quote = options.quote ?? { [zeroMint]: { usdPrice: zeroPrice, blockId: 460917114, decimals: 6 } };
  const rpc = options.rpc ?? { jsonrpc: "2.0", id: 1, result: time.getTime() / 1000 - 60 };
  return fakeFetch(data, (url, init) => {
    if (url.origin === "https://api.jup.ag") return options.quoteResponse ? options.quoteResponse() : Response.json(quote);
    if (url.origin === "https://api.mainnet-beta.solana.com") return options.rpcResponse ? options.rpcResponse() : Response.json(rpc);
    return options.intercept?.(url, init);
  });
}

test("ZERO exact Solana mint uses a fresh Jupiter USD price without relabelling the balance observation time", async () => {
  const { fetchImpl, calls } = zeroFetch();
  const result = await run({ fetchImpl });
  const holding = result.holdings.find(row => row.contract === zeroMint);
  assert.ok(holding);
  assert.equal(holding.symbol, "ZERO"); assert.equal(holding.category, "加密资产");
  assert.equal(holding.rawQuantity, "309.248658"); assert.equal(holding.quantity, "309.248658");
  assert.ok(Math.abs(holding.amount - 309.248658 * zeroPrice) < 1e-15);
  assert.equal(holding.currency, "USD"); assert.equal(holding.quoteSource, "Jupiter Price V3");
  assert.equal(holding.quoteObservedAt, "2026-10-24T12:29:00.000Z");
  assert.equal(result.observedAt, null); assert.equal(result.timeBasis, "retrieved");
  assert.equal(result.unpricedAssets.length, 0);
  assert.ok(Math.abs(result.total - (700 + 103.625 * 0.998 + 309.248658 * zeroPrice)) < 1e-9);
  assert.ok(result.warnings.some(line => /ZERO.*Jupiter.*价格时点.*12:29:00/.test(line)));
  assert.equal(calls.filter(call => call.url === zeroQuoteUrl).length, 1);
});

test("ZERO public requests share one quote across wallets and never receive Developer auth or owner addresses", async () => {
  const second = { chainIndex: "501", address: "11111111111111111111111111111113" };
  const data = zeroFixture();
  const { fetchImpl, calls } = zeroFetch(data, { intercept: url => url.pathname === balancePath && url.searchParams.get("address") === second.address
    ? Response.json({ code: "0", data: [{ tokenAssets: [token(second, zeroMint, "ZERO", "1.000001", "500")] }] }) : undefined });
  const result = await run({ wallets: [...wallets, second], fetchImpl });
  assert.equal(result.holdings.filter(row => row.contract === zeroMint).length, 2);
  const publicCalls = calls.filter(call => ["api.jup.ag", "api.mainnet-beta.solana.com"].includes(new URL(call.url).hostname));
  assert.equal(publicCalls.length, 2);
  assert.equal(publicCalls[0].url, zeroQuoteUrl); assert.equal(publicCalls[0].init.method, "GET");
  assert.equal(publicCalls[1].url, "https://api.mainnet-beta.solana.com");
  assert.deepEqual(JSON.parse(publicCalls[1].init.body), { jsonrpc: "2.0", id: 1, method: "getBlockTime", params: [460917114] });
  for (const call of publicCalls) {
    assert.equal(call.init.redirect, "error"); assert.ok(call.init.signal instanceof AbortSignal);
    for (const header of Object.keys(call.init.headers)) assert.ok(!/authorization|ok-access|api-key/i.test(header));
    const encoded = JSON.stringify(call);
    for (const secret of Object.values(credentials)) assert.equal(encoded.includes(secret), false);
    for (const wallet of [...wallets, second]) assert.equal(encoded.includes(wallet.address), false);
  }
  assert.equal(calls.some(call => /\/swap\/|\/order|\/execute|tokens\/v2/.test(call.url)), false);
});

test("ZERO missing or mismatched mint, decimals, slot and USD price retain exact quantity without provider-price fallback", async () => {
  const base = { usdPrice: zeroPrice, blockId: 460917114, decimals: 6 };
  const invalidQuotes = [{}, { [usdtSol]: base }, { [zeroMint]: base, [usdtSol]: base },
    ...[5, "6", null].map(decimals => ({ [zeroMint]: { ...base, decimals } })),
    ...[undefined, 0, -1, 0.5, "460917114", Number.MAX_SAFE_INTEGER + 1].map(blockId => ({ [zeroMint]: { ...base, blockId } })),
    ...[undefined, 0, -1, null, "0.1", NaN, Infinity, 1_000_000_000_001].map(usdPrice => ({ [zeroMint]: { ...base, usdPrice } }))];
  for (const quote of invalidQuotes) {
    const { fetchImpl, calls } = zeroFetch(zeroFixture(), { quote });
    const result = await run({ fetchImpl });
    const unknown = result.unpricedAssets.find(row => row.contract === zeroMint);
    assert.ok(unknown); assert.equal(unknown.quantity, "309.248658"); assert.match(unknown.reason, /ZERO.*Jupiter|ZERO.*报价/);
    assert.equal(result.holdings.some(row => row.contract === zeroMint), false);
    assert.ok(Math.abs(result.total - (700 + 103.625 * 0.998)) < 1e-9);
    assert.equal(calls.filter(call => call.url === zeroQuoteUrl).length, 1);
    assert.equal(calls.some(call => new URL(call.url).hostname === "api.mainnet-beta.solana.com"), false);
  }
});

test("ZERO enforces a five-minute quote age and ten-second future limit using the returned Solana block time", async () => {
  for (const [offset, accepted] of [[-300, true], [-301, false], [-360, false], [10, true], [11, false]]) {
    const { fetchImpl } = zeroFetch(zeroFixture(), { rpc: { jsonrpc: "2.0", id: 1, result: time.getTime() / 1000 + offset } });
    const result = await run({ fetchImpl });
    assert.equal(result.holdings.some(row => row.contract === zeroMint), accepted);
    if (!accepted) {
      const unknown = result.unpricedAssets.find(row => row.contract === zeroMint);
      assert.equal(unknown.quantity, "309.248658"); assert.match(unknown.reason, offset < 0 ? /5 分钟|过期/ : /未来|时点/);
    }
  }
  for (const rpc of [{ jsonrpc: "2.0", id: 1, result: null }, { jsonrpc: "2.0", id: 1, result: "1792844940" },
    { jsonrpc: "2.0", id: 2, result: time.getTime() / 1000 }, { id: 1, result: time.getTime() / 1000 },
    { jsonrpc: "2.0", id: 1, result: time.getTime() / 1000, error: { message: credentials.secret } }]) {
    const result = await run(zeroFetch(zeroFixture(), { rpc }));
    assert.equal(result.holdings.some(row => row.contract === zeroMint), false);
    assert.equal(result.unpricedAssets.find(row => row.contract === zeroMint).quantity, "309.248658");
    assert.equal(JSON.stringify(result).includes(credentials.secret), false);
  }
});

test("ZERO does not query prices for risk-marked, zero-quantity or symbol-only matches", async () => {
  for (const change of [data => { data.balances["501"].at(-1).isRiskToken = true; },
    data => { data.balances["501"].at(-1).balance = "0.000000"; },
    data => { Object.assign(data.balances["501"].at(-1), { tokenContractAddress: zeroMint.slice(0, -1) + "P", symbol: "ZERO" }); },
    data => { Object.assign(data.balances["501"].at(-1), { tokenContractAddress: "11111111111111111111111111111113", symbol: "ZERO" }); },
    data => { data.balances["501"].pop(); data.balances["1"].push(token(wallets[0], unknownEth, "ZERO", "10", "5")); }]) {
    const data = zeroFixture(); change(data); const { fetchImpl, calls } = zeroFetch(data);
    const result = await run({ fetchImpl });
    assert.equal(calls.some(call => ["api.jup.ag", "api.mainnet-beta.solana.com"].includes(new URL(call.url).hostname)), false);
    assert.equal(calls.some(call => new URL(call.url).pathname === "/api/v6/dex/market/price"), false);
    assert.equal(result.holdings.some(row => row.contract === zeroMint), false);
  }
});

test("ZERO public quote failures, limits, payment gates and malformed responses only leave that holding unpriced", async () => {
  const failures = [() => new Response(credentials.secret, { status: 402 }), () => new Response(credentials.apiKey, { status: 429 }),
    () => new Response(credentials.secret, { status: 403 }), () => new Response("upstream", { status: 500 }),
    () => new Response("upstream", { status: 302, headers: { location: "https://attacker.invalid" } }),
    () => new Response("not-json " + credentials.secret), () => new Response("{}", { headers: { "content-length": "1000001" } }),
    () => { throw Error(credentials.secret); }];
  for (const field of ["quoteResponse", "rpcResponse"]) for (const failure of failures) {
    const { fetchImpl, calls } = zeroFetch(zeroFixture(), { [field]: failure });
    const result = await run({ fetchImpl });
    const unknown = result.unpricedAssets.find(row => row.contract === zeroMint);
    assert.equal(unknown.quantity, "309.248658"); assert.match(unknown.reason, /ZERO.*报价|ZERO.*查询/);
    assert.equal(result.holdings.some(row => row.contract === zeroMint), false);
    assert.ok(Math.abs(result.total - (700 + 103.625 * 0.998)) < 1e-9);
    for (const secret of Object.values(credentials)) assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(calls.filter(call => call.url === zeroQuoteUrl).length, 1);
    assert.ok(calls.filter(call => new URL(call.url).hostname === "api.mainnet-beta.solana.com").length <= 1);
  }
});

test("wallet token identity remains the same when ZERO changes from priced to unpriced", async () => {
  const priced = await run(zeroFetch());
  const unpriced = await run(zeroFetch(zeroFixture(), { rpc: { jsonrpc: "2.0", id: 1, result: time.getTime() / 1000 - 360 } }));
  const known = priced.holdings.find(row => row.contract === zeroMint);
  const unknown = unpriced.unpricedAssets.find(row => row.contract === zeroMint);
  assert.equal(unknown.externalId, known.externalId);
  assert.equal(unknown.externalId, `token:${createHash("sha256").update(`501:${solana}:${zeroMint}`).digest("hex")}`);
  assert.equal(unknown.quantity, "309.248658"); assert.equal(Object.hasOwn(unknown, "amount"), false);
  const first = fixture(); first.balances["1"].push(token(wallets[0], unknownEth, "UNKNOWN", "2.0000000001", "1"));
  const result = await run(fakeFetch(first));
  assert.equal(result.unpricedAssets[0].externalId, `token:${createHash("sha256").update(`1:${evm}:${unknownEth}`).digest("hex")}`);
  assert.equal(result.unpricedAssets[0].quantity, "2.0000000001");
});

test("ZERO quote work does not extend the existing forty-five-second wallet snapshot deadline", async () => {
  let current = time;
  const mock = zeroFetch(zeroFixture(), { quoteResponse: () => {
    current = new Date(time.getTime() + 46_000);
    return Response.json({ [zeroMint]: { usdPrice: zeroPrice, decimals: 6, blockId: 460917114 } });
  } });
  await assert.rejects(run({ ...mock, now: () => current }), /资产|响应/);
  assert.equal(mock.calls.filter(call => call.url === zeroQuoteUrl).length, 1);
});

const safeFactory = "0xaacfeea03eb1561c4e67d661e40682bd20e3541b";
const pusdContract = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const polygonRpc = "https://polygon.publicnode.com";
const polygon = { chainIndex: "137", address: evm };
const word = value => BigInt(value).toString(16).padStart(64, "0");
const ownerArray = owner => `0x${word(32)}${word(1)}${owner.slice(2).padStart(64, "0")}`;
function safeFetch(options = {}) {
  const data = fixture();
  data.balances["137"] = [token(polygon, "", "POL", "2", "0.6")];
  data.defi.walletIdPlatformList = [{ platformList: [{ platformName: "Polymarket", totalAssets: "99999" }] }];
  if (options.emptyDefi) data.defi.walletIdPlatformList = [];
  return fakeFetch(data, (url, init) => {
    if (url.href === polygonRpc + "/") {
      if (options.rpcResponse) return options.rpcResponse(init);
      const rows = JSON.parse(init.body).map(call => {
        let result;
        if (call.method === "eth_chainId") result = options.chain ?? "0x89";
        else if (call.method === "eth_blockNumber") result = "0x12345";
        else if (call.method === "eth_getCode") result = options.code ?? "0x6000";
        else if (call.method === "eth_getBlockByNumber") result = { number: "0x12345", hash: `0x${"ab".repeat(32)}`, timestamp: "0x" + (time.getTime() / 1000 + (options.blockOffset ?? -2)).toString(16), ...options.block };
        else {
          assert.equal(call.method, "eth_call");
          const { to, data } = call.params[0];
          if (data.startsWith("0xd600539a")) { assert.equal(to, safeFactory); result = options.candidate ?? `0x${otherEvm.slice(2).padStart(64, "0")}`; }
          else if (data === "0xa0e67e2b") result = options.owners ?? ownerArray(evm);
          else if (data === "0xe75235b8") result = `0x${word(options.threshold ?? 1)}`;
          else if (data === "0x313ce567") { assert.equal(to, pusdContract); result = `0x${word(options.decimals ?? 6)}`; }
          else { assert.equal(to, pusdContract); assert.equal(data, `0x70a08231${otherEvm.slice(2).padStart(64, "0")}`); result = options.rawResponse ?? `0x${word(options.raw ?? 10200000)}`; }
        }
        return { jsonrpc: "2.0", id: call.id, result };
      });
      return Response.json(options.rpcRows ? options.rpcRows(rows) : rows);
    }
    if (url.hostname === "api.kraken.com" && url.searchParams.get("pair") === "USDCUSD") return options.quoteResponse ? options.quoteResponse() : Response.json(options.quote ?? { error: [], result: { USDCUSD: [["0.998", "1", time.getTime() / 1000 - 60]] } });
  });
}
const runSafe = options => run({ provider: "tokenpocket", wallets: [polygon], polymarketSafeOwner: evm, ...safeFetch(options) });

test("TokenPocket adds only verified single-owner Safe pUSD cash using an actual USDC/USD reference price", async () => {
  const mock = safeFetch();
  const result = await run({ provider: "tokenpocket", wallets: [polygon], polymarketSafeOwner: evm, ...mock });
  assert.equal(result.externalAccountId, `wallets:${createHash("sha256").update(`137:${evm}`).digest("hex")}`);
  assert.equal(result.observedAt, null); assert.equal(result.valuationComplete, false);
  const cash = result.holdings.find(row => row.symbol === "pUSD");
  assert.ok(cash); assert.equal(cash.rawQuantity, "10.2"); assert.equal(cash.quantity, "10.2");
  assert.equal(cash.externalId, `token:${createHash("sha256").update(`137:${otherEvm}:${pusdContract}`).digest("hex")}`);
  assert.equal(cash.amount, 10.2 * 0.998); assert.equal(cash.quoteSource, "Kraken USDC/USD · pUSD抵押权益参考");
  assert.equal(cash.quoteObservedAt, "2026-10-24T12:29:00.000Z");
  assert.equal(cash.balanceAddress, otherEvm); assert.equal(cash.cashObservedAt, "2026-10-24T12:29:58.000Z");
  assert.equal(cash.cashRawBalance, "10200000"); assert.equal(cash.cashBlockNumber, "0x12345");
  assert.equal(result.total, 1.2 + 10.2 * 0.998);
  assert.equal(result.holdings[0].symbol, "POL"); assert.equal(result.holdings[0].amount, 1.2);
  assert.equal(result.derivedWallets[0].owner, evm); assert.equal(result.derivedWallets[0].address, otherEvm);
  assert.ok(result.warnings.some(line => /pUSD.*参考估值.*赎回/.test(line)));
  const publicCalls = mock.calls.filter(call => new URL(call.url).origin !== "https://web3.okx.com");
  const rpc = publicCalls.filter(call => call.url === polygonRpc);
  assert.equal(rpc.length, 4);
  for (const call of publicCalls) {
    assert.equal(call.init.redirect, "error"); assert.ok(call.init.signal instanceof AbortSignal);
    assert.ok(Object.keys(call.init.headers).every(header => !/authorization|ok-access|key/i.test(header)));
    for (const secret of Object.values(credentials)) assert.equal(JSON.stringify(call).includes(secret), false);
  }
  for (const call of rpc) for (const request of JSON.parse(call.init.body)) {
    assert.ok(["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_getBlockByNumber", "eth_call"].includes(request.method));
    if (!["eth_chainId", "eth_blockNumber"].includes(request.method)) assert.equal(request.params[1], request.method === "eth_getBlockByNumber" ? false : "0x12345");
  }
});

test("Safe ownership, exact contract decimals, fixed block and RPC shape must all verify before any cash is returned", async () => {
  for (const change of [{ chain: "0x1" }, { candidate: `0x${word(0)}` }, { candidate: "0x" }, { candidate: `0x${word(1)}${word(2)}` },
    { owners: ownerArray(unknownEth) }, { owners: `0x${word(32)}${word(2)}${evm.slice(2).padStart(64, "0")}${unknownEth.slice(2).padStart(64, "0")}` },
    { owners: `0x${word(0)}${word(1)}${evm.slice(2).padStart(64, "0")}` }, { threshold: 2 }, { decimals: 18 },
    { rawResponse: "0x" }, { raw: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, { block: { number: "0x12346" } }, { blockOffset: -121 }, { blockOffset: 11 },
    { rpcRows: rows => [...rows, rows[0]] }, { rpcRows: rows => rows.map(row => ({ ...row, id: 1 })) },
    { rpcRows: rows => rows.map(row => ({ ...row, error: { message: credentials.secret } })) }]) {
    await assert.rejects(runSafe(change), error => error.statusCode >= 400 && !error.message.includes(credentials.secret));
  }
});

test("Safe RPC payment, archive, redirect and transport errors fail once with no other node or trade request", async () => {
  for (const rpcResponse of [() => new Response(credentials.secret, { status: 402 }), () => new Response(credentials.secret, { status: 429 }),
    () => new Response("upstream", { status: 302, headers: { location: "https://attacker.invalid" } }), () => new Response("not-json"),
    init => Response.json(JSON.parse(init.body).map(call => ({ jsonrpc: "2.0", id: call.id, error: { code: -32602, message: "Archive requests require a personal token" } }))),
    () => { throw Error(credentials.secret); }]) {
    const mock = safeFetch({ rpcResponse });
    await assert.rejects(run({ provider: "tokenpocket", wallets: [polygon], polymarketSafeOwner: evm, ...mock }), error => !error.message.includes(credentials.secret));
    assert.equal(mock.calls.filter(call => call.url === polygonRpc).length, 1);
    assert.equal(mock.calls.some(call => /drpc|sendTransaction|sendRawTransaction|order|swap/.test(call.url)), false);
  }
});

test("Safe quote loss preserves precise pUSD units and canonical identity without provider-price or fixed-peg fallback", async () => {
  const priced = await runSafe();
  for (const options of [{ quote: { error: [], result: {} } }, { quote: { error: [], result: { USDCUSD: [["1", "1", time.getTime() / 1000 - 301]] } } },
    { quote: { error: [], result: { USDCUSD: [["1", "1", time.getTime() / 1000 + 11]] } } },
    { quoteResponse: () => new Response(credentials.secret, { status: 429 }) }]) {
    const result = await runSafe(options), cash = result.unpricedAssets.find(row => row.symbol === "pUSD");
    assert.equal(cash.quantity, "10.2"); assert.equal(cash.externalId, priced.holdings.find(row => row.symbol === "pUSD").externalId);
    assert.equal(Object.hasOwn(cash, "amount"), false); assert.equal(result.total, 1.2); assert.equal(result.derivedWallets.length, 1);
    assert.match(cash.reason, /参考报价.*暂不估值/); assert.equal(JSON.stringify(result).includes(credentials.secret), false);
  }
});

test("a successfully proven zero Safe balance keeps its source claim while an undeployed candidate claims no ownership", async () => {
  const emptyMock = safeFetch({ raw: 0 });
  const empty = await run({ provider: "tokenpocket", wallets: [polygon], polymarketSafeOwner: evm, ...emptyMock });
  assert.equal(empty.holdings.some(row => row.symbol === "pUSD"), false); assert.equal(empty.derivedWallets.length, 1);
  assert.equal(empty.derivedWallets[0].cashRawBalance, "0"); assert.equal(empty.total, 1.2);
  assert.equal(emptyMock.calls.some(call => new URL(call.url).hostname === "api.kraken.com"), false);
  const undeployedMock = safeFetch({ code: "0x" });
  const undeployed = await run({ provider: "tokenpocket", wallets: [polygon], polymarketSafeOwner: evm, ...undeployedMock });
  assert.deepEqual(undeployed.derivedWallets, []); assert.equal(undeployed.holdings.some(row => row.symbol === "pUSD"), false);
  assert.equal(undeployedMock.calls.filter(call => call.url === polygonRpc).length, 3);
  assert.ok(undeployed.coverage.some(line => /Safe.*未部署.*不推定/.test(line)));
});

test("Safe cash-only scope remains incomplete even when the EOA DeFi index is empty", async () => {
  const result = await runSafe({ emptyDefi: true });
  assert.equal(result.holdings.some(row => row.symbol === "pUSD"), true);
  assert.equal(result.valuationComplete, false);
  assert.ok(result.coverage.some(line => /Safe.*仅读取 pUSD 现金.*不含预测持仓/.test(line)));
});

test("Safe queries require one explicit bound owner and never expand existing wallet scope by default", async () => {
  const legacy = safeFetch();
  const result = await run({ provider: "tokenpocket", wallets: [polygon], ...legacy });
  assert.equal(result.total, 1.2); assert.deepEqual(result.derivedWallets, []);
  assert.equal(legacy.calls.some(call => call.url === polygonRpc), false);
  for (const options of [{ polymarketSafeOwner: otherEvm }, { polymarketSafeOwner: evm, provider: "okxweb3" },
    { polymarketSafeOwner: [evm] }, { polymarketSafeOwner: "bad" }]) {
    let calls = 0;
    await assert.rejects(run({ provider: "tokenpocket", wallets: [polygon], polymarketSafeOwner: evm, ...options, fetchImpl: async () => { calls++; throw Error(); } }), { statusCode: 400 });
    assert.equal(calls, 0);
  }
});

test("Safe reference quote freshness is checked at completion without extending the shared wallet deadline", async () => {
  let current = time;
  const mock = safeFetch({ quote: { error: [], result: { USDCUSD: [["0.998", "1", time.getTime() / 1000 - 290]] } } });
  const fetchImpl = (url, init) => {
    if (url.includes("pair=USDTUSD")) current = new Date(time.getTime() + 20_000);
    return mock.fetchImpl(url, init);
  };
  const result = await run({ provider: "tokenpocket", wallets: [polygon, wallets[1]], polymarketSafeOwner: evm, fetchImpl, now: () => current });
  assert.equal(result.holdings.some(row => row.symbol === "pUSD"), false);
  assert.equal(result.unpricedAssets.find(row => row.symbol === "pUSD").quantity, "10.2");
  current = time;
  await assert.rejects(run({ provider: "tokenpocket", wallets: [polygon, wallets[1]], polymarketSafeOwner: evm, now: () => current,
    fetchImpl: (url, init) => { if (url.includes("pair=USDTUSD")) current = new Date(time.getTime() + 46_000); return mock.fetchImpl(url, init); } }), /资产|响应/);
});

const marketPricePath = "/api/v6/dex/market/price";
const alternateZeroPrice = "0.0002418021942385235846245478401474834";
function zeroMarketFetch(options = {}) {
  return zeroFetch(options.data ?? zeroFixture(), {
    rpc: options.rpc ?? { jsonrpc: "2.0", id: 1, result: time.getTime() / 1000 - 360 },
    ...(options.quoteResponse ? { quoteResponse: options.quoteResponse } : {}),
    intercept: (url, init) => url.pathname === marketPricePath ? options.response ? options.response(init) : Response.json(options.payload ?? { code: "0", data: [
      { chainIndex: "501", tokenContractAddress: zeroMint, time: String(time.getTime() - 10_000), price: alternateZeroPrice },
    ] }) : undefined,
  });
}

test("ZERO can use a fresh exact-mint OnchainOS USD quote when Jupiter is stale without changing its token identity", async () => {
  const mock = zeroMarketFetch(), result = await run(mock), holding = result.holdings.find(row => row.contract === zeroMint);
  assert.ok(holding); assert.equal(holding.quoteSource, "OKX OnchainOS Market"); assert.equal(holding.quoteObservedAt, "2026-10-24T12:29:50.000Z");
  assert.equal(holding.rawQuantity, "309.248658"); assert.ok(Math.abs(holding.amount - 309.248658 * Number(alternateZeroPrice)) < 1e-15);
  assert.equal(holding.externalId, `token:${createHash("sha256").update(`501:${solana}:${zeroMint}`).digest("hex")}`);
  assert.equal(result.observedAt, null); assert.equal(result.timeBasis, "retrieved");
  assert.ok(result.warnings.some(line => /ZERO.*OnchainOS.*价格时点.*不等于余额时点/.test(line)));
  const marketCalls = mock.calls.filter(call => new URL(call.url).pathname === marketPricePath); assert.equal(marketCalls.length, 1);
  const call = marketCalls[0], url = new URL(call.url);
  assert.equal(url.origin, "https://web3.okx.com"); assert.equal(url.search, ""); assert.equal(call.init.method, "POST"); assert.equal(call.init.redirect, "error"); assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(call.init.body), [{ chainIndex: "501", tokenContractAddress: zeroMint }]);
  assert.equal(call.init.headers["OK-ACCESS-SIGN"], createHmac("sha256", credentials.secret).update(`${time.toISOString()}POST${marketPricePath}${call.init.body}`).digest("base64"));
  assert.equal(call.init.body.includes(solana), false); assert.equal(call.init.body.includes(evm), false);
  assert.equal(Object.keys(call.init.headers).some(header => /payment|wallet|authorization/i.test(header)), false);
});

test("a fresh Jupiter quote avoids the alternate market request, and a public denial is not retried through it", async () => {
  const mock = zeroMarketFetch({ rpc: { jsonrpc: "2.0", id: 1, result: time.getTime() / 1000 - 60 } });
  const result = await run(mock); assert.equal(result.holdings.find(row => row.contract === zeroMint).quoteSource, "Jupiter Price V3");
  assert.equal(mock.calls.some(call => new URL(call.url).pathname === marketPricePath), false);
  for (const status of [401, 402, 403, 429]) {
    const denied = zeroMarketFetch({ quoteResponse: () => new Response(credentials.secret, { status }) });
    const value = await run(denied); assert.equal(value.holdings.some(row => row.contract === zeroMint), false);
    assert.equal(denied.calls.some(call => new URL(call.url).pathname === marketPricePath), false);
    assert.equal(value.unpricedAssets.find(row => row.contract === zeroMint).quantity, "309.248658");
  }
});

test("alternate ZERO quotes require one precise chain and mint, positive USD value and fresh millisecond source time", async () => {
  const good = { chainIndex: "501", tokenContractAddress: zeroMint, time: String(time.getTime()), price: alternateZeroPrice };
  const invalid = [[], [good, good], [{ ...good, chainIndex: "1" }], [{ ...good, tokenContractAddress: usdtSol }],
    ...[undefined, 0, "0", "-1", "1e-3", "NaN", "1000000000001"].map(price => [{ ...good, price }]),
    ...[undefined, time.getTime(), String(time.getTime() / 1000), String(time.getTime() - 301000), String(time.getTime() + 11000)].map(time => [{ ...good, time }])];
  for (const data of invalid) {
    const mock = zeroMarketFetch({ payload: { code: "0", data } }), result = await run(mock);
    const unknown = result.unpricedAssets.find(row => row.contract === zeroMint); assert.equal(unknown.quantity, "309.248658"); assert.match(unknown.reason, /ZERO.*OnchainOS/);
    assert.equal(result.holdings.some(row => row.contract === zeroMint), false); assert.equal(mock.calls.filter(call => new URL(call.url).pathname === marketPricePath).length, 1);
  }
  for (const offset of [-300000, 10000]) {
    const result = await run(zeroMarketFetch({ payload: { code: "0", data: [{ ...good, time: String(time.getTime() + offset) }] } }));
    assert.ok(result.holdings.some(row => row.contract === zeroMint));
  }
});

test("alternate ZERO source failures are bounded and never paid, retried or exposed with credential text", async () => {
  for (const response of [() => new Response(credentials.secret, { status: 402 }), () => new Response(credentials.apiKey, { status: 429 }),
    () => new Response(credentials.secret, { status: 403 }), () => new Response("upstream", { status: 500 }),
    () => new Response("redirect", { status: 302, headers: { location: "https://attacker.invalid" } }),
    () => new Response("not-json " + credentials.secret), () => new Response("{}", { headers: { "content-length": "1000001" } }),
    () => Response.json({ code: "50011", msg: credentials.secret }), () => { throw Error(credentials.secret); }]) {
    const mock = zeroMarketFetch({ response }), result = await run(mock);
    assert.equal(result.unpricedAssets.find(row => row.contract === zeroMint).quantity, "309.248658");
    assert.equal(result.holdings.some(row => row.contract === zeroMint), false);
    assert.equal(mock.calls.filter(call => new URL(call.url).pathname === marketPricePath).length, 1);
    for (const secret of Object.values(credentials)) assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(mock.calls.some(call => /swap|execute|payment|sendTransaction/.test(call.url)), false);
  }
});

test("alternate ZERO freshness uses the returned completion time and never extends the shared deadline", async () => {
  let afterMarket = false, postMarketReads = 0;
  const mock = zeroMarketFetch({ response: () => {
    afterMarket = true;
    return Response.json({ code: "0", data: [{ chainIndex: "501", tokenContractAddress: zeroMint,
      price: alternateZeroPrice, time: String(time.getTime() - 299000) }] });
  } });
  const result = await run({ ...mock, now: () => !afterMarket || ++postMarketReads === 1 ? time : new Date(time.getTime() + 2000) });
  assert.equal(result.fetchedAt, new Date(time.getTime() + 2000).toISOString());
  assert.equal(result.holdings.some(row => row.contract === zeroMint), false);
  assert.equal(result.unpricedAssets.find(row => row.contract === zeroMint).quantity, "309.248658");
  assert.match(result.unpricedAssets.find(row => row.contract === zeroMint).reason, /完成.*5 分钟/);
  assert.equal(mock.calls.filter(call => new URL(call.url).pathname === marketPricePath).length, 1);
  let current = time;
  const late = zeroMarketFetch({ response: () => {
    current = new Date(time.getTime() + 46000);
    return Response.json({ code: "0", data: [{ chainIndex: "501", tokenContractAddress: zeroMint,
      price: alternateZeroPrice, time: String(current.getTime()) }] });
  } });
  await assert.rejects(run({ ...late, now: () => current }), /资产|响应/);
  assert.equal(late.calls.filter(call => new URL(call.url).pathname === marketPricePath).length, 1);
});
