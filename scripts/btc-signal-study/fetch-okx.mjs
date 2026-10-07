// OKX fills: XAUT daily candles (radar gold factor) and recent BTC-USDT-SWAP funding.
import { writeFile } from "node:fs/promises";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function okx(path) {
  const response = await fetch(`https://www.okx.com${path}`);
  const body = await response.json();
  if (body.code !== "0") throw new Error(`${body.code} ${body.msg} ${path}`);
  return body.data;
}
const candles = [];
for (let after = ""; ; ) {
  const page = await okx(`/api/v5/market/history-candles?instId=XAUT-USDT&bar=1Dutc&limit=100${after ? `&after=${after}` : ""}`);
  if (!page.length) break;
  candles.push(...page);
  after = page.at(-1)[0];
  await pause(250);
}
await writeFile(new URL("./data/xaut.json", import.meta.url), JSON.stringify(candles.map(([ts, , , , close, , , , confirm]) => ({ ts: Number(ts), close: Number(close), confirm }))));
console.log("xaut", candles.length, new Date(Number(candles.at(-1)[0])).toISOString().slice(0, 10), new Date(Number(candles[0][0])).toISOString().slice(0, 10));
const funding = [];
for (let after = ""; ; ) {
  const page = await okx(`/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100${after ? `&after=${after}` : ""}`);
  if (!page.length) break;
  funding.push(...page.map(({ fundingTime, realizedRate, fundingRate }) => ({ ts: Number(fundingTime), rate: Number(realizedRate || fundingRate) })));
  after = page.at(-1).fundingTime;
  await pause(250);
}
await writeFile(new URL("./data/okx-funding.json", import.meta.url), JSON.stringify(funding));
console.log("okx funding", funding.length, new Date(funding.at(-1).ts).toISOString(), new Date(funding[0].ts).toISOString());
