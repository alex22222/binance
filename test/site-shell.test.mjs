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

test("every dashboard page uses the shared shell with the right section highlighted", () => {
  const pages = [
    ["/", liveDashboardHtml()],
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
