// One list for the Dashboard release. stage.mjs, the loader, and the hook all import it.
export const hookModules = [
  "personal-assets-core.mjs", "personal-assets.mjs", "personal-assets-html.mjs", "personal-assets-client.mjs",
  "personal-assets-routes.mjs", "site-shell.mjs", "personal-assets-sync.mjs", "personal-assets-okx.mjs",
  "personal-assets-futu.mjs", "personal-assets-fx.mjs", "personal-assets-polymarket.mjs", "personal-assets-wallets.mjs",
  "personal-assets-ai.mjs", "personal-assets-funds.mjs", "crypto-watch.mjs", "crypto-watch-html.mjs", "crypto-news.mjs",
  "market-overview.mjs", "market-overview-html.mjs", "digital-currency-html.mjs", "okx-agentic-status.mjs",
  "okx-agentic-html.mjs", "agentic-wallet-overview.mjs", "agentic-wallet-html.mjs", "agentic-wallet-client.mjs",
  "strategy-research.mjs", "strategy-lab-html.mjs", "strategy-daily.mjs", "fund-manager-html.mjs",
  "okx-desk-ledger.mjs", "okx-desk-html.mjs", "personal-assets-history.mjs"
];

export const releaseFiles = [
  "dashboard-loader.mjs", "dashboard-hooks.mjs", "dashboard-release-files.mjs",
  ...hookModules.map((name) => `src/${name}`)
];

export const supportingFiles = [
  "README.md", "docs/personal-assets-page.md",
  "scripts/sync-personal-assets.mjs", "scripts/snapshot-personal-assets.mjs",
  "deploy/binance-personal-assets-sync.service", "deploy/binance-personal-assets-sync.timer",
  "deploy/binance-personal-assets-daily-snapshot.service", "deploy/binance-personal-assets-daily-snapshot.timer",
  "scripts/run-crypto-watch.mjs", "deploy/binance-agentic-crypto-watch.service", "deploy/binance-agentic-crypto-watch.timer",
  "docs/2026-10-31-crypto-watch.md", "docs/2026-11-08-market-landing.md",
  "scripts/run-market-overview.mjs", "deploy/binance-agentic-market-overview.service", "deploy/binance-agentic-market-overview.timer",
  "scripts/sync-okx-agentic-status.mjs", "scripts/receive-okx-agentic-status.mjs", "docs/2026-11-09-navigation-crypto-wallet.md",
  "docs/2026-11-11-agentic-wallet-overview.md", "test/agentic-wallet-overview.test.mjs", "test/agentic-wallet-client.test.mjs", "test/agentic-wallet-server.test.mjs",
  "scripts/record-strategy-daily.mjs", "deploy/binance-agentic-strategy-daily.service", "deploy/binance-agentic-strategy-daily.timer",
  "docs/2026-11-11-strategy-daily-journal.md", "test/strategy-daily.test.mjs", "test/strategy-research.test.mjs", "test/strategy-lab-html.test.mjs", "test/fund-manager-html.test.mjs",
  "fixtures/okx-desk/shadow-log.sample.md"
];
