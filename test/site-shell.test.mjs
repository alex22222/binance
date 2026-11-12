import assert from "node:assert/strict";
import test from "node:test";
import { btcRadarHtml } from "../src/btc-radar-html.mjs";
import { dashboardLoginHtml } from "../src/dashboard-login-html.mjs";
import { fundManagerHtml } from "../src/fund-manager-html.mjs";
import { liveDashboardHtml } from "../src/live-dashboard-html.mjs";
import { SITE_CSS, SITE_NAV, siteHeader, themeFromCookie, themeToggleHref } from "../src/site-shell.mjs";
import { strategyLabHtml } from "../src/strategy-lab-html.mjs";
import { tradeReviewHtml } from "../src/trade-review-html.mjs";
import { weeklyResearchHtml } from "../src/weekly-research-html.mjs";

test("the shared header marks only the active page and needs no image", () => {
  const html = siteHeader("/btc-radar", '<span id="slot">x</span>');
  assert.deepEqual([...html.matchAll(/<a href="([^"]+)"/g)].map(([, href]) => href), SITE_NAV.map(([href]) => href));
  assert.deepEqual([...html.matchAll(/aria-current="page">([^<]+)</g)].map(([, label]) => label), ["BTC 与收藏"]);
  assert.match(html, /<div class="site-actions"><span id="slot">x<\/span><\/div>/);
  assert.match(siteHeader("/"), /site-settings/);
  assert.doesNotMatch(html + SITE_CSS, /<img|url\(/);
});

test("light is the default theme, dark stays behind data-theme, and brand hue stays indigo", () => {
  assert.match(SITE_CSS, /:root\{color-scheme:light;/);
  assert.match(SITE_CSS, /:root\[data-theme=dark\]\{color-scheme:dark;/);
  assert.match(SITE_CSS, /--brand:#5266eb/);
  assert.match(SITE_CSS, /:root\[data-theme=dark\]\{[^}]*--brand:#7b8cff/);
  assert.match(SITE_CSS, /--nav-width:1280px/);
  assert.match(SITE_CSS, /--font:ui-sans-serif/);
  assert.doesNotMatch(SITE_CSS, /Inter,/);
  const fixes = SITE_CSS.split("\n").filter((line) => line.includes("body:has("));
  assert.ok(fixes.length >= 10);
  for (const line of fixes) {
    assert.match(line, /^html:not\(\[data-theme=dark\]\) body:has\((\.site-nav a\[aria-current\]\[href="\/dashboard"\]|form\[action="\/login"\])\)/, line);
  }
});

test("theme helpers read the cookie and build a safe toggle link", () => {
  assert.equal(themeFromCookie(""), "light");
  assert.equal(themeFromCookie("hq-theme=dark"), "dark");
  assert.equal(themeFromCookie("a=1; hq-theme=light; b=2"), "light");
  assert.equal(themeToggleHref("dark", "/crypto"), "/api/theme?set=dark&next=%2Fcrypto");
  assert.equal(themeToggleHref("light", "//evil"), "/api/theme?set=light&next=%2F");
});

test("navigation leads with market overview and groups the wallet pages in one Chinese dropdown", () => {
  for (const active of ["/", "/dashboard"]) {
    const html = siteHeader(active);
    const links = [...html.matchAll(/<a href="([^"]+)"(?: aria-current="page")?>([^<]+)<\/a>/g)]
      .map(([, href, label]) => [href, label]);
    assert.deepEqual(links.slice(0, 3), [["/market", "市场总览"], ["/assets", "个人资产"], ["/dashboard", "交易总览"]], active);
    assert.match(html, /<a href="\/dashboard" aria-current="page">交易总览<\/a>/, active);
    assert.equal(html.match(/aria-current="page"/g)?.length, 1, active);
  }
  const top = (html) => [...html.split("</nav>")[0].replace(/<div class="site-submenu">[\s\S]*?<\/div>/g, "").matchAll(/<a href="([^"]+)"[^>]*>|<summary>([^<]+)<\/summary>/g)].map(([, href, group]) => href || group);
  assert.deepEqual(top(siteHeader("/assets")), ["/market", "/assets", "智能钱包", "数字货币", "https://polyhermes.107-191-42-75.sslip.io/future-btc5m-bridge", "https://polym.trade/perps"]);
  const menu = siteHeader("/assets").match(/<details class="site-group"><summary>智能钱包<\/summary><div class="site-submenu">([\s\S]*?)<\/div><\/details>/)[1];
  assert.deepEqual([...menu.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(([, href, label]) => [href, label]),
    [["/dashboard", "交易总览"], ["/agentic-wallet/okx", "OKX 钱包"], ["/strategies", "策略"], ["/reviews", "复盘"], ["/fund-manager", "基金经理"], ["/operations", "运行总览"]]);
  for (const active of ["/agentic-wallet/okx", "/strategies", "/reviews", "/fund-manager", "/operations"]) {
    assert.match(siteHeader(active), new RegExp(`<details class="site-group is-current"><summary>智能钱包</summary>[^]*<a href="${active}" aria-current="page">`), active);
  }
  assert.doesNotMatch(SITE_CSS, /\.site-nav\{[^}]*overflow/);
  const html = siteHeader("/assets");
  assert.match(html, /<a class="site-brand" href="\/"><span class="site-mark" aria-hidden="true">H<\/span><span class="site-name">HQ Capital<\/span><\/a>/);
  assert.doesNotMatch(html, /Agentic Wallet<\/span>/);
  assert.match(html, /class="site-theme"[^>]*>深色模式</);
});

test("digital currency groups the combined BTC and favorites page with GMGN", () => {
  const menu = siteHeader("/assets").match(/<details class="site-group"><summary>数字货币<\/summary><div class="site-submenu">([\s\S]*?)<\/div><\/details>/)?.[1];
  assert.ok(menu);
  assert.deepEqual([...menu.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(([, href, label]) => [href, label]),
    [["/crypto", "BTC 与收藏"], ["/crypto/desk", "交易过程"], ["/gmgn/", "GMGN"]]);
  for (const active of ["/crypto", "/crypto/desk", "/gmgn/"]) {
    const html = siteHeader(active);
    assert.match(html, new RegExp(`<details class="site-group is-current"><summary>数字货币</summary>[^]*<a href="${active}" aria-current="page">`), active);
    assert.equal(html.match(/site-group is-current/g)?.length, 1, active);
    assert.equal(html.match(/aria-current="page"/g)?.length, 1, active);
  }
});

test("Poly follow and Polymtrade open new tabs while internal navigation stays in this tab", () => {
  const html = siteHeader("/assets");
  assert.ok(html.includes('<a href="https://polyhermes.107-191-42-75.sslip.io/future-btc5m-bridge" class="site-external" target="_blank" rel="noopener noreferrer">Poly 跟单 ↗</a>'));
  assert.equal(html.match(/>Poly 跟单 ↗<\/a>/g)?.length, 1);
  assert.ok(html.includes('<a href="https://polym.trade/perps" class="site-external" target="_blank" rel="noopener noreferrer">Polymtrade ↗</a>'));
  assert.equal(html.match(/>Polymtrade ↗<\/a>/g)?.length, 1);
  assert.equal(html.match(/target="_blank"/g)?.length, 2);
  assert.match(html, /<a href="\/assets" aria-current="page">个人资产<\/a>/);
  assert.doesNotMatch(html, /<iframe|<script|onclick=|data-token|Authorization/i);
  assert.deepEqual([...html.matchAll(/aria-current="page">([^<]+)</g)].map(([, label]) => label), ["个人资产"]);
});

test("every dashboard page uses the shared shell with the right section highlighted", () => {
  const pages = [
    ["/dashboard", liveDashboardHtml()],
    ["/strategies", strategyLabHtml()],
    ["/reviews", tradeReviewHtml()],
    ["/fund-manager", fundManagerHtml({ date: null })],
    ["/fund-manager", weeklyResearchHtml({ report: null, history: [], lastCompleteId: null })],
    ["/crypto", btcRadarHtml({ nonce: "n" })]
  ];
  for (const [active, html] of pages) {
    assert.equal(html.match(/class="site-header"/g)?.length, 1, active);
    assert.ok(html.includes(SITE_CSS), active);
    assert.match(html, new RegExp(`<a href="${active}" aria-current="page">`), active);
    assert.equal(html.match(/aria-current="page"/g)?.length, 1, active);
  }
  const login = dashboardLoginHtml();
  assert.ok(login.includes(SITE_CSS));
  assert.match(login, /class="site-mark"[^>]*>H</);
  assert.match(login, /HQ Capital/);
  assert.match(login, /<title>登录 · HQ Capital</);
  assert.doesNotMatch(login, /Agentic Wallet/);
  assert.match(strategyLabHtml(), /<title>策略研究 · HQ Capital/);
});

test("shared pages expose settings without requiring the assets client, and retain page-owned actions", () => {
  for (const active of ["/market", "/crypto", "/dashboard", "/agentic-wallet/okx", "/fund-manager"]) {
    const html = siteHeader(active);
    assert.match(html, /class="site-group site-settings"/);
    assert.match(html, /<summary>设置<\/summary>/);
    assert.match(html, /href="\/assets\?settings=refresh-schedule"/);
    assert.match(html, /href="\/assets\?settings=statement-passwords"/);
    assert.match(html, /href="\/api\/theme\?set=dark&next=/);
    assert.doesNotMatch(html, /<script|onclick=|type="submit"/);
  }
  const owned = siteHeader("/assets", '<button id="asset-actions">资产操作</button>');
  assert.match(owned, /id="asset-actions"/);
  assert.doesNotMatch(owned, /site-settings/);
});
