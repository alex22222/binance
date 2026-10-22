import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const hash = value => createHash("sha256").update(value).digest("hex");

export function researchModuleDependencies(source, file) {
  const imports = [
    ...source.matchAll(/\bimport\s+(?:[^;"']*?\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)
  ];
  return [...new Set(imports.map(([, specifier]) => {
    if (specifier.startsWith("node:")) return null;
    if (!specifier.startsWith(".")) throw new Error(`Unsupported research dependency: ${specifier}`);
    const target = relative("/release", resolve("/release", dirname(file), specifier));
    if (target.startsWith("..") || !target.endsWith(".mjs")) throw new Error(`Research dependency escape: ${specifier}`);
    return target;
  }).filter(Boolean))];
}

export async function verifyResearchRelease(directory = resolve(import.meta.dirname, "..")) {
  const root = await realpath(directory);
  const manifest = JSON.parse(await readFile(resolve(root, "release.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !["ETF_FREQUENCY_PAPER", "STRATEGY_VALIDATION"].includes(manifest.kind) || !manifest.sources?.[manifest.entry]) {
    throw new Error("Invalid research release manifest");
  }
  const owner = (await stat(root)).uid;
  const manifestInfo = await stat(resolve(root, "release.json"));
  if (manifestInfo.uid !== owner || (manifestInfo.mode & 0o022)) throw new Error("Unsafe research manifest permissions");
  const sources = {};
  for (const [file, expected] of Object.entries(manifest.sources)) {
    if (!/^(src|scripts)\/[a-zA-Z0-9-]+\.mjs$/.test(file)) throw new Error(`Invalid research module path: ${file}`);
    const path = await realpath(resolve(root, file));
    if (!path.startsWith(root + sep)) throw new Error(`Research module escape: ${file}`);
    const info = await stat(path);
    if (info.uid !== owner || (info.mode & 0o022)) throw new Error(`Unsafe research module permissions: ${file}`);
    const source = await readFile(path, "utf8");
    if (hash(source) !== expected) throw new Error(`Research release hash mismatch: ${file}`);
    sources[file] = source;
    for (const dependency of researchModuleDependencies(source, file)) {
      if (!manifest.sources[dependency]) throw new Error(`Research dependency not frozen: ${dependency}`);
    }
  }
  if (manifest.kind === "ETF_FREQUENCY_PAPER") {
    const files = JSON.parse(sources[manifest.entry].match(/const codeFiles = (\[[^;]+\]);/)[1]);
    const actual = hash(JSON.stringify(files.map(file => [file, hash(sources[file])])));
    if (actual !== manifest.paperCodeHash) throw new Error("Frozen Paper code identity mismatch");
  }
  return { kind: manifest.kind, directory: root, modules: Object.keys(sources).length, paperCodeHash: manifest.paperCodeHash ?? null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await verifyResearchRelease()));
}
