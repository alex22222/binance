import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { register } from "node:module";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dashboardPath = "/opt/binance-agentic-stock-bot/scripts/serve-live-dashboard.mjs";
const releaseFiles = [
  "dashboard-loader.mjs", "dashboard-hooks.mjs",
  "src/personal-assets-core.mjs", "src/personal-assets.mjs", "src/personal-assets-html.mjs",
  "src/personal-assets-client.mjs", "src/personal-assets-routes.mjs", "src/site-shell.mjs",
  "src/personal-assets-sync.mjs", "src/personal-assets-okx.mjs", "src/personal-assets-futu.mjs", "src/personal-assets-fx.mjs", "src/personal-assets-polymarket.mjs", "src/personal-assets-wallets.mjs", "src/personal-assets-ai.mjs", "src/personal-assets-funds.mjs"
];

export async function verifyPersonalAssetsRelease(directory, { metadata = lstat } = {}) {
  const entry = await metadata(directory);
  if (entry.uid !== 0) throw new Error("Personal assets release entry must be root owned");
  if (!entry.isSymbolicLink() && (entry.mode & 0o022)) throw new Error("Unsafe personal assets release entry permissions");
  const root = await realpath(directory);
  async function checked(path, isDirectory = false) {
    const info = await metadata(path);
    if (info.uid !== 0) throw new Error("Personal assets release must be root owned");
    if (info.mode & 0o022) throw new Error("Unsafe personal assets release permissions");
    if (isDirectory ? !info.isDirectory() : !info.isFile()) throw new Error("Unsafe personal assets release file type");
  }
  await checked(root, true);
  await checked(join(root, "src"), true);
  const manifestPath = join(root, "manifest.json");
  await checked(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Invalid personal assets release manifest");
  }
  for (const name of releaseFiles) {
    const expected = manifest.files[name];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Missing personal assets release manifest hash: ${name}`);
    const path = join(root, name);
    await checked(path);
    if (createHash("sha256").update(await readFile(path)).digest("hex") !== expected) throw new Error(`Personal assets release hash mismatch: ${name}`);
  }
  return {
    root,
    loaderURL: pathToFileURL(join(root, "dashboard-loader.mjs")).href,
    hookURL: pathToFileURL(join(root, "dashboard-hooks.mjs")).href,
    source: pathToFileURL("/opt/binance-agentic-stock-bot/src/").href,
    release: pathToFileURL(join(root, "src") + sep).href
  };
}

// Opt in only for this exact Dashboard entry. The trading Bot never registers it.
if (process.env.PERSONAL_ASSETS_CODE_ROOT && process.argv[1] === dashboardPath) {
  const verified = await verifyPersonalAssetsRelease(process.env.PERSONAL_ASSETS_CODE_ROOT);
  if (await realpath(fileURLToPath(import.meta.url)) !== fileURLToPath(verified.loaderURL)) {
    throw new Error("Personal assets loader is not from the verified release");
  }
  register(verified.hookURL, { data: { source: verified.source, release: verified.release } });
}
