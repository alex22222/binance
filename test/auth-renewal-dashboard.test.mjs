import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { publicStatus, readPublicStatus, withAuthorizationBanner } from "../ops/auth-renewal/public-status.mjs";
import { initialize, load, transformDashboardSource } from "../ops/auth-renewal/dashboard-hook.mjs";
import { verifyDashboardRelease } from "../ops/auth-renewal/dashboard-loader.mjs";

const NOW = Date.parse("2026-10-22T04:00:00.000Z");
const DAY = 86_400_000;
const ID = "weekly-etf-dual-momentum-defense";
const iso = value => new Date(value).toISOString();
const hash = source => createHash("sha256").update(source).digest("hex");
const target = new URL("../scripts/serve-live-dashboard.mjs", import.meta.url);
const files = ["dashboard-loader.mjs", "dashboard-hook.mjs", "public-status.mjs"];
const guard = "    if (!requireAuthentication(request, response)) return;";
const home = "      response.end(liveDashboardHtml());";
const moduleURL = new URL("../ops/auth-renewal/public-status.mjs", import.meta.url).href;
function raw(changes = {}) {
  return { schemaVersion: 1, checkedAt: iso(NOW), strategyId: ID,
    authorizationAllowed: true, entryControlsOpen: true, leaseExpiresAt: iso(NOW + 7 * DAY),
    hardDeadline: iso(NOW + 30 * DAY), autoRenewalState: "ACTIVE", reason: "VALID", generation: 1, ...changes };
}
const status = changes => publicStatus(raw(changes), { nowMs: NOW });
async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "auth-dashboard-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("fresh status, 48-hour boundary and HALTED lease have distinct authorization-only labels", () => {
  assert.equal(status().tone, "green");
  assert.equal(status().label, "可买入(仅授权)");
  assert.equal(status({ leaseExpiresAt: iso(NOW + 2 * DAY) }).label, "即将到期(剩余48h)");
  assert.equal(status({ leaseExpiresAt: iso(NOW + 2 * DAY + 1) }).tone, "green");
  assert.equal(status({ hardDeadline: iso(NOW + 2 * DAY) }).tone, "amber");
  const halted = status({ autoRenewalState: "HALTED" });
  assert.equal(halted.tone, "amber");
  assert.equal(halted.authorizationAllowed, true);
  assert.match(halted.renewalNotice, /续签已停止/);
  assert.equal(status({ checkedAt: iso(NOW - 180_000) }).tone, "green");
});

test("missing/stale/future/failed reads and malformed schema never retain green", async t => {
  for (const input of [null, {}, raw({ checkedAt: iso(NOW - 180_001) }), raw({ checkedAt: iso(NOW + 1) })]) {
    assert.equal(publicStatus(input, { nowMs: NOW }).label, "未核实");
  }
  const path = join(await temporary(t), "public-status.json");
  assert.equal((await readPublicStatus({ path, nowMs: NOW })).label, "未核实");
  await writeFile(path, JSON.stringify(raw()));
  assert.equal((await readPublicStatus({ path, nowMs: NOW })).tone, "green");
  const failed = await readPublicStatus({ path, nowMs: NOW, read: async () => { throw Error("PRIVATE_PATH_AND_TOKEN"); } });
  assert.equal(failed.label, "未核实");
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/);
  await writeFile(path, "bad JSON");
  assert.equal((await readPublicStatus({ path, nowMs: NOW })).label, "未核实");
  for (const changes of [
    { schemaVersion: "1" }, { strategyId: "other" }, { strategyId: ID + "\n" },
    { authorizationAllowed: "true" }, { entryControlsOpen: 1 }, { generation: -1 }, { generation: 1.1 },
    { generation: Number.MAX_SAFE_INTEGER + 1 }, { autoRenewalState: "RUNNING" },
    { checkedAt: "2026-02-30T04:00:00Z" }, { leaseExpiresAt: "2026-10-30" },
    { hardDeadline: "2026-11-30T24:00:00Z" }, { checkedAt: "2026-10-22T04:00:00" },
    { checkedAt: "2026-10-22T18:00:00+14:60" }, { reason: { private: "TOKEN" } }
  ]) assert.equal(status(changes).label, "未核实", JSON.stringify(changes));
  assert.equal(status({ checkedAt: "2026-10-22T12:00:00+08:00" }).tone, "green");
});

