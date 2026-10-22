import { realpathSync } from "node:fs";
import { register } from "node:module";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";

// Opt-in only on the Dashboard and radar services; never on the trading Bot.
// Keep the original src/ files and therefore its Live authorization hash intact.
if (process.env.BTC_RADAR_CODE_ROOT) {
  register("./btc-radar-hooks.mjs", import.meta.url, {
    data: {
      source: new URL("../src/", import.meta.url).href,
      release: new URL("src/", pathToFileURL(realpathSync(process.env.BTC_RADAR_CODE_ROOT) + sep)).href
    }
  });
}
