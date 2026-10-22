import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { register } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const releaseRoot = "/opt/binance-agentic-authorization/current";
const dashboardPath = "/opt/binance-agentic-stock-bot/scripts/serve-live-dashboard.mjs";
const modules = ["dashboard-loader.mjs", "dashboard-hook.mjs", "public-status.mjs"];

// Flat root-owned release. No private authorization/config files are accessed.
export async function verifyDashboardRelease(directory = releaseRoot, { metadata = lstat } = {}) {
  const entry = await metadata(directory);
  if (entry.uid !== 0) throw new Error("Authorization Dashboard release entry must be root owned");
  if (!entry.isSymbolicLink() && (entry.mode & 0o022)) throw new Error("Unsafe authorization Dashboard release entry permissions");
  const root = await realpath(directory);
  async function checked(path, isDirectory = false) {
    const info = await metadata(path);
    if (info.uid !== 0) throw new Error("Authorization Dashboard release must be root owned");
    if (info.mode & 0o022) throw new Error("Unsafe authorization Dashboard release permissions");
    if (isDirectory ? !info.isDirectory() : !info.isFile()) throw new Error("Unsafe authorization Dashboard release file type");
  }
  await checked(root, true);
  const manifestPath = join(root, "release.json");
  await checked(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.dashboardSourceHash) ||
      !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Invalid authorization Dashboard release manifest");
  }
  for (const file of modules) {
    const expected = manifest.files[file];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Missing release manifest hash: ${file}`);
    const path = join(root, file);
    await checked(path);
    if (createHash("sha256").update(await readFile(path)).digest("hex") !== expected) {
      throw new Error(`Authorization Dashboard release hash mismatch: ${file}`);
    }
  }
  return { root, dashboardSourceHash: manifest.dashboardSourceHash,
    loaderURL: pathToFileURL(join(root, "dashboard-loader.mjs")).href,
    hookURL: pathToFileURL(join(root, "dashboard-hook.mjs")).href,
    publicStatusURL: pathToFileURL(join(root, "public-status.mjs")).href };
}

// Opt in with --import /opt/binance-agentic-authorization/current/dashboard-loader.mjs.
// Never activate on the Bot, a research runner or any other Dashboard file.
if (process.argv[1] && resolve(process.argv[1]) === dashboardPath) {
  const release = await verifyDashboardRelease();
  if (await realpath(fileURLToPath(import.meta.url)) !== fileURLToPath(release.loaderURL)) {
    throw new Error("Authorization Dashboard loader is not from the verified current release");
  }
  register(release.hookURL, { data: {
    dashboardURL: pathToFileURL(await realpath(dashboardPath)).href,
    dashboardSourceHash: release.dashboardSourceHash,
    publicStatusURL: release.publicStatusURL
  } });
}
