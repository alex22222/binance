import assert from "node:assert/strict";
import test from "node:test";
import { btcRadarHtml } from "../src/btc-radar-html.mjs";
import { dashboardLoginHtml } from "../src/dashboard-login-html.mjs";
import { fundManagerHtml } from "../src/fund-manager-html.mjs";
import { liveDashboardHtml } from "../src/live-dashboard-html.mjs";
import { SITE_CSS, SITE_NAV, siteHeader } from "../src/site-shell.mjs";
import { strategyLabHtml } from "../src/strategy-lab-html.mjs";
import { tradeReviewHtml } from "../src/trade-review-html.mjs";
import { weeklyResearchHtml } from "../src/weekly-research-html.mjs";

test("the shared header marks only the active page and needs no image", () => {
  const html = siteHeader("/btc-radar", '<span id="slot">x</span>');
  assert.deepEqual([...html.matchAll(/<a href="([^"]+)"/g)].map(([, href]) => href), SITE_NAV.map(([href]) => href));
  assert.deepEqual([...html.matchAll(/aria-current="page">([^<]+)</g)].map(([, label]) => label), ["BTC 风控"]);
  assert.match(html, /<div class="site-actions"><span id="slot">x<\/span><\/div>/);
  assert.doesNotMatch(siteHeader("/"), /site-actions/);
  assert.doesNotMatch(html + SITE_CSS, /<img|url\(/);
});

test("light is the default theme, dark stays behind data-theme, and dark-era page colors are fixed per page", () => {
  assert.match(SITE_CSS, /:root\{color-scheme:light;/);
  assert.match(SITE_CSS, /:root\[data-theme=dark\]\{color-scheme:dark;/);
  const fixes = SITE_CSS.split("\n").filter((line) => line.includes("body:has("));
  assert.ok(fixes.length > 20);
  for (const line of fixes) {
    assert.match(line, /^html:not\(\[data-theme=dark\]\) body:has\((\.site-nav a\[aria-current\]\[href="(\/dashboard|\/strategies|\/fund-manager|\/btc-radar)"\]|form\[action="\/login"\])\)/, line);
  }
});

test("navigation leads with personal assets and moves the Binance wallet to /dashboard", () => {
  for (const active of ["/", "/dashboard"]) {
    const html = siteHeader(active);
    const links = [...html.matchAll(/<a href="([^"]+)"(?: aria-current="page")?>([^<]+)<\/a>/g)]
      .map(([, href, label]) => [href, label]);
    assert.deepEqual(links.slice(0, 2), [["/assets", "个人资产"], ["/dashboard", "币安Agent Wallet"]], active);
    assert.match(html, /<a href="\/dashboard" aria-current="page">币安Agent Wallet<\/a>/, active);
    assert.equal(html.match(/aria-current="page"/g)?.length, 1, active);
  }
  const html = siteHeader("/assets");
  assert.match(html, /<a class="site-brand" href="\/"><span class="site-mark" aria-hidden="true">H<\/span><span class="site-name">HQ Capital<\/span><\/a>/);
  assert.doesNotMatch(html, /Agentic Wallet<\/span>/);
});

test("polymarket is a plain external navigation link, not an embedded or authenticated integration", () => {
  const html = siteHeader("/assets");
  assert.ok(html.includes('<a href="https://polyhermes.107-191-42-75.sslip.io/future-btc5m-bridge">polymarket</a>'));
  assert.equal(html.match(/>polymarket<\/a>/g)?.length, 1);
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
    ["/btc-radar", btcRadarHtml({ nonce: "n" })]
  ];
  for (const [active, html] of pages) {
    assert.equal(html.match(/class="site-header"/g)?.length, 1, active);
    assert.ok(html.includes(SITE_CSS), active);
    assert.match(html, new RegExp(`<a href="${active}" aria-current="page">`), active);
    assert.equal(html.match(/aria-current="page"/g)?.length, 1, active);
  }
  const login = dashboardLoginHtml();
  assert.ok(login.includes(SITE_CSS));
  assert.match(login, /class="site-mark"/);
});
