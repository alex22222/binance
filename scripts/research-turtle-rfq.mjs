// Explicit one-shot, quote-only collection. Never signs in, swaps or changes settings.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { TURTLE_ETF_UNIVERSE, turtleEtfAssets } from "../src/turtle-etf-universe.mjs";
const exec = promisify(execFile);
const usdt = "0x55d398326f99059fF775485246999027B3197955";
const hash = raw => createHash("sha256").update(raw).digest("hex");
const quantities = ["50", "217.66", "250"];
const publicRoot = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/";
const quoteFields = ["fromCoinSymbol", "fromCoinAmount", "toCoinSymbol", "toCoinAmount", "slippage"];
const safeQuote = quote => Object.fromEntries(quoteFields.filter(key => quote[key] !== undefined).map(key => [key, quote[key]]));

export function assertResearchReadCommand(args) {
  if (args.length === 2 && args[0] === "wallet" && ["status", "settings"].includes(args[1])) return;
  const flags = ["--fromTokenQty", "--fromToken", "--toToken", "--binanceChainId", "--slippage"];
  if (args.length !== 12 || args[0] !== "market-order" || args[1] !== "quote" || flags.some((flag, i) => args[2 + i * 2] !== flag)
    || !/^\d+(\.\d+)?$/.test(args[3]) || !(Number(args[3]) > 0)
    || ![args[5], args[7]].every(address => /^0x[a-fA-F0-9]{40}$/.test(address)) || args[9] !== "56" || args[11] !== "0.5") {
    throw new Error("Research command is not an allowed read-only request");
  }
}

export function roundTripSample(amount, buy, sell, startedAt, endedAt) {
  if (![amount, buy?.toCoinAmount, sell?.toCoinAmount].every(v => /^\d+(\.\d+)?$/.test(String(v)) && Number(v) > 0)) throw new Error("Invalid quote quantity");
  const age = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(age) || age < 0 || age > 30000) throw new Error("Non-comparable quote pair (>30 seconds)");
  return { amount: String(amount), boughtTokenQuantity: String(buy.toCoinAmount), soldTokenQuantity: String(buy.toCoinAmount), returnedUsdt: String(sell.toCoinAmount), quotedRoundTripPct: (1 - Number(sell.toCoinAmount) / Number(amount)) * 100, startedAt, endedAt, evidenceLevel: "READ_ONLY_RFQ_NOT_FILL", gasIncluded: null };
}

async function publicFetch(url) {
  const attempts = [];
  for (let n = 0; n < 3; n++) {
    const at = new Date().toISOString();
    try {
      const { stdout } = await exec("curl", ["-fsSL", "--max-time", "20", "-H", "Accept-Encoding: identity", "-A", "binance-web3/1.1 (Skill)", url], { timeout: 25000, maxBuffer: 4 << 20 });
      const payload = JSON.parse(stdout);
      if (payload.code !== "000000") throw new Error("Public API: " + payload.code);
      return { at, url, sha256: hash(stdout), payload, attempts };
    } catch (e) { attempts.push({ at, error: e.message.slice(0, 300) }); }
  }
  return { at: new Date().toISOString(), url, attempts, unavailable: true };
}
async function cli(args) {
  const { stdout } = await exec("baw", [...args, "--json"], { timeout: 30000, maxBuffer: 1 << 20 });
  const payload = JSON.parse(stdout);
  if (!payload.success) throw new Error(String(payload.error?.message || payload.message || "CLI quote unavailable"));
  return { data: payload.data, sha256: hash(stdout) };
}

