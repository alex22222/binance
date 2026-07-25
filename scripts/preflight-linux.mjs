import { access, constants, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dashboardAuthConfig } from "../src/dashboard-auth.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const errors = [];
const warnings = [];
const environmentFileArgument = process.argv.find((argument) => argument.startsWith("--environment-file="));

if (environmentFileArgument) {
  const environmentFile = environmentFileArgument.slice("--environment-file=".length);
  const source = await readFile(environmentFile, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid environment line: ${line}`);
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

if (process.platform !== "linux") warnings.push(`Platform is ${process.platform}; production target is linux`);

for (const name of [
  "BINANCE_INSTANCE_ID",
  "BAW_CLI_PATH",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_RECEIVE_ID",
  "DASHBOARD_USERNAME",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_PUBLIC_ORIGIN"
]) {
  const value = process.env[name]?.trim() || "";
  if (!value) {
    errors.push(`${name} is missing`);
  } else if (/replace-me|replace-with|example\.com/i.test(value)) {
    errors.push(`${name} still contains an example placeholder`);
  }
}

try {
  dashboardAuthConfig();
} catch (error) {
  errors.push(error.message);
}

for (const origin of String(process.env.DASHBOARD_PUBLIC_ORIGIN || "").split(",")) {
  if (origin.trim() && !origin.trim().startsWith("https://")) {
    errors.push("Every DASHBOARD_PUBLIC_ORIGIN must use HTTPS");
  }
}

if (process.env.DASHBOARD_PASSWORD && process.env.DASHBOARD_PASSWORD.length < 16) {
  errors.push("DASHBOARD_PASSWORD must be at least 16 characters");
}

for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
  if (process.env[name]?.trim()) warnings.push(`${name} is configured; direct server mode does not require it`);
}

try {
  await access(process.env.BAW_CLI_PATH || "", constants.X_OK);
} catch {
  errors.push(`BAW_CLI_PATH is not executable: ${process.env.BAW_CLI_PATH || "(missing)"}`);
}

try {
  const config = JSON.parse(await readFile(resolve(projectRoot, process.env.BOT_CONFIG || "config.json"), "utf8"));
  if (config.mode === "live") {
    warnings.push("config.json is live; keep the systemd BOT_LIVE gate at 0 until an explicit cutover");
  }
} catch (error) {
  errors.push(`Bot config cannot be read: ${error.message}`);
}

console.log(JSON.stringify({
  success: errors.length === 0,
  errors,
  warnings
}, null, 2));
process.exitCode = errors.length ? 1 : 0;
