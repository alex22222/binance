import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeOkxAgenticSnapshot } from "../src/okx-agentic-status.mjs";

const DIRECTORY = "/opt/binance-agentic-stock-bot/state/okx-agentic";
const MAX_BYTES = 65536;
const at = now => new Date(typeof now === "function" ? now() : now);
const failure = code => Object.assign(new Error("OKX 状态快照未保存。"), { code });

async function privateDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || info.uid !== process.getuid()) throw failure("UNSAFE_STATUS_DIRECTORY");
}

export async function writeStatusJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

export async function acquireStatusLock(directory) {
  await privateDirectory(directory);
  const path = join(directory, "bridge.lock"), owner = randomUUID();
  const readOwner = async () => {
    const value = JSON.parse(await readFile(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
    if (!Number.isInteger(value?.pid) || value.pid <= 0 || typeof value.owner !== "string") throw failure("BRIDGE_LOCK_INVALID");
    return value;
  };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
  const create = async () => {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, owner })); } finally { await handle.close(); }
    return { async release() {
      try { if ((await readOwner()).owner === owner) await unlink(path); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } };
  };
  try { return await create(); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (alive((await readOwner()).pid)) throw new Error("OKX status bridge already running");
  let recovery;
  try { recovery = await open(`${path}.recovery`, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw failure("BRIDGE_LOCK_RECOVERING"); throw error; }
  try {
    try { if (alive((await readOwner()).pid)) throw new Error("OKX status bridge already running"); await unlink(path); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return await create();
  } finally { await recovery.close(); await unlink(`${path}.recovery`); }
}

async function savedSnapshot(path, now) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES || info.mode & 0o077) throw failure("SAVED_STATUS_INVALID");
    const bytes = Buffer.alloc(MAX_BYTES + 1), result = await handle.read(bytes, 0, bytes.length, 0);
    if (!result.bytesRead || result.bytesRead > MAX_BYTES) throw failure("SAVED_STATUS_INVALID");
    return normalizeOkxAgenticSnapshot(JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8")), { now });
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  finally { await handle?.close(); }
}

export async function receiveOkxAgenticStatus(value, { directory = DIRECTORY, now = () => new Date() } = {}) {
  const checked = at(now);
  const snapshot = normalizeOkxAgenticSnapshot(value, { now: checked, maxExportAgeMs: 600000 });
  const encoded = JSON.stringify(snapshot);
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw failure("STATUS_TOO_LARGE");
  const lock = await acquireStatusLock(directory);
  try {
    const path = join(directory, "latest.json"), previous = await savedSnapshot(path, checked);
    if (previous && Date.parse(previous.exportedAt) > Date.parse(snapshot.exportedAt)) throw failure("OUT_OF_ORDER_EXPORT");
    await writeStatusJson(path, snapshot);
    return { status: "ACCEPTED", exportedAt: snapshot.exportedAt, savedAt: checked.toISOString() };
  } finally { await lock.release(); }
}

export async function receiveOkxAgenticInput(input, options) {
  let size = 0;
  const chunks = [];
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw failure("STATUS_TOO_LARGE");
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw failure("INVALID_STATUS_JSON"); }
  return receiveOkxAgenticStatus(value, options);
}

const entry = process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => null);
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    if (process.argv.length !== 2) throw failure("INVALID_ARGUMENTS");
    console.log(JSON.stringify(await receiveOkxAgenticInput(process.stdin)));
  } catch {
    console.error(JSON.stringify({ status: "REJECTED", code: "STATUS_NOT_SAVED" }));
    process.exitCode = 1;
  }
}
