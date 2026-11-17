// Public BSC reads only. Never uses a wallet or sends/signs a transaction.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyRfqHistoricalGas(directory, { local = false } = {}) {
  const report = JSON.parse(await readFile(resolve(directory, "quote-report.json"), "utf8"));
  const hashes = [...new Set(report.gas.terminalRows.flatMap(row => [row.txHash, row.entryTxHash, row.exitTxHash]).filter(Boolean))];
  if (!hashes.length || hashes.length > 20 || hashes.some(value => !/^0x[a-fA-F0-9]{64}$/.test(value))) throw new Error("Invalid scoped historical transaction set");
  const requests = [{ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 0 }, ...hashes.map((hash, i) => ({ jsonrpc: "2.0", method: "eth_getTransactionReceipt", params: [hash], id: i + 1 }))];
  const source = `import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const url = "https://bsc-dataseed.binance.org/";
const requests = ${JSON.stringify(requests)};
const attempts = []; let raw;
for (let n = 0; n < 3; n++) {
  const at = new Date().toISOString();
  try { raw = execFileSync("curl", ["-fsSL", "--max-time", "20", "-H", "Content-Type: application/json", "--data-binary", JSON.stringify(requests), url], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 25000, maxBuffer: 2 << 20 });
    const payload = JSON.parse(raw); if (!Array.isArray(payload) || payload.some(row => row.error)) throw new Error("RPC unavailable or returned an error");
    attempts.push({ at, status: "AVAILABLE" }); break;
  } catch { attempts.push({ at, status: "UNAVAILABLE" }); raw = null; }
}
console.log(JSON.stringify({ at: new Date().toISOString(), endpoint: url, requests, attempts, raw, sha256: raw ? createHash("sha256").update(raw).digest("hex") : null }));`;
  const args = ["-i", "/Users/henry/.ssh/polymtrade_vultr_ed25519", "-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ControlPath=none", "root@173.199.122.23", "node --input-type=module"];
  const output = await new Promise((ok, fail) => {
    const child = execFile(local ? process.execPath : "ssh", local ? ["--input-type=module"] : args, { timeout: 90000, maxBuffer: 3 << 20 }, (error, stdout) => error ? fail(new Error("Read-only public receipt verification failed")) : ok(stdout));
    child.stdin.end(source);
  });
  const result = JSON.parse(output);
  await writeFile(resolve(directory, "historical-gas-chain-source.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  if (!result.raw) return { status: "RPC_UNAVAILABLE", verified: [] };
  if (createHash("sha256").update(result.raw).digest("hex") !== result.sha256) throw new Error("RPC source hash mismatch");
  const payload = JSON.parse(result.raw);
  if (payload.find(r => r.id === 0)?.result !== "0x38") throw new Error("Wrong RPC chain");
  const verified = hashes.map((hash, i) => {
    const receipt = payload.find(r => r.id === i + 1)?.result;
    if (receipt?.transactionHash?.toLowerCase() !== hash.toLowerCase() || receipt.status !== "0x1" || !(BigInt(receipt.gasUsed) > 0n) || !(BigInt(receipt.effectiveGasPrice) > 0n)) throw new Error("Missing, failed or mismatched receipt");
    const gasWei = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice), gasBnb = Number(gasWei) / 1e18;
    const row = report.gas.terminalRows.find(r => (r.txHash ?? r.exitTxHash)?.toLowerCase() === hash.toLowerCase());
    const savedBnb = row?.gasBnb ?? row?.exitGasBnb;
    if (savedBnb == null || Math.abs(gasBnb - savedBnb) > 1e-12) throw new Error("Receipt and saved Gas disagree");
    return { symbol: row.symbol, side: row.side, txHash: hash, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, gasWei: gasWei.toString(), gasBnb, savedGasUsdt: row.gasUsdt ?? row.exitGasUsdt, usdEvidence: "HISTORICAL_BOT_SETTLEMENT_CONVERSION_NOT_CURRENT_QUOTE", blockNumber: receipt.blockNumber };
  });
  const summary = { at: result.at, status: "HISTORICAL_NATIVE_GAS_VERIFIED", chainId: "56", verified, currentRouteGasVerified: false };
  await writeFile(resolve(directory, "historical-gas-chain-verification.json"), JSON.stringify(summary, null, 2), { flag: "wx", mode: 0o600 });
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Supply the frozen RFQ collection directory");
  const result = await verifyRfqHistoricalGas(resolve(process.argv[2]));
  console.log(JSON.stringify({ status: result.status, receipts: result.verified.length, currentRouteGasVerified: false }));
}
