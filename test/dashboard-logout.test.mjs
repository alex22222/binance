import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("dashboard logout clears this browser session without Basic fallback or trading state writes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-logout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const configPath = join(directory, "config.json");
  const renewalPath = join(directory, "renewal.json");
  const state = JSON.stringify({ wallet: "CONNECTED", positions: [{ symbol: "SPY" }] });
  const config = JSON.stringify({ stateFile: statePath });
  const renewal = JSON.stringify({ enabled: true, totalExpiresAt: "2026-11-21T04:00:49Z" });
  await Promise.all([writeFile(statePath, state), writeFile(configPath, config), writeFile(renewalPath, renewal)]);
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  const origin = `http://127.0.0.1:${port}`;
  const publicOrigin = "https://stocks.example.test";
  const authorization = `Basic ${Buffer.from("operator:fixture-password").toString("base64")}`;
  const child = spawn(process.execPath, ["scripts/serve-live-dashboard.mjs"], {
    cwd: resolve("."),
    env: { ...process.env, BOT_CONFIG: configPath, PERSONAL_ASSETS_DIR: directory, DASHBOARD_PORT: String(port), DASHBOARD_USERNAME: "operator", DASHBOARD_PASSWORD: "fixture-password", DASHBOARD_PUBLIC_ORIGIN: publicOrigin, DASHBOARD_MARKET_INDEX_DISABLED: "1", DASHBOARD_STOCK_MARKET_DISABLED: "1", DASHBOARD_WALLET_BALANCE_DISABLED: "1", BAW_CLI_PATH: join(directory, "no-wallet-cli") },
    stdio: "ignore"
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  const request = (path, options = {}) => fetch(`${origin}${path}`, { redirect: "manual", ...options });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await request("/health", { headers: { Authorization: authorization } })).ok; } catch {}
    if (ready || child.exitCode !== null) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(ready, true);
  const login = (cookie = "", remember = false) => request("/login", { method: "POST", headers: { Origin: publicOrigin, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: "operator", password: "fixture-password", ...(remember ? { remember: "1" } : {}) }) });
  for (const remember of [false, true]) {
    const signedIn = await login("", remember);
    assert.equal(signedIn.status, 303);
    const originalCookie = signedIn.headers.get("set-cookie").split(";")[0];
    assert.equal((await request("/health", { headers: { Cookie: originalCookie } })).status, 200);
    for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
      const rejected = await request("/logout", { method, headers: { Origin: publicOrigin, Cookie: originalCookie } });
      assert.equal(rejected.status, 405);
      assert.equal(rejected.headers.get("allow"), "POST");
      assert.equal(rejected.headers.get("set-cookie"), null);
    }
    for (const badOrigin of [null, "null", "https://other.example.test"]) {
      const rejected = await request("/logout", { method: "POST", headers: { Cookie: originalCookie, ...(badOrigin ? { Origin: badOrigin } : {}) } });
      assert.equal(rejected.status, 403);
      assert.equal(rejected.headers.get("set-cookie"), null);
    }
    const signedOut = await request("/logout", { method: "POST", headers: { Origin: publicOrigin, Cookie: originalCookie } });
    assert.equal(signedOut.status, 200);
    assert.deepEqual(await signedOut.json(), { success: true });
    assert.equal(signedOut.headers.get("cache-control"), "no-store");
    const cleared = signedOut.headers.get("set-cookie");
    assert.match(cleared, /^dashboard_session=signed-out; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
    const cookie = cleared.split(";")[0];
    for (const headers of [{ Cookie: cookie }, { Cookie: `other=1; ${cookie}`, Authorization: authorization }]) {
      const health = await request("/health", { headers });
      assert.equal(health.status, 401);
      assert.equal(health.headers.get("www-authenticate"), null);
      const page = await request("/assets", { headers });
      assert.equal(page.status, 303);
      assert.equal(page.headers.get("location"), "/login");
    }
    assert.equal((await request("/login", { headers: { Cookie: cookie, Authorization: authorization } })).status, 200);
    const signedInAgain = await login(cookie, remember);
    assert.equal(signedInAgain.status, 303);
    assert.equal((await request("/health", { headers: { Cookie: signedInAgain.headers.get("set-cookie").split(";")[0] } })).status, 200);
    for (const expiredCookie of [cookie, "dashboard_session=expired", ""]) {
      assert.equal((await request("/logout", { method: "POST", headers: { Origin: publicOrigin, Cookie: expiredCookie } })).status, 200);
    }
  }
  assert.equal(await readFile(statePath, "utf8"), state);
  assert.equal(await readFile(configPath, "utf8"), config);
  assert.equal(await readFile(renewalPath, "utf8"), renewal);
});
