import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBtcRadar } from "../src/btc-radar.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = resolve(projectRoot, process.env.BTC_RADAR_DIR || "state/btc-radar");

const { snapshot, alert, trendAlert } = await runBtcRadar({ directory });
console.log(JSON.stringify({
  time: new Date().toISOString(),
  ts: snapshot.ts,
  score: snapshot.score,
  level: snapshot.level,
  price: snapshot.price,
  position: snapshot.position ? snapshot.position.level : null,
  okxConfigured: snapshot.data_status.okxConfigured,
  staleSources: snapshot.data_status.staleSources.map(({ key }) => key),
  alert: alert.status,
  reasons: alert.reasons,
  ...(alert.error ? { alertError: alert.error } : {}),
  trend: snapshot.trend?.state ?? null,
  trendAlert: trendAlert.status,
  ...(trendAlert.error ? { trendAlertError: trendAlert.error } : {})
}));
if (alert.status === "FAILED" || trendAlert.status === "FAILED") process.exitCode = 1;