test("local clock reaching either deadline blocks even when raw booleans still claim allowed", () => {
  for (const key of ["leaseExpiresAt", "hardDeadline"]) {
    for (const time of [NOW - 1, NOW]) {
      const result = status({ [key]: iso(time) });
      assert.equal(result.label, "已阻断");
      assert.equal(result.authorizationAllowed, false);
      assert.notEqual(result.tone, "green");
    }
  }
  for (const changes of [{ authorizationAllowed: false }, { entryControlsOpen: false }, { autoRenewalState: "EXPIRED" }]) {
    assert.equal(status(changes).label, "已阻断");
  }
  assert.equal(status({ autoRenewalState: "ERROR" }).label, "未核实");
  const entriesClosed = status({ entryControlsOpen: false });
  assert.equal(entriesClosed.label, "已阻断");
  assert.equal(entriesClosed.authorizationAllowed, true, "closing entry controls must not rewrite the separate authorization gate");
  assert.equal(entriesClosed.entryControlsOpen, false);
});

test("slow public-file reads evaluate freshness and lease expiry at read completion, not request start", async () => {
  const originalNow = Date.now;
  try {
    Date.now = () => NOW;
    const result = await readPublicStatus({ read: async () => {
      Date.now = () => NOW + 2;
      return JSON.stringify(raw({ leaseExpiresAt: iso(NOW + 1) }));
    } });
    assert.equal(result.label, "已阻断");
    Date.now = () => NOW;
    const stale = await readPublicStatus({ read: async () => {
      Date.now = () => NOW + 180_001;
      return JSON.stringify(raw());
    } });
    assert.equal(stale.label, "未核实");
  } finally {
    Date.now = originalNow;
  }
});

test("public result has an exact whitelist; nested private fields and errors cannot escape", () => {
  const result = status({ token: "SECRET", identity: { privateKey: "SECRET" }, authorizations: ["SECRET"] });
  assert.deepEqual(Object.keys(result).sort(), ["schemaVersion", "checkedAt", "strategyId", "authorizationAllowed",
    "entryControlsOpen", "leaseExpiresAt", "hardDeadline", "autoRenewalState", "reason", "generation",
    "label", "tone", "renewalNotice"].sort());
  assert.doesNotMatch(JSON.stringify(result), /SECRET|privateKey|authorizations/);
  assert.doesNotMatch(JSON.stringify(status({ reason: "/root/private SECRET" })), /SECRET|\/root/);
});

test("hook verifies exact source hash and makes only two single replacements after unchanged auth", async () => {
  const source = await readFile(target, "utf8");
  const transformed = transformDashboardSource(source, { dashboardSourceHash: hash(source), publicStatusURL: moduleURL });
  assert.equal(transformed.slice(0, source.indexOf(guard) + guard.length), source.slice(0, source.indexOf(guard) + guard.length));
  assert.equal(transformed.match(/\/api\/buy-authorization-status/g).length, 1);
  assert.equal(transformed.match(/withAuthorizationBanner\(liveDashboardHtml\(\)\)/g).length, 1);
  const tail = source.slice(source.indexOf(home) + home.length);
  assert.ok(transformed.endsWith(tail));
  assert.throws(() => transformDashboardSource(source + "\n", { dashboardSourceHash: hash(source), publicStatusURL: moduleURL }), /hash/i);
  for (const broken of [source.replace(guard, ""), source.replace(home, ""), source + guard, source + home]) {
    assert.throws(() => transformDashboardSource(broken, { dashboardSourceHash: hash(broken), publicStatusURL: moduleURL }), /once|anchor/i);
  }
  initialize({ dashboardURL: target.href, dashboardSourceHash: hash(source), publicStatusURL: moduleURL });
  const untouched = { format: "module", source: "export const other = true;" };
  assert.equal(await load(new URL("../src/dashboard-auth.mjs", import.meta.url).href, {}, async () => untouched), untouched);
  assert.equal(await load(target.href + "?other", {}, async () => untouched), untouched);
  const loaded = await load(target.href, {}, async () => ({ format: "module", source: Buffer.from(source) }));
  assert.equal(String(loaded.source), transformed);
});

