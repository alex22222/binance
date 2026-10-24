import { resolve } from "node:path";
import { runAssetSyncCycle } from "../src/personal-assets-sync.mjs";
import { getPersonalAssetRates } from "../src/personal-assets-fx.mjs";

try {
  const stateDir = resolve(process.env.PERSONAL_ASSETS_DIR || "state");
  const [result, fx] = await Promise.all([runAssetSyncCycle({ stateDir }), getPersonalAssetRates({ stateDir })]);
  // Counts only: no account IDs, assets, OAuth codes or credentials in journals.
  console.log(JSON.stringify({ task: "personal-assets-readonly-sync", ...result, fxStatus: fx.status }));
  if (result.failed || fx.status === "unavailable") process.exitCode = 1;
} catch {
  console.error("Personal asset read-only collector did not complete; check latest applied state and sync status.");
  process.exitCode = 1;
}
