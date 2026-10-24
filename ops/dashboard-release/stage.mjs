import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const modules = ["dashboard-loader.mjs", "dashboard-hooks.mjs", "src/personal-assets-client.mjs",
  "src/personal-assets-core.mjs", "src/personal-assets-html.mjs", "src/personal-assets-routes.mjs",
  "src/personal-assets.mjs", "src/site-shell.mjs", "src/personal-assets-sync.mjs",
  "src/personal-assets-okx.mjs", "src/personal-assets-futu.mjs", "src/personal-assets-fx.mjs",
  "src/personal-assets-polymarket.mjs", "src/personal-assets-wallets.mjs",
  "src/personal-assets-ai.mjs", "src/personal-assets-funds.mjs"];
// Templates and collector entries are archived in the isolated release only;
// this tool never installs systemd units or runs these scripts.
const supportingFiles = ["README.md", "docs/personal-assets-page.md",
  "scripts/sync-personal-assets.mjs", "scripts/snapshot-personal-assets.mjs",
  "deploy/binance-personal-assets-sync.service", "deploy/binance-personal-assets-sync.timer",
  "deploy/binance-personal-assets-daily-snapshot.service", "deploy/binance-personal-assets-daily-snapshot.timer"];
const hash = value => createHash("sha256").update(value).digest("hex");
const inside = (root, path) => path === root || path.startsWith(root + sep);

// Deliberately byte-compatible with the original all-src identity. Do not
// exclude UI-looking names: a trading module can import any new src module.
export async function sourceIdentity(projectRoot) {
  const root = join(projectRoot, "src");
  const names = (await readdir(root)).filter(name => !name.startsWith(".") && name.endsWith(".mjs")).sort();
  return hash(JSON.stringify(await Promise.all(names.map(async name => [name, hash(await readFile(join(root, name)))]))));
}

function allowedFile(file) {
  return typeof file === "string" && !file.split("/").some(part => !part || part === "." || part === "..") &&
    /^[a-zA-Z0-9._/-]+$/.test(file) && (modules.includes(file) ||
      /^assets\/personal-assets\/ocr\/[a-zA-Z0-9._/-]+$/.test(file) ||
      /^test\/personal-assets[a-zA-Z0-9.-]*\.test\.mjs$/.test(file) || supportingFiles.includes(file));
}

async function safeRead(root, file) {
  let path = root;
  const parts = file.split("/");
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`Unsafe payload file type or symlink: ${file}`);
    }
    if (info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error(`Unsafe payload ownership or permissions: ${file}`);
  }
  return readFile(path);
}

async function destinationOutside(projectRoot, destination) {
  let ancestor = destination;
  for (;;) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) throw new Error("Destination symlink is not a release directory");
      if (!info.isDirectory()) throw new Error("Destination ancestor is not a directory");
      const physical = resolve(await realpath(ancestor), relative(ancestor, destination));
      if (inside(projectRoot, physical)) throw new Error("Dashboard release must remain outside the protected production checkout");
      if (info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error("Unsafe release parent permissions");
      return physical;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
}

// Stage only: never restart a service, switch current, rewrite the Dashboard
// entry, or touch grants/policy/config/state. Activation is separately reviewed.
export async function stageDashboardRelease({ source, destination, projectRoot, expectedCodeHash, checkOnly = false }) {
  const protectedRoot = await realpath(projectRoot);
  const target = await destinationOutside(protectedRoot, resolve(destination));
  const sourceRoot = await realpath(source);
  if (inside(protectedRoot, sourceRoot) || inside(sourceRoot, target) || inside(target, sourceRoot)) {
    throw new Error("Payload and destination must be outside protected production and separate from each other");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedCodeHash) || await sourceIdentity(protectedRoot) !== expectedCodeHash) {
    throw new Error("Trading source identity changed; UI publication cannot accept or rebind it");
  }
  const rootInfo = await lstat(sourceRoot);
  if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid() || (rootInfo.mode & 0o022)) throw new Error("Unsafe payload root");
  const manifestBytes = await safeRead(sourceRoot, "manifest.json");
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== "object") {
    throw new Error("Invalid Dashboard payload manifest");
  }
  if (modules.some(file => !manifest.files[file])) throw new Error("Missing required Dashboard payload module");
  const files = [];
  // Validate the entire manifest and freeze bytes before the first write.
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (!allowedFile(file) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Disallowed Dashboard payload path or module: ${file}`);
    const bytes = await safeRead(sourceRoot, file);
    if (hash(bytes) !== expected) throw new Error(`Dashboard payload hash mismatch: ${file}`);
    files.push([file, bytes]);
  }
  try {
    await lstat(target);
    throw new Error("Dashboard release already exists; immutable releases are never overwritten");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (await sourceIdentity(protectedRoot) !== expectedCodeHash) throw new Error("Trading source identity changed during preflight");
  if (checkOnly) return { checked: true, files: files.length, destination: target, liveCodeHash: expectedCodeHash };
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  if (await destinationOutside(protectedRoot, target) !== target) throw new Error("Destination changed during preflight");
  // Exclusive reservation also rejects a competing publisher's empty release.
  // Write the manifest last; an interrupted stage is preserved, not activated.
  await mkdir(target, { mode: 0o755 });
  for (const [file, bytes] of [...files, ["manifest.json", manifestBytes]]) {
    const output = join(target, file);
    await mkdir(dirname(output), { recursive: true, mode: 0o755 });
    await writeFile(output, bytes, { mode: 0o644, flag: "wx" });
    if (hash(await readFile(output)) !== hash(bytes)) throw new Error(`Staged Dashboard hash mismatch: ${file}`);
  }
  if (await sourceIdentity(protectedRoot) !== expectedCodeHash) throw new Error("Trading source identity changed while staging; activation refused");
  return { staged: true, files: files.length, destination: target, liveCodeHash: expectedCodeHash };
}

const entry = process.argv[1] && await realpath(resolve(process.argv[1])).catch(error => {
  if (error.code === "ENOENT") return null; // stdin or an imported evaluation, not a script entry
  throw error;
});
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const [mode, source, id] = process.argv.slice(2);
  if (process.getuid() !== 0 || !["check", "stage"].includes(mode) || !source || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,95}$/.test(id || "")) {
    throw new Error("Use as root: node stage.mjs <check|stage> <prepared-payload-directory> <new-release-id>");
  }
  const manifest = JSON.parse(await readFile("/opt/binance-agentic-authorization/current/release.json", "utf8"));
  console.log(JSON.stringify(await stageDashboardRelease({ source,
    destination: join("/opt/binance-agentic-personal-assets/releases", id),
    projectRoot: "/opt/binance-agentic-stock-bot", expectedCodeHash: manifest.liveCodeHash, checkOnly: mode === "check" })));
}
