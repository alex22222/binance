import { resolve } from "node:path";
import { runAssetSyncCycle } from "../src/personal-assets-sync.mjs";
import { getPersonalAssetRates } from "../src/personal-assets-fx.mjs";
import { runAssetFundCycle } from "../src/personal-assets-funds.mjs";
import { claimAssetRefresh, completeAssetRefresh } from "../src/personal-assets.mjs";
import { runDailyPersonalAssetsSnapshot } from "./snapshot-personal-assets.mjs";

const stateDir = resolve(process.env.PERSONAL_ASSETS_DIR || "state");
let claim;
try {
  claim = await claimAssetRefresh({ stateDir });
  if (!claim) {
    console.log(JSON.stringify({ task: "personal-assets-readonly-sync", skipped: true }));
  } else {
    // Independent source failures must not prevent the other account collectors.
    const funds = await runAssetFundCycle({ stateDir }).catch(() => ({ attempted: 0, applied: 0, failed: 1 }));
    const [result, fx] = await Promise.all([runAssetSyncCycle({ stateDir }), getPersonalAssetRates({ stateDir })]);
    // Counts only: no account IDs, assets, OAuth codes or credentials in journals.
    const failed = Boolean(result.failed || funds.failed || fx.status === "unavailable");
    await completeAssetRefresh({ stateDir, attemptedAt: claim.attemptedAt, failed });
    const history = await runDailyPersonalAssetsSnapshot({ stateDir, phase: "refresh" }).catch(() => {
      process.exitCode = 1;
      return { status: "history-save-failed", saved: false };
    });
    console.log(JSON.stringify({ task: "personal-assets-readonly-sync", ...result, funds, fxStatus: fx.status, history }));
    if (failed) process.exitCode = 1;
  }
} catch {
  if (claim) await completeAssetRefresh({ stateDir, attemptedAt: claim.attemptedAt, failed: true }).catch(() => {});
  if (claim) await runDailyPersonalAssetsSnapshot({ stateDir, phase: "refresh" }).catch(() => {
    console.error("Asset refresh history could not be saved; check private history storage.");
  });
  console.error("Personal asset read-only collector did not complete; check latest applied state and sync status.");
  process.exitCode = 1;
}
