import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { REPORT_SECTIONS } from "../src/fund-manager-delivery.mjs";

test("market landing is authenticated and read-only, preserves trading entry, and discovers new formal reports", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "market-landing-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reports = join(directory, "fund-manager");
  await mkdir(reports);
  const sentinel = join(directory, "personal-assets.json");
  const original = '{"schemaVersion":1,"revision":0,"entries":[],"snapshots":[]}\n';
  await writeFile(sentinel, original);
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Basic ${Buffer.from("market-reader:local-test-password").toString("base64")}` };
  const child = spawn(process.execPath, ["scripts/serve-live-dashboard.mjs"], {
    cwd: resolve("."),
    env: { ...process.env, DASHBOARD_PORT: String(port), PERSONAL_ASSETS_DIR: directory,
      MARKET_OVERVIEW_DIR: join(directory, "market-overview"), FUND_MANAGER_DIR: reports,
      DASHBOARD_USERNAME: "market-reader", DASHBOARD_PASSWORD: "local-test-password",
      DASHBOARD_PUBLIC_ORIGIN: origin, DASHBOARD_MARKET_INDEX_DISABLED: "1",
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
  const anonymousRoot = await fetch(`${origin}/`, { redirect: "manual" });
  assert.equal(anonymousRoot.status, 303);
  assert.equal(anonymousRoot.headers.get("location"), "/login");
  for (const path of ["/market", "/api/market-overview"]) assert.equal((await fetch(origin + path, { redirect: "manual" })).status, 401);
  for (const path of ["/", "/?period=1d", "/market", "/market/?period=20d"]) {
    const page = await fetch(origin + path, { headers });
    assert.equal(page.status, 200, path);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    const html = await page.text();
    assert.match(html, /资本市场温度/);
    assert.match(html, /href="\/market" aria-current="page"/);
    assert.doesNotMatch(html, /<script/);
  }
  assert.equal((await fetch(`${origin}/?period=arbitrary`, { headers })).status, 400);
  assert.equal((await fetch(`${origin}/api/market-overview`, { headers, method: "POST" })).status, 405);
  const missing = await (await fetch(`${origin}/api/market-overview`, { headers })).json();
  assert.equal(missing.market.status, "MISSING");
  assert.equal(missing.reports.latest, null);
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  const text = `# 基金经理日报 ${date}\n\n${REPORT_SECTIONS.map((section) => `## ${section}\n\n${section === "经理结论" ? "自动发现新正式报告，保持风险预算。" : "已核对报告内容。"}`).join("\n\n")}\n\n## 市场与 AI 研究\n观察AI与大盘相对强弱。`;
  await writeFile(join(reports, `${date}-preview.md`), text.replace("自动发现新正式报告", "不应出现的预览"));
  await writeFile(join(reports, `${date}-preview.html`), "preview");
  await writeFile(join(reports, `${date}-daily.md`), text);
  assert.equal((await (await fetch(`${origin}/api/market-overview`, { headers })).json()).reports.latest, null);
  await writeFile(join(reports, `${date}-daily.html`), "<!doctype html><html><body>archived</body></html>");
  const published = await (await fetch(`${origin}/api/market-overview`, { headers })).json();
  assert.equal(published.reports.latest.date, date);
  const updated = await (await fetch(`${origin}/`, { headers })).text();
  assert.match(updated, /自动发现新正式报告/);
  assert.doesNotMatch(updated, /不应出现的预览/);
  assert.ok(updated.includes(`/fund-manager?date=${date}&amp;edition=daily`));
  const trading = await fetch(`${origin}/dashboard`, { headers });
  assert.equal(trading.status, 200);
  assert.match(await trading.text(), /id="wallet-okx"/);
  const execution = await fetch(`${origin}/dashboard?view=execution`, { headers });
  assert.equal(execution.status, 200);
  assert.match(await execution.text(), /id="autoApprovalToggle"/);
  assert.equal((await fetch(`${origin}/assets`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/state/market-overview/latest.json`, { headers })).status, 404);
  assert.equal(await readFile(sentinel, "utf8"), original);
});