test("the existing home wrapper leaves the page unchanged without a permission banner or polling", () => {
  for (const source of ["<html><body><main>Home</main></body></html>", '<body class="dashboard"><header>Menu</header></body>']) {
    const html = withAuthorizationBanner(source);
    assert.equal(html, source);
    assert.doesNotMatch(html, /buy-authorization-banner|买入权限|<script|\/api\/buy-authorization-status|setInterval/);
  }
});

test("release validation requires root ownership, safe modes, self/hook/status hashes and pinned manifest", async t => {
  const root = await temporary(t);
  for (const file of files) await copyFile(new URL(`../ops/auth-renewal/${file}`, import.meta.url), join(root, file));
  const manifest = { schemaVersion: 1, dashboardSourceHash: hash(await readFile(target)), files: {} };
  for (const file of files) manifest.files[file] = hash(await readFile(join(root, file)));
  await writeFile(join(root, "release.json"), JSON.stringify(manifest));
  // Unit-test root metadata without chown, sudo, or touching /opt. Production uses real lstat.
  const metadata = async path => Object.assign(await lstat(path), { uid: 0 });
  const valid = await verifyDashboardRelease(root, { metadata });
  assert.equal(valid.dashboardSourceHash, manifest.dashboardSourceHash);
  const link = join(await temporary(t), "current");
  await symlink(root, link);
  assert.equal((await verifyDashboardRelease(link, { metadata })).root, root);
  await assert.rejects(verifyDashboardRelease(link, { metadata: async path => {
    const info = await metadata(path);
    return path === link ? Object.assign(info, { uid: 501 }) : info;
  } }), /owner|root/i);
  for (const file of files) {
    const original = await readFile(join(root, file));
    await writeFile(join(root, file), Buffer.concat([original, Buffer.from("\n")]));
    await assert.rejects(verifyDashboardRelease(root, { metadata }), /hash/i);
    await writeFile(join(root, file), original);
  }
  for (const path of [root, join(root, "release.json"), ...files.map(file => join(root, file))]) {
    await assert.rejects(verifyDashboardRelease(root, { metadata: async candidate => {
      const info = await metadata(candidate);
      return candidate === path ? Object.assign(info, { uid: 501 }) : info;
    } }), /owner|root/i);
    await assert.rejects(verifyDashboardRelease(root, { metadata: async candidate => {
      const info = await metadata(candidate);
      return candidate === path ? Object.assign(info, { mode: info.mode | 0o020 }) : info;
    } }), /permission|mode/i);
  }
  delete manifest.files["public-status.mjs"];
  await writeFile(join(root, "release.json"), JSON.stringify(manifest));
  await assert.rejects(verifyDashboardRelease(root, { metadata }), /manifest|missing/i);
});

