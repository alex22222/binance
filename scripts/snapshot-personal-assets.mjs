import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readPersonalAssets, createPersonalAssetsSnapshot } from "../src/personal-assets.mjs";
import { valuePersonalAssetState } from "../src/personal-assets-fx.mjs";
import { readAssetSyncStatus } from "../src/personal-assets-sync.mjs";

export async function runDailyPersonalAssetsSnapshot({ stateDir, now = new Date(), valueState = valuePersonalAssetState }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await readPersonalAssets({ stateDir });
    if (!current.portfolio.entries.length) return { status: "no-recorded-assets", saved: false };
    const valued = await valueState(current, { stateDir });
    const sync = await readAssetSyncStatus({ stateDir }).catch(() => ({ status: "unavailable", providers: {} }));
    const sourceCoverage = { status: sync.status || "available", providers: Object.fromEntries(Object.entries(sync.providers).map(([name, value]) => [name,
      Object.fromEntries(["connected", "enabled", "targetAccountId", "lastFetchedAt", "lastAppliedAt", "observedAt", "lastError", "overdue", "lastCoverage", "lastWarnings", "lastUnpricedAssets", "lastValuationComplete"].filter(key => value[key] !== undefined).map(key => [key, value[key]]))])) };
    try {
      const result = await createPersonalAssetsSnapshot({ stateDir, revision: current.revision, daily: true, now, sourceCoverage,
        valuation: { rates: valued.portfolio.rates, fx: valued.fx } });
      return { status: "daily-snapshot-verified", saved: result.snapshots.length > current.snapshots.length, snapshots: result.snapshots.length, fxStatus: valued.fx.status };
    } catch (error) { if (error.statusCode !== 409 || attempt === 1) throw error; }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runDailyPersonalAssetsSnapshot({ stateDir: resolve(process.env.PERSONAL_ASSETS_DIR || "state") });
    console.log(JSON.stringify({ task: "personal-assets-daily-snapshot", ...result }));
  } catch {
    console.error("Daily asset snapshot did not complete; existing asset records and snapshots are retained.");
    process.exitCode = 1;
  }
}
