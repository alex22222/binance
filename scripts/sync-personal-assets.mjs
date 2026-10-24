import { resolve } from "node:path";
import { runAssetSyncCycle } from "../src/personal-assets-sync.mjs";
import { getPersonalAssetRates } from "../src/personal-assets-fx.mjs";
import { runAssetFundCycle } from "../src/personal-assets-funds.mjs";

try {
  const stateDir = resolve(process.env.PERSONAL_ASSETS_DIR || "state");
  // Independent source failures must not prevent the other account collectors.
  const funds = await runAssetFundCycle({ stateDir }).catch(() => ({ attempted: 0, applied: 0, failed: 1 }));
  const [result, fx] = await Promise.all([runAssetSyncCycle({ stateDir }), getPersonalAssetRates({ stateDir })]);
  // Counts only: no account IDs, assets, OAuth codes or credentials in journals.
  console.log(JSON.stringify({ task: "personal-assets-readonly-sync", ...result, funds, fxStatus: fx.status }));
  if (result.failed || funds.failed || fx.status === "unavailable") process.exitCode = 1;
} catch {
  console.error("Personal asset read-only collector did not complete; check latest applied state and sync status.");
  process.exitCode = 1;
}