export async function collectTurtleRfq(directory, cliRead = cli, publicRead = publicFetch) {
  const report = { at: new Date().toISOString(), mode: "READ_ONLY", automaticTradingEligible: false, amounts: quantities, pairedQuotes: [], regularPairedQuoteCount: 0, failures: [], instruments: [] };
  await mkdir(directory, { recursive: true });
  const status = await cliRead(["wallet", "status"]);
  report.walletStatus = status.data?.status ?? "UNKNOWN";
  // No quote API call, authentication or wallet changes when disconnected.
  if (report.walletStatus !== "CONNECTED") {
    report.status = "BLOCKED_WALLET_UNCONNECTED";
    report.failures = TURTLE_ETF_UNIVERSE.map(({ symbol }) => ({ symbol, stage: "AUTH_PREFLIGHT", reason: report.status }));
  } else {
    const settings = await cliRead(["wallet", "settings"]);
    // Persist only the expiry, never wallet settings or credentials.
    report.sessionExpireTime = settings.data?.sessionExpireTime ?? null;
    report.market = await publicRead(publicRoot + "market/status/ai");
    const directorySource = await publicRead(publicRoot + "stock/detail/list/ai?type=1");
    report.directorySource = directorySource;
    if (directorySource.unavailable) throw new Error("Cannot verify public token identities");
    const assets = turtleEtfAssets(directorySource.payload.data);
    for (const asset of assets) {
      const tokenSymbol = directorySource.payload.data.find(row => row.chainId === "56" && row.contractAddress === asset.contractAddress).symbol;
      const statusSource = await publicRead(publicRoot + `asset/market/status/ai?chainId=56&contractAddress=${asset.contractAddress}`);
      report.instruments.push({ symbol: asset.ticker, tokenSymbol, contractAddress: asset.contractAddress, multiplier: asset.multiplier, statusSource });
      if (statusSource.payload?.data?.openState !== true) {
        report.failures.push(...quantities.map(amount => ({ symbol: asset.ticker, amount, stage: "MARKET_STATUS", reason: statusSource.payload?.data?.reasonCode || "UNKNOWN" }))); continue;
      }
      for (const amount of quantities) {
        const startedAt = new Date().toISOString();
        try {
          const buy = await cliRead(["market-order", "quote", "--fromTokenQty", amount, "--fromToken", usdt, "--toToken", asset.contractAddress, "--binanceChainId", "56", "--slippage", "0.5"]);
          if (!/^\d+(\.\d+)?$/.test(String(buy.data?.toCoinAmount)) || !(Number(buy.data.toCoinAmount) > 0)) throw new Error("Invalid buy output");
          const sell = await cliRead(["market-order", "quote", "--fromTokenQty", String(buy.data.toCoinAmount), "--fromToken", asset.contractAddress, "--toToken", usdt, "--binanceChainId", "56", "--slippage", "0.5"]);
          const marketSession = statusSource.payload.data.marketStatus ?? "UNKNOWN";
          const regularSessionEligible = marketSession === "regular" && report.market.payload?.data?.marketStatus === "regular" && report.market.payload?.data?.openState === true;
          report.pairedQuotes.push({ symbol: asset.ticker, contractAddress: asset.contractAddress, marketSession, regularSessionEligible, ...roundTripSample(amount, buy.data, sell.data, startedAt, new Date().toISOString()), buySourceHash: buy.sha256, sellSourceHash: sell.sha256,
            buyRequest: { fromTokenQty: amount, fromToken: usdt, toToken: asset.contractAddress, binanceChainId: "56", slippage: "0.5" },
            sellRequest: { fromTokenQty: String(buy.data.toCoinAmount), fromToken: asset.contractAddress, toToken: usdt, binanceChainId: "56", slippage: "0.5" },
            buyResponse: safeQuote(buy.data), sellResponse: safeQuote(sell.data),
            quoteExpiry: "NOT_EXPOSED_BY_DOCUMENTED_CLI_SCHEMA", routeGasEstimate: "UNKNOWN" });
        } catch (e) { report.failures.push({ symbol: asset.ticker, amount, stage: "QUOTE_PAIR", at: startedAt, error: e.message.slice(0, 300) }); }
      }
    }
    report.regularPairedQuoteCount = report.pairedQuotes.filter(q => q.regularSessionEligible).length;
    report.status = report.regularPairedQuoteCount === assets.length * quantities.length ? "SINGLE_WINDOW_COLLECTED"
      : report.pairedQuotes.length && !report.regularPairedQuoteCount ? "OFFSESSION_QUOTES_ONLY" : "PARTIAL_OR_UNAVAILABLE";
  }
  await writeFile(resolve(directory, "quote-report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Supply a new isolated quote output directory");
  const report = await collectTurtleRfq(resolve(process.argv[2]));
  console.log(JSON.stringify({ status: report.status, samples: report.pairedQuotes.length, failures: report.failures.length, automaticTradingEligible: false }));
}
