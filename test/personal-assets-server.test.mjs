import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { emptyPortfolio, PLATFORMS } from "../src/personal-assets-core.mjs";

test("personal assets share Dashboard authentication and persist isolated reviewed valuations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "binance-personal-assets-api-"));
  const sentinel = join(directory, "bot-state.json");
  await writeFile(sentinel, '{"position":"untouched"}\n');
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const storedPortfolio = emptyPortfolio();
  storedPortfolio.rates.USD = { value: 2, date, note: "旧手工合成汇率" };
  const statePath = join(directory, "personal-assets.json");
  await writeFile(statePath, JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: null, portfolio: storedPortfolio, snapshots: [] }));
  const port = 41877;
  const origin = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Basic ${Buffer.from("asset-tester:local-test-password").toString("base64")}` };
  const child = spawn(process.execPath, ["scripts/serve-live-dashboard.mjs"], {
    cwd: resolve("."),
    env: { ...process.env, DASHBOARD_PORT: String(port), PERSONAL_ASSETS_DIR: directory,
      DASHBOARD_USERNAME: "asset-tester", DASHBOARD_PASSWORD: "local-test-password",
      DASHBOARD_PUBLIC_ORIGIN: "https://assets.example.com", DASHBOARD_MARKET_INDEX_DISABLED: "1",
      DASHBOARD_STOCK_MARKET_DISABLED: "1", DASHBOARD_WALLET_BALANCE_DISABLED: "1", PERSONAL_ASSETS_FX_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { ready = (await fetch(`${origin}/health`, { headers })).ok; } catch {}
      if (ready) break;
      await new Promise((done) => setTimeout(done, 30));
    }
    assert.equal(ready, true, stderr);
    const entry = await fetch(`${origin}/assets?view=overview`, { redirect: "manual" });
    assert.equal(entry.status, 303);
    assert.equal(entry.headers.get("location"), "/login");
    for (const path of ["/api/assets/funds/configure", "/api/assets", "/api/assets/rates/refresh", "/api/assets/sync", "/api/assets/sync/futu/callback", "/api/assets/ai", "/api/assets/ai/review", "/api/assets/ai/configure", "/api/assets/statement-passwords", "/assets/app.mjs", "/assets/core.mjs", "/assets/ocr/worker.min.js"]) {
      assert.equal((await fetch(origin + path)).status, 401, path);
    }
    const page = await fetch(`${origin}/assets`, { headers });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("content-security-policy"), /worker-src 'self' blob:/);
    assert.match(page.headers.get("content-security-policy"), /wasm-unsafe-eval/);
    const html = await page.text();
    assert.match(html, /href="\/assets" aria-current="page"/);
    const landing = await fetch(`${origin}/`, { headers, redirect: "manual" });
    assert.equal(landing.status, 302);
    assert.equal(landing.headers.get("location"), "/assets");
    assert.equal(landing.headers.get("cache-control"), "no-store");
    for (const userAgent of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Lark/7.30.0 LarkLocale/zh_CN ChannelName/Feishu",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Feishu/7.30.0 Chrome/120.0 Safari/537.36"
    ]) {
      const fromFeishu = await fetch(`${origin}/`, { headers: { ...headers, "User-Agent": userAgent }, redirect: "manual" });
      assert.equal(fromFeishu.status, 302);
      assert.equal(fromFeishu.headers.get("location"), "/dashboard", userAgent);
      assert.equal(fromFeishu.headers.get("vary"), "User-Agent");
    }
    const fromSafari = await fetch(`${origin}/`, { headers: { ...headers, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" }, redirect: "manual" });
    assert.equal(fromSafari.headers.get("location"), "/assets");
    for (const path of ["/dashboard", "/dashboard/"]) {
      const dashboard = await fetch(origin + path, { headers, redirect: "manual" });
      assert.equal(dashboard.status, 200, path);
      assert.equal(dashboard.headers.get("cache-control"), "no-store", path);
      const dashboardHtml = await dashboard.text();
      assert.match(dashboardHtml, /<a href="\/dashboard" aria-current="page">币安Agent Wallet<\/a>/, path);
      assert.match(dashboardHtml, /id="autoApprovalToggle"/, path);
    }
    for (const path of ["/dashboard", "/dashboard/"]) {
      const anonymous = await fetch(origin + path, { redirect: "manual" });
      assert.equal(anonymous.status, 303, path);
      assert.equal(anonymous.headers.get("location"), "/login", path);
    }
    assert.match(html, /个人资产/);
    assert.match(html, /\/assets\/app\.mjs/);
    const core = await fetch(`${origin}/assets/core.mjs`, { headers });
    assert.equal(core.status, 200);
    assert.match(await core.text(), /export function summarize/);
    const model = await fetch(`${origin}/assets/ocr/lang/chi_sim.traineddata.gz`, { headers });
    assert.equal(model.status, 200);
    assert.equal(model.headers.get("x-content-type-options"), "nosniff");
    await model.arrayBuffer();
    assert.equal((await fetch(`${origin}/assets/ocr/config.json`, { headers })).status, 404);
    const initial = await (await fetch(`${origin}/api/assets`, { headers })).json();
    assert.equal(initial.fx.mode, "automatic");
    assert.equal(initial.fx.status, "unavailable");
    assert.equal(initial.sync.providers.polymarket.connected, false);
    assert.equal(initial.sync.providers.polymarket.targetAccountId, null);
    assert.equal("preview" in initial.sync.providers.okx, false);
    assert.equal("accounts" in initial.sync.providers.futu, false);
    assert.equal("selectedAccountId" in initial.sync.providers.futu, false);
    assert.equal("wallets" in initial.sync.providers.okxweb3, false);
    assert.equal("wallets" in initial.sync.providers.tokenpocket, false);
    for(const provider of ["binanceagentic","okxagentic"]){assert.equal(initial.sync.providers[provider].connected,false);assert.equal("wallets" in initial.sync.providers[provider],false);assert.equal("credentialRef" in initial.sync.providers[provider],false);}
    assert.equal(initial.sync.developerCredentialsAvailable,false);
    assert.deepEqual(Object.keys(initial.portfolio.rates), ["CNY"]);
    assert.deepEqual(initial.funds, { status: "available", bindings: [] });
    for (const extra of [{}, { Origin: "https://attacker.example" }]) assert.equal((await fetch(`${origin}/api/assets/funds/configure`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", ...extra }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${origin}/api/assets/funds/configure`, { method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 400);
    const beforeRefresh = await readFile(statePath, "utf8");
    const passwordPage = "/assets?settings=statement-passwords";
    assert.equal((await fetch(origin + passwordPage, { redirect: "manual" })).headers.get("location"), "/login");
    const passwordResponse = await fetch(origin + passwordPage, { headers });
    assert.equal(passwordResponse.status, 200);
    assert.equal(passwordResponse.headers.get("cache-control"), "no-store");
    const passwordHtml = await passwordResponse.text();
    assert.match(html, /role="menuitem" href="\/assets\?settings=statement-passwords"/);
    assert.match(passwordHtml, /盈立香港[\s\S]*盈立新加坡/);
    assert.match(passwordHtml, /type="password"/);
    assert.doesNotMatch(passwordHtml, /\/assets\/app\.mjs|\/api\/assets\/ai/);
    const nonce = passwordResponse.headers.get("content-security-policy").match(/'nonce-([^']+)'/)[1];
    assert.ok(passwordHtml.includes(`<script nonce="${nonce}">`));
    const passwordApi = `${origin}/api/assets/statement-passwords`;
    const passwordPost = (body, extra = {}) => fetch(passwordApi, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Origin: origin, ...extra }, body: JSON.stringify(body) });
    assert.equal((await fetch(passwordApi, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 401);
    for (const extra of [{ Origin: "" }, { Origin: "https://attacker.example" }]) assert.equal((await passwordPost({ provider: "usmart-hk", password: "synthetic statement password" }, extra)).status, 403);
    assert.equal((await passwordPost({ provider: "usmart-hk", password: "synthetic statement password", apiKey: "unrelated" })).status, 400);
    const savedPassword = await passwordPost({ provider: "usmart-hk", password: "synthetic statement password" });
    assert.equal(savedPassword.status, 200);
    const passwordStatus = await savedPassword.text();
    assert.equal(JSON.parse(passwordStatus).providers["usmart-hk"].configured, true);
    assert.doesNotMatch(passwordStatus, /synthetic statement password|"password"/);
    const configPath = join(directory, "personal-assets-statement-passwords.json");
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.match(await readFile(configPath, "utf8"), /synthetic statement password/);
    assert.doesNotMatch(await (await fetch(`${origin}/api/assets`, { headers })).text(), /synthetic statement password|statement-passwords/);
    assert.equal((await fetch(`${origin}/state/personal-assets-statement-passwords.json`, { headers })).status, 404);
    assert.equal((await fetch(passwordApi, { method: "PUT", headers })).status, 405);
    assert.equal((await passwordPost({ provider: "usmart-hk", clear: true })).status, 200);
    assert.equal((await (await fetch(passwordApi, { headers })).json()).providers["usmart-hk"].configured, false);
    assert.doesNotMatch(await readFile(configPath, "utf8"), /synthetic statement password/);
    assert.equal(await readFile(statePath, "utf8"), beforeRefresh);
    for (const action of ["review", "configure"]) {
      const path = `${origin}/api/assets/ai/${action}`;
      assert.equal((await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,401);
      for (const extra of [{},{Origin:"https://attacker.example"}]) assert.equal((await fetch(path,{method:"POST",headers:{...headers,"Content-Type":"application/json",...extra},body:"{}"})).status,403);
    }
    const aiStatus=await (await fetch(`${origin}/api/assets/ai`,{headers})).json();
    assert.equal(aiStatus.configured,false);assert.equal("apiKey" in aiStatus,false);
    const aiReview=await fetch(`${origin}/api/assets/ai/review`,{method:"POST",headers:{...headers,Origin:origin,"Content-Type":"application/json"},body:"{}"});
    assert.equal(aiReview.status,200);assert.equal((await aiReview.json()).status,"unconfigured");
    assert.equal(await readFile(statePath,"utf8"),beforeRefresh);

    for (const extra of [{}, { Origin: "https://attacker.example" }]) {
      assert.equal((await fetch(`${origin}/api/assets/rates/refresh`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", ...extra }, body: "{}" })).status, 403);
    }
    const refreshed = await fetch(`${origin}/api/assets/rates/refresh`, { method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(refreshed.status, 200);
    const refreshState = await refreshed.json();
    assert.equal(refreshState.revision, 0);
    assert.equal(refreshState.fx.status, "unavailable");
    assert.equal(await readFile(statePath, "utf8"), beforeRefresh);
    const sync = await fetch(`${origin}/api/assets/sync`, { headers });
    assert.equal(sync.headers.get("cache-control"), "no-store");
    assert.equal((await sync.json()).providers.okx.connected, false);
    for (const provider of ["okx", "futu", "polymarket", "future", "okxweb3", "tokenpocket", "binanceagentic", "okxagentic"]) {
      for (const action of ["bind", "connect", "authorize", "preview", "apply", "disconnect"]) {
        const path = `/api/assets/sync/${provider}/${action}`;
        assert.equal((await fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}" })).status, 401);
        assert.equal((await fetch(origin + path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" })).status, 403);
        assert.equal((await fetch(origin + path, { method: "POST", headers: { ...headers, Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
      }
    }
    const invalidKey = await fetch(`${origin}/api/assets/sync/okx/connect`, { method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(invalidKey.status, 400);
    const invalidAddress = await fetch(`${origin}/api/assets/sync/polymarket/connect`, { method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(invalidAddress.status, 400);
    const targetAccountId = initial.portfolio.accounts.find((account) => account.platform === "TokenPocket").id;
    const wallets = [{ chainIndex: "137", address: `0x${"ab".repeat(20)}` }];
    const bind = (body) => fetch(`${origin}/api/assets/sync/tokenpocket/bind`, { method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await bind({ targetAccountId, wallets, apiKey: "not-allowed-on-bind" })).status, 400);
    const binding = await bind({ targetAccountId, wallets });
    assert.equal(binding.status, 200);
    const bound = (await binding.json()).providers.tokenpocket;
    assert.deepEqual(bound.wallets, wallets);
    assert.equal(bound.connected, false);
    assert.equal(bound.enabled, false);
    assert.equal(await readFile(statePath, "utf8"), beforeRefresh);
    assert.doesNotMatch(await readFile(join(directory, "personal-assets-sync.json"), "utf8"), /not-allowed-on-bind|credentials/);
    const assetSummary = (await (await fetch(`${origin}/api/assets`, { headers })).json()).sync.providers.tokenpocket;
    assert.equal(assetSummary.targetAccountId, targetAccountId);
    assert.equal("wallets" in assetSummary, false);
    const privateStatus = await (await fetch(`${origin}/api/assets/sync`, { headers })).json();
    assert.deepEqual(privateStatus.providers.tokenpocket.wallets, wallets);
    const noDeveloper = await fetch(`${origin}/api/assets/sync/tokenpocket/connect`, { method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ targetAccountId }) });
    assert.equal(noDeveloper.status, 400);
    assert.equal((await fetch(`${origin}/api/assets/sync/okx/bind`, { method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 404);
    assert.equal((await fetch(`${origin}/state/personal-assets-sync.json`, { headers })).status, 404);
    const invalidCallback = await fetch(`${origin}/api/assets/sync/futu/callback?code=synthetic&state=wrong`, { headers, redirect: "manual" });
    assert.equal(invalidCallback.status, 303);
    assert.equal(invalidCallback.headers.get("location"), "/assets?sync=futu-error");
    assert.equal(invalidCallback.headers.get("referrer-policy"), "no-referrer");
    const accountRetry = "/api/assets/sync/futu/accounts";
    assert.equal((await fetch(origin + accountRetry, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await fetch(origin + accountRetry, { method: "POST", headers: { ...headers, Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await fetch(origin + accountRetry, { method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 400);
    assert.equal(initial.revision, 0);
    assert.deepEqual(initial.portfolio.entries, []);
    assert.equal(initial.portfolio.accounts.length, PLATFORMS.length);
    const portfolio = initial.portfolio;
    portfolio.rates.USD = { value: 999, date, note: "客户端缓存不应入账" };
    portfolio.entries = [{ id: "test-entry", accountId: portfolio.accounts[0].id, kind: "total", name: "合成测试估值", category: "基金", currency: "CNY", amount: 100, asOf: date, source: "manual" }];
    async function put(body, extra = {}) {
      return fetch(`${origin}/api/assets`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json", Origin: origin, ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
    }
    assert.equal((await put({ portfolio, revision: 0 }, { Origin: "https://attacker.example" })).status, 403);
    const withoutOrigin = await fetch(`${origin}/api/assets`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ portfolio, revision: 0 }) });
    assert.equal(withoutOrigin.status, 403);
    assert.equal((await put("not JSON")).status, 400);
    assert.equal((await put({ portfolio, revision: 0 }, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await put("x".repeat(1_500_001))).status, 413);
    const saved = await put({ portfolio, revision: 0 });
    assert.equal(saved.status, 200);
    const savedState = await saved.json();
    assert.equal(savedState.revision, 1);
    assert.equal(savedState.fx.status, "unavailable");
    assert.deepEqual(Object.keys(savedState.portfolio.rates), ["CNY"]);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).portfolio.rates.USD, storedPortfolio.rates.USD);
    assert.equal((await put({ portfolio, revision: 0 })).status, 409);
    const latest = await (await fetch(`${origin}/api/assets`, { headers })).json();
    assert.equal(latest.portfolio.entries[0].amount, 100);
    const invalid = structuredClone(portfolio); invalid.entries[0].amount = -1;
    assert.equal((await put({ portfolio: invalid, revision: 1 })).status, 400);
    const snapshots = () => fetch(`${origin}/api/assets/snapshots`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Origin: origin }, body: '{"revision":1}' });
    const firstSnapshot = await snapshots();
    assert.equal(firstSnapshot.status, 200);
    const first = await firstSnapshot.json();
    assert.equal(first.snapshots[0].total, 100);
    assert.match(first.snapshots[0].valuationId, /^[a-f0-9]{64}$/);
    const snapshot = JSON.parse(await readFile(join(directory, "personal-assets-snapshots", `${first.snapshots[0].id}.json`), "utf8"));
    assert.equal(snapshot.fx.status, "unavailable");
    assert.deepEqual(Object.keys(snapshot.portfolio.rates), ["CNY"]);
    assert.equal("portfolio" in first.snapshots[0], false);
    assert.equal((await (await snapshots()).json()).snapshots[0].id, first.snapshots[0].id);
    const beforeBadSync = await readFile(statePath, "utf8");
    await writeFile(join(directory, "personal-assets-sync.json"), "{", { mode: 0o600 });
    const withoutSync = await fetch(`${origin}/api/assets`, { headers });
    assert.equal(withoutSync.status, 200);
    const retained = await withoutSync.json();
    assert.equal(retained.portfolio.entries[0].amount, 100);
    assert.equal(retained.sync.status, "unavailable");
    assert.match(retained.sync.error, /同步状态暂不可用/);
    assert.deepEqual(retained.sync.providers, {});
    assert.equal((await fetch(`${origin}/api/assets/sync`, { headers })).status, 500);
    assert.equal(await readFile(statePath, "utf8"), beforeBadSync);
    assert.equal(await readFile(sentinel, "utf8"), '{"position":"untouched"}\n');
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((done) => child.once("exit", done));
  }
});
