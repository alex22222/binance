import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { emptyPortfolio } from "../src/personal-assets-core.mjs";

test("authenticated wallet overview keeps read requests read-only and draft writes isolated with CSRF and revision checks", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-wallet-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: null, portfolio: emptyPortfolio(), snapshots: [] });
  await writeFile(join(directory, "personal-assets.json"), original);
  for (const file of ["strategy-control.json", "authorization.json", "config.json", "state.json"]) await writeFile(join(directory, file), "unchanged");
  const reservation = createServer();
  await new Promise(done => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Basic ${Buffer.from("test-reader:test-password").toString("base64")}` };
  const child = spawn(process.execPath, ["scripts/serve-live-dashboard.mjs"], { cwd: resolve("."),
    env: { ...process.env, DASHBOARD_PORT: String(port), PERSONAL_ASSETS_DIR: directory, OKX_AGENTIC_STATUS_DIR: join(directory, "okx-agentic"),
      DASHBOARD_USERNAME: "test-reader", DASHBOARD_PASSWORD: "test-password", DASHBOARD_PUBLIC_ORIGIN: origin,
      DASHBOARD_MARKET_INDEX_DISABLED: "1", DASHBOARD_STOCK_MARKET_DISABLED: "1", DASHBOARD_WALLET_BALANCE_DISABLED: "1", PERSONAL_ASSETS_FX_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = new Promise(done => child.once("exit", done)); child.kill("SIGTERM"); await stopped; }
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch(origin + "/health", { headers })).ok; } catch {}
    if (ready) break;
    await new Promise(done => setTimeout(done, 30));
  }
  assert.equal(ready, true, stderr);
  for (const path of ["/dashboard", "/dashboard?wallet=okx", "/dashboard?view=execution"]) {
    assert.equal((await fetch(origin + path, { redirect: "manual" })).status, 303);
  }
  for (const path of ["/api/agentic-wallets", "/api/agentic-wallets/preferences"]) assert.equal((await fetch(origin + path)).status, 401);
  const page = await fetch(origin + "/dashboard?wallet=okx", { headers });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/);
  const html = await page.text();
  assert.match(html, /OKX Agentic Wallet/);
  assert.doesNotMatch(html, /id="autoApprovalToggle"|id="stopButton"/);
  const first = await (await fetch(origin + "/api/agentic-wallets", { headers })).json();
  assert.equal(first.wallets.length, 2);
  assert.equal(first.wallets[0].assetsStatus, "MISSING");
  assert.equal(first.okxStatus.status, "MISSING");
  assert.equal(first.preferences.revision, 0);
  assert.equal((await readdir(directory)).length, 5, "GET never creates preferences, sync or runtime files");
  const body = JSON.stringify({ walletId: "okx", strategyId: "okx-pullback-second-wave", revision: 0 });
  const post = extra => fetch(origin + "/api/agentic-wallets/preferences", { method: "POST", headers: { ...headers, "Content-Type": "application/json", ...extra }, body });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ Origin: "https://untrusted.invalid" })).status, 403);
  const saved = await post({ Origin: origin });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).drafts.okx.strategyId, "okx-pullback-second-wave");
  assert.equal((await post({ Origin: origin })).status, 409);
  const again = await (await fetch(origin + "/api/agentic-wallets", { headers })).json();
  assert.equal(again.preferences.revision, 1);
  assert.equal(again.preferences.drafts.okx.strategyId, "okx-pullback-second-wave");
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await fetch(origin + "/api/agentic-wallets", { headers, method })).status, 405);
  const invalid = await fetch(origin + "/api/agentic-wallets/preferences", { method: "POST", headers: { ...headers, "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ walletId: "okx", strategyId: "weekly-etf-dual-momentum-defense", revision: 1 }) });
  assert.equal(invalid.status, 400);
  const old = await fetch(origin + "/dashboard?view=execution", { headers });
  assert.match(await old.text(), /id="autoApprovalToggle"/);
  assert.equal(await readFile(join(directory, "personal-assets.json"), "utf8"), original);
  for (const file of ["strategy-control.json", "authorization.json", "config.json", "state.json"]) assert.equal(await readFile(join(directory, file), "utf8"), "unchanged");
  assert.equal((await readdir(directory)).length, 6, "only the independent draft preference file was added");
});
