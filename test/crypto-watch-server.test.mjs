import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("crypto reports use Dashboard authentication and read-only routes without changing trading state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "binance-crypto-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentinel = join(directory, "bot-state.json");
  await writeFile(sentinel, '{"position":"untouched"}\n');
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Basic ${Buffer.from("crypto-tester:local-test-password").toString("base64")}` };
  const child = spawn(process.execPath, ["scripts/serve-live-dashboard.mjs"], {
    cwd: resolve("."),
    env: { ...process.env, DASHBOARD_PORT: String(port), PERSONAL_ASSETS_DIR: directory,
      CRYPTO_WATCH_DIR: join(directory, "crypto"), BTC_RADAR_DIR: join(directory, "btc-radar"), OKX_AGENTIC_STATUS_DIR: join(directory, "okx-agentic"), DASHBOARD_USERNAME: "crypto-tester", DASHBOARD_PASSWORD: "local-test-password",
      DASHBOARD_PUBLIC_ORIGIN: "https://crypto.example.com", DASHBOARD_MARKET_INDEX_DISABLED: "1",
      DASHBOARD_STOCK_MARKET_DISABLED: "1", DASHBOARD_WALLET_BALANCE_DISABLED: "1", PERSONAL_ASSETS_FX_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill("SIGTERM");
      await exited;
    }
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = (await fetch(`${origin}/health`, { headers })).ok; } catch {}
    if (ready) break;
    await new Promise((done) => setTimeout(done, 30));
  }
  assert.equal(ready, true, stderr);
  for (const path of ["/crypto", "/crypto/", "/api/crypto"]) {
    assert.equal((await fetch(origin + path, { redirect: "manual" })).status, 401, path);
    const response = await fetch(origin + path, { headers });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    if (path === "/api/crypto") {
      const body = await response.json();
      assert.equal(body.status, "MISSING");
      assert.equal(body.latest, null);
    } else {
      assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
      const html = await response.text();
      assert.match(html, /href="\/crypto" aria-current="page"/);
      assert.match(html, /数字货币/);
      assert.doesNotMatch(html, /<script/);
    }
  }
  assert.equal((await fetch(`${origin}/api/crypto`, { headers, method: "POST" })).status, 405);
  assert.equal((await fetch(`${origin}/state/crypto/watchlist.json`, { headers })).status, 404);
  const btc = await fetch(`${origin}/btc-radar`, { headers });
  assert.equal(btc.status, 200);
  const btcHtml = await btc.text();
  assert.match(btcHtml, /href="\/crypto" aria-current="page"/);
  assert.match(btcHtml, /收藏/);
  assert.doesNotMatch(btcHtml, /<script|<iframe/);
  const detailed = await fetch(`${origin}/btc-radar?view=detail`, { headers });
  assert.equal(detailed.status, 200);
  assert.match(await detailed.text(), /<script nonce=/);
  const combined = await (await fetch(`${origin}/api/digital-currency`, { headers })).json();
  assert.equal(combined.watch.status, "MISSING");
  assert.equal(combined.radar.status, "MISSING");
  assert.equal((await fetch(`${origin}/api/digital-currency`, { headers, method: "POST" })).status, 405);
  for (const path of ["/agentic-wallet/okx", "/api/agentic-wallet/okx"]) {
    assert.equal((await fetch(origin + path, { redirect: "manual" })).status, 401);
    const view = await fetch(origin + path, { headers });
    assert.equal(view.status, 200);
    assert.equal(view.headers.get("cache-control"), "no-store");
    if (path.startsWith("/api/")) {
      const value = await view.json();
      assert.equal(value.status.status, "MISSING");
      assert.equal(value.status.snapshot, null);
      assert.ok(value.assets);
      assert.doesNotMatch(JSON.stringify(value), /credential|privateKey|sessionKey|apiKey/);
    } else {
      const html = await view.text();
      assert.match(html, /OKX Agentic Wallet/);
      assert.match(html, /href="\/agentic-wallet\/okx" aria-current="page"/);
      assert.doesNotMatch(html, /<script|<iframe/);
    }
    assert.equal((await fetch(origin + path, { headers, method: "POST" })).status, 405);
  }
  assert.equal(await readFile(sentinel, "utf8"), '{"position":"untouched"}\n');
});
