import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { configureStatementPassword, readStatementPasswordStatus } from "../src/personal-assets.mjs";
import { statementPasswordsHtml } from "../src/personal-assets-html.mjs";

async function fixture(context) {
  const stateDir = await mkdtemp(join(tmpdir(), "asset-statement-passwords-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  return { stateDir, path: join(stateDir, "personal-assets-statement-passwords.json") };
}

test("statement passwords are private, separate by account, and never returned or added to assets", async (context) => {
  const { stateDir, path } = await fixture(context);
  const sentinel = join(stateDir, "personal-assets.json");
  await writeFile(sentinel, "unchanged financial ledger");
  const initial = await readStatementPasswordStatus({ stateDir });
  assert.deepEqual(Object.keys(initial.providers), ["usmart-hk", "usmart-sg"]);
  assert.equal(initial.providers["usmart-hk"].configured, false);
  const password = " synthetic HK password ";
  const saved = await configureStatementPassword({ stateDir, provider: "usmart-hk", password });
  assert.equal(saved.providers["usmart-hk"].configured, true);
  assert.ok(Number.isFinite(Date.parse(saved.providers["usmart-hk"].updatedAt)));
  assert.doesNotMatch(JSON.stringify(saved), /synthetic HK password|"password"/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, "utf8")).passwords["usmart-hk"].password, password);
  await configureStatementPassword({ stateDir, provider: "usmart-sg", password: "synthetic SG password" });
  const cleared = await configureStatementPassword({ stateDir, provider: "usmart-hk", clear: true });
  assert.equal(cleared.providers["usmart-hk"].configured, false);
  assert.equal(cleared.providers["usmart-sg"].configured, true);
  assert.doesNotMatch(await readFile(path, "utf8"), /synthetic HK password/);
  assert.equal(await readFile(sentinel, "utf8"), "unchanged financial ledger");
  assert.deepEqual((await readdir(stateDir)).sort(), ["personal-assets-statement-passwords.json", "personal-assets.json"]);
});

test("invalid password updates leave existing credentials unchanged", async (context) => {
  const { stateDir, path } = await fixture(context);
  await configureStatementPassword({ stateDir, provider: "usmart-hk", password: "synthetic original" });
  const before = await readFile(path, "utf8");
  for (const patch of [
    { provider: "unknown", password: "synthetic" }, { provider: "__proto__", password: "synthetic" },
    { password: "" }, { password: null }, { password: "x".repeat(257) }, { password: "bad\npassword" },
    { password: "synthetic", clear: true }, { clear: "true" }, {},
  ]) {
    await assert.rejects(configureStatementPassword({ stateDir, provider: "usmart-hk", ...patch }), { statusCode: 400 });
    assert.equal(await readFile(path, "utf8"), before);
  }
});

test("concurrent account saves retain both passwords and leave no lock or temporary files", async (context) => {
  const { stateDir, path } = await fixture(context);
  await Promise.all([
    configureStatementPassword({ stateDir, provider: "usmart-hk", password: "synthetic HK" }),
    configureStatementPassword({ stateDir, provider: "usmart-sg", password: "synthetic SG" }),
  ]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8")).passwords).sort(), ["usmart-hk", "usmart-sg"]);
  assert.deepEqual(await readdir(stateDir), ["personal-assets-statement-passwords.json"]);
});

test("unsafe, corrupt or symlinked credential files fail closed without leaking their contents", async (context) => {
  const { stateDir, path } = await fixture(context);
  await writeFile(path, "synthetic secret malformed JSON", { mode: 0o600 });
  await assert.rejects(readStatementPasswordStatus({ stateDir }), error => error.statusCode === 500 && !error.message.includes("synthetic"));
  await rm(path);
  await configureStatementPassword({ stateDir, provider: "usmart-hk", password: "synthetic secret" });
  await chmod(path, 0o644);
  await assert.rejects(readStatementPasswordStatus({ stateDir }), { statusCode: 500 });
  const outside = join(stateDir, "outside.json");
  await writeFile(outside, await readFile(path), { mode: 0o600 });
  await rm(path);
  await symlink(outside, path);
  await assert.rejects(configureStatementPassword({ stateDir, provider: "usmart-hk", password: "replacement" }), { statusCode: 500 });
  assert.match(await readFile(outside, "utf8"), /synthetic secret/);
});

test("password page clears secret fields before waiting on a save and when leaving the page", async () => {
  const html = statementPasswordsHtml({ nonce: "synthetic-nonce" });
  const script = html.match(/<script nonce="synthetic-nonce">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(script, /localStorage|sessionStorage|console\./);
  const message = { dataset: {} }, statuses = {}, windowEvents = {}, calls = [];
  const forms = ["usmart-hk", "usmart-sg"].map(provider => {
    statuses["status-" + provider] = {};
    const input = { value: "", disabled: false }, saveButton = {}, clearButton = {}, events = {};
    clearButton.addEventListener = (type, handler) => { events[type] = handler; };
    return { dataset: { provider }, input, saveButton, clearButton, events,
      addEventListener: (type, handler) => { events[type] = handler; },
      querySelector: selector => selector === "input" ? input : selector === "[data-clear]" ? clearButton : saveButton };
  });
  const status = { providers: Object.fromEntries(forms.map(form => [form.dataset.provider, { configured: false, updatedAt: null }])) };
  let finishSave;
  const document = {
    getElementById: id => id === "password-message" ? message : statuses[id],
    querySelectorAll: selector => selector === "form[data-provider]" ? forms : selector === "form input" ? forms.map(form => form.input) : forms.flatMap(form => [form.input, form.saveButton, form.clearButton]),
  };
  runInNewContext(script, { document, window: { addEventListener: (type, handler) => { windowEvents[type] = handler; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "POST") return new Promise(resolve => { finishSave = () => resolve({ ok: true, json: async () => status }); });
      return { ok: true, json: async () => status };
    } });
  await new Promise(setImmediate);
  forms[0].input.value = "synthetic local-only test password";
  forms[0].events.submit({ preventDefault() {} });
  assert.equal(forms[0].input.value, "");
  assert.equal(forms[0].input.disabled, true);
  assert.equal(JSON.parse(calls[1].options.body).password, "synthetic local-only test password");
  finishSave();
  await new Promise(setImmediate);
  assert.equal(forms[0].input.disabled, false);
  assert.match(message.textContent, /已保存/);
  forms[1].input.value = "unsent draft";
  windowEvents.pagehide();
  assert.equal(forms[1].input.value, "");
  assert.equal(calls.length, 2);
});