test("child-process HTTP fixture preserves auth and status API without a home banner and coexists with BTC loader", { timeout: 15_000 }, async t => {
  const directory = await temporary(t);
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "radar", "src"), { recursive: true });
  for (const file of ["btc-radar-loader.mjs", "btc-radar-hooks.mjs"]) {
    await copyFile(new URL(`../scripts/${file}`, import.meta.url), join(directory, "scripts", file));
  }
  await writeFile(join(directory, "src", "btc-radar-html.mjs"), 'export const marker = "original";');
  await writeFile(join(directory, "radar", "src", "btc-radar-html.mjs"), 'export const marker = "released-radar";');
  const authURL = new URL("../src/dashboard-auth.mjs", import.meta.url).href;
  const source = `import { createServer } from "node:http";
import { marker } from "../src/btc-radar-html.mjs";
import { dashboardAuthConfig, dashboardRequestAuthorized } from ${JSON.stringify(authURL)};
const config = dashboardAuthConfig({DASHBOARD_USERNAME:"fixture",DASHBOARD_PASSWORD:"not-a-real-secret"});
const liveDashboardHtml = () => "<html><body><main>Home</main></body></html>";
function requireAuthentication(request, response) {
  if (dashboardRequestAuthorized(request, config)) return true;
  response.writeHead(request.url === "/" ? 303 : 401, {Location:"/login"}); response.end("guard"); return false;
}
const server = createServer(async (request, response) => {
  try {
    if(request.url === "/login") {response.end("<body>Login</body>"); return;}
${guard}
    if(request.url === "/") {
${home}
      return;
    }
    response.end(marker);
  } catch {response.writeHead(500);response.end("fixture failure");}
});
server.listen(0,"127.0.0.1",()=>console.log(server.address().port));`;
  const serverPath = join(directory, "scripts", "serve-live-dashboard.mjs");
  await writeFile(serverPath, source);
  const hookURL = new URL("../ops/auth-renewal/dashboard-hook.mjs", import.meta.url).href;
  const bootstrap = join(directory, "bootstrap.mjs");
  await writeFile(bootstrap, `import {register} from "node:module";
register(${JSON.stringify(hookURL)}, {data:${JSON.stringify({ dashboardURL: pathToFileURL(serverPath).href,
    dashboardSourceHash: hash(source), publicStatusURL: moduleURL })}});
await import(${JSON.stringify(pathToFileURL(serverPath).href)});`);
  const child = spawn(process.execPath, ["--import", join(directory, "scripts", "btc-radar-loader.mjs"), bootstrap], {
    env: { BTC_RADAR_CODE_ROOT: join(directory, "radar") }, stdio: ["ignore", "pipe", "pipe"]
  });
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); } });
  const port = await Promise.race([
    once(child.stdout, "data").then(([chunk]) => Number(String(chunk).trim())),
    once(child, "exit").then(() => { throw Error(errors || "fixture exited before listening"); })
  ]);
  const origin = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Basic ${Buffer.from("fixture:not-a-real-secret").toString("base64")}` };
  for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) {
    assert.equal((await fetch(origin + "/api/buy-authorization-status", { method })).status, 401);
    const response = await fetch(origin + "/api/buy-authorization-status", { method, headers });
    assert.equal(response.status, method === "GET" ? 200 : 405);
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (method !== "GET") assert.equal(response.headers.get("allow"), "GET");
    if (method === "GET") assert.equal((await response.json()).label, "未核实");
  }
  assert.equal((await fetch(origin + "/", { redirect: "manual" })).status, 303);
  assert.doesNotMatch(await fetch(origin + "/login").then(response => response.text()), /buy-authorization-banner/);
  const homepage = await fetch(origin + "/", { headers }).then(response => response.text());
  assert.equal(homepage, "<html><body><main>Home</main></body></html>");
  assert.doesNotMatch(homepage, /buy-authorization-banner|买入权限|\/api\/buy-authorization-status/);
  assert.equal(await fetch(origin + "/btc-radar", { headers }).then(response => response.text()), "released-radar");
  assert.equal(await fetch(origin + "/strategies", { headers }).then(response => response.text()), "released-radar");
  assert.equal(await readFile(serverPath, "utf8"), source, "load hook must leave disk source intact");
});
