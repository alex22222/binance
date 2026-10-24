import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { personalAssetsHtml } from "../src/personal-assets-html.mjs";
import * as core from "../src/personal-assets-core.mjs";

const source = await readFile(new URL("../src/personal-assets-client.mjs", import.meta.url), "utf8");

class Element {
  innerHTML = "";
  textContent = "";
  hidden = false;
  disabled = false;
  open = false;
  dataset = {};
  value = "";
  checked = false;
  listeners = {};
  showModal() { this.open = true; }
  close() { this.open = false; }
  scrollIntoView() {}
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute() {}
  removeAttribute() {}
}

function entry(overrides = {}) {
  return { id: "entry-1", accountId: "account-1", kind: "total", name: "账户总额", category: "未分类", currency: "CNY", amount: 1234.56, asOf: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()), source: "manual", ...overrides };
}
function stateWith(entries = []) {
  return { schemaVersion: 1, revision: 0, updatedAt: null, portfolio: { ...core.emptyPortfolio(), entries }, snapshots: [] };
}

async function view(initial = stateWith(), handleRequest = null, { search = "", storage = null, aiHandler = null } = {}) {
  const elements = new Map();
  const listeners = {};
  const requests = [];
  const aiRequests = [];
  const navigations = [];
  const intervals = [];
  const get = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = createContext({
    core, Intl, Date, JSON, Map, Set, Number, String, Object, Array, Math, Error,
    crypto: { randomUUID: () => "new-generated-id" },
    URL: class extends URL { static createObjectURL() { return "blob:local-image"; } static revokeObjectURL() {} },
    Blob,
    location: { origin: "http://localhost:3000", search, assign: (url) => navigations.push(url) },
    window: { localStorage: storage, addEventListener() {} },
    document: { getElementById: get, querySelectorAll: () => [], addEventListener: (name, handler) => { listeners[name] = handler; }, createElement: () => ({ click() {}, remove() {} }) },
    setTimeout: () => 0, clearTimeout() {}, setInterval: (handler, delay) => { intervals.push({ handler, delay }); return intervals.length; },
    fetch: async (url, options = {}) => {
      if (url.startsWith("/api/assets/ai/")) {
        aiRequests.push({ url, options });
        return aiHandler ? aiHandler(url, options) : {ok:true,status:200,json:async()=>({configured:false,status:"unconfigured",review:null})};
      }
      requests.push({ url, options });
      if (handleRequest) return handleRequest(url, options, requests.length);
      if (options.method === "PUT") return { ok: true, status: 200, json: async () => ({ ...initial, revision: 1, portfolio: JSON.parse(options.body).portfolio }) };
      return { ok: true, status: 200, json: async () => initial };
    }
  });
  runInContext(source.replace(/^import[^\n]+\n/, "const { PLATFORMS, CURRENCIES, CATEGORIES, emptyPortfolio, entryIdentity, validatePortfolio, summarize, parseCsv, csvTemplate, extractOcrCandidates, detectCurrency } = core;\n"), context);
  for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
  return { get, listeners, requests, aiRequests, navigations, intervals, run: (code) => runInContext(code, context) };
}

test("mounts a native assets page in the shared shell and safely quotes the CSP nonce", () => {
  const html = personalAssetsHtml({ nonce: 'test"><script>alert(1)</script>' });
  assert.match(html, /Agentic Wallet/);
  assert.match(html, /<dialog id="asset-dialog" aria-labelledby="dialog-title">/);
  assert.match(html, /type="module" nonce="test&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;" src="\/assets\/app\.mjs"/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>|react|cdn\./i);
  assert.match(html, /aria-label="资产页面导航"/);
});

test("loads the real API and shows all supported empty platforms without invented zero balances", async () => {
  const ui = await view();
  assert.equal(ui.requests[0].url, "/api/assets");
  assert.match(ui.get("asset-content").innerHTML, /尚未录入真实金额/);
  for (const platform of core.PLATFORMS) assert.ok(ui.get("asset-content").innerHTML.includes(platform));
  assert.equal((ui.get("asset-content").innerHTML.match(/class="platform-number">—/g) || []).length, core.PLATFORMS.length);
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /¥<\/small>0\.00/);
});

test("fund NAV updates keep confirmation distinct from expiry, hide quantities and allow reviewed correction", async () => {
  const initial = stateWith([entry({ id: "fund-one", kind: "holding", category: "货币基金", source: "api" })]);
  initial.portfolio.accounts[0].basis = "holdings";
  initial.funds = { status: "available", bindings: [{ entryId: "fund-one", accountId: "account-1", isin: "HK0000857299", name: "Synthetic public fund", currency: "USD", quantity: "2.345678", confirmedOn: "2020-01-01", nav: "12.123456", navDate: "2026-10-23", source: "Official manager", url: "https://hk.taikangasset.cn/hk/product_service/productService.html", enabled: true, delayed: false, lastFetchedAt: "2026-10-24T12:00:00Z" }] };
  const ui = await view(initial);
  assert.match(ui.get("asset-content").innerHTML, /基金与 ETF 自动估值|确认日期不是到期日/);
  assert.match(ui.get("asset-content").innerHTML, /2\.345678/);
  assert.match(ui.run("entryDateBasis(portfolio().entries[0])"), /净值日期/);
  ui.run("hidden = true; render()");
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /2\.345678|12\.123456/);
  ui.run("hidden = false; openFund('fund-one')");
  assert.equal(ui.run("modal"), "fund");
  assert.match(ui.get("dialog-body").innerHTML, /不是到期日/);
  assert.match(ui.get("dialog-body").innerHTML, /value="2\.345678"/);
  ui.run("closeDialog(); state.funds.bindings[0].priceBasis = 'market-close'; render()");
  assert.match(ui.get("asset-content").innerHTML, /市场收盘价.*非盘中实时/);
  assert.match(ui.run("entryDateBasis(portfolio().entries[0])"), /市场收盘价日期/);
});

test("a new platform without an account opens its own account form instead of another platform's asset entry", async () => {
  const initial = stateWith();
  initial.portfolio.accounts = initial.portfolio.accounts.filter((account) => !["民生银行", "TokenPocket"].includes(account.platform));
  const ui = await view(initial);
  for (const platform of ["民生银行", "TokenPocket"]) {
    const card = ui.run(`platformCard(${JSON.stringify(platform)},9,summarize(portfolio()))`);
    assert.match(card, /data-action="account"/);
    assert.doesNotMatch(card, /data-action="manual"/);
    await ui.listeners.click({ target: { closest: () => ({ disabled: false, dataset: { action: "account", platform } }) } });
    assert.equal(ui.run("accountDraft.platform"), platform);
    assert.equal(ui.run("modal"), "account");
    ui.run("closeDialog()");
  }
  assert.equal(ui.requests.filter((request) => request.options.method === "PUT").length, 0);
});

test("Polymarket and Future have their own platform cards, marks and account dropdown options", async () => {
  const ui = await view();
  for (const [platform, mark] of [["Polymarket", "PM"], ["Future", "F"]]) {
    const card = ui.run(`platformCard(${JSON.stringify(platform)},PLATFORMS.indexOf(${JSON.stringify(platform)}),summarize(portfolio()))`);
    assert.match(card, new RegExp(`class="platform-mark">${mark}<`));
    assert.match(card, new RegExp(`class="platform-name">${platform}<`));
    await ui.listeners.click({ target: { closest: () => ({ disabled: false, dataset: { action: "account", platform } }) } });
    assert.equal(ui.run("accountDraft.platform"), platform);
    assert.match(ui.get("dialog-body").innerHTML, new RegExp(`<option value="${platform}" selected>${platform}</option>`));
    ui.run("closeDialog()");
  }
});

function displayState() {
  const initial = stateWith([entry({ amount: 700, category: "现金" }), entry({ id: "second", accountId: "account-2", amount: 350, category: "股票" })]);
  initial.revision = 3;
  initial.portfolio.rates.USD = { value: 7, date: entry().asOf };
  initial.fx = { mode: "automatic", status: "fresh", fetchedAt: "2026-10-24T12:00:00.000Z", source: "Coinbase", rates: { USD: { value: 7, date: entry().asOf, asOf: null, fetchedAt: "2026-10-24T12:00:00.000Z", timeBasis: "retrieved", source: "Coinbase" } } };
  return initial;
}
function clickCurrency(ui, currency) { return ui.listeners.click({ target: { closest: () => ({ disabled: false, dataset: { action: "display-currency", currency } }) } }); }

test("currency buttons convert every current view without changing ratios, original amounts, ledger revision or snapshot values", async () => {
  const initial = displayState();
  initial.snapshots = [{ id: "frozen", at: "2026-10-24T12:00:00.000Z", total: 1050, missing: 0 }];
  const ui = await view(initial);
  assert.match(ui.get("asset-content").innerHTML, /role="group" aria-label="显示币种"/);
  assert.match(ui.get("asset-content").innerHTML, /data-currency="CNY" aria-pressed="true"/);
  await clickCurrency(ui, "USD");
  const html = ui.get("asset-content").innerHTML;
  assert.match(html, /data-currency="USD" aria-pressed="true"/);
  assert.match(html, /<small>\$<\/small>150\.00/);
  assert.match(html, /USD 100\.00/);
  assert.match(html, /已核算资产 · USD/);
  assert.match(html, /折合 USD 100\.00/);
  assert.match(html, /stroke-dasharray="66\.666667 33\.333333"/);
  assert.match(html, /CNY 700\.00/);
  assert.match(html, /当前以 USD 展示资产/);
  assert.doesNotMatch(html, /内部按 CNY 核算/);
  assert.match(ui.get("asset-message").textContent, /重新折合 USD/);
  ui.run("openRates()");
  assert.match(ui.get("dialog-description").textContent, /支持人民币与美元展示.*每单位折合 CNY/);
  ui.run("closeDialog()");
  ui.run('page="holdings"; render()');
  assert.match(ui.get("asset-content").innerHTML, /<th>折合 USD<\/th>/);
  assert.match(ui.get("asset-content").innerHTML, /class="num">100\.00<\/td>/);
  ui.run('page="analysis"; render()');
  assert.match(ui.get("asset-content").innerHTML, /折合 USD/);
  assert.match(ui.get("asset-content").innerHTML, /66\.7% · USD 100\.00/);
  ui.run('page="history"; render()');
  assert.match(ui.get("asset-content").innerHTML, /保存时的 CNY 金额/);
  assert.match(ui.get("asset-content").innerHTML, />CNY<.*1,050\.00/);
  assert.doesNotMatch(ui.get("asset-content").innerHTML, />150\.00</);
  assert.equal(ui.run("state.revision"), 3);
  assert.equal(ui.run("summarize(portfolio()).total"), 1050);
  assert.equal(ui.run("state.portfolio.entries[0].amount"), 700);
  ui.run('page="overview"; render()');
  await clickCurrency(ui, "CNY");
  assert.match(ui.get("asset-content").innerHTML, /<small>¥<\/small>1,050\.00/);
  assert.match(ui.get("asset-message").textContent, /重新折合 CNY/);
  assert.equal(ui.requests.filter((item) => item.url === "/api/assets/rates/refresh").length, 2);
  assert.equal(ui.requests.filter((item) => item.options.method === "PUT").length, 0);
});

test("USD switching uses the existing quote immediately and reprices after the read-only refresh without losing an open draft", async () => {
  const initial = displayState();
  const latest = structuredClone(initial);
  latest.portfolio.rates.USD.value = 10;
  latest.fx.rates.USD.value = 10;
  let release;
  const ui = await view(initial, async (url) => url.endsWith("/rates/refresh") ? new Promise((resolve) => { release = () => resolve(syncResponse(latest)); }) : syncResponse(initial));
  ui.run('openEntry(); draft.amount=123; draft.currency="CNY"');
  const pending = clickCurrency(ui, "USD");
  assert.match(ui.get("asset-content").innerHTML, /<small>\$<\/small>150\.00/);
  assert.equal(ui.run("draft.amount"), 123);
  release();
  await pending;
  assert.match(ui.get("asset-content").innerHTML, /<small>\$<\/small>105\.00/);
  assert.equal(ui.run("draft.amount"), 123);
  assert.equal(ui.run("modal"), "manual");
  assert.equal(ui.run("state.revision"), 3);
  assert.equal(ui.requests.filter((item) => item.options.method === "PUT").length, 0);
});

test("missing USD FX never relabels a CNY value and users can switch back to CNY", async () => {
  const initial = displayState();
  delete initial.portfolio.rates.USD;
  initial.fx = { mode: "automatic", status: "unavailable", fetchedAt: null, source: null, rates: {} };
  const ui = await view(initial);
  await clickCurrency(ui, "USD");
  const html = ui.get("asset-content").innerHTML;
  assert.match(html, /<small>\$<\/small>—/);
  assert.match(html, /USD\/CNY 自动汇率暂不可用/);
  assert.doesNotMatch(html, /USD 1,050\.00|USD 700\.00|USD 350\.00/);
  assert.match(html, /折合 USD 待换算/);
  await clickCurrency(ui, "CNY");
  assert.match(ui.get("asset-content").innerHTML, /<small>¥<\/small>1,050\.00/);
});

test("invalid or overflowing USD exchange rates never produce a numeric USD valuation", async () => {
  const ui = await view(displayState());
  for (const value of ["0", "-7", "NaN", "Infinity", '"7"', "1e10", "Number.MIN_VALUE"]) {
    ui.run(`displayCurrency="USD"; state.portfolio.rates.USD.value=${value}; render()`);
    assert.equal(ui.run("displayValue(1050)"), null);
    assert.match(ui.get("asset-content").innerHTML, /<small>\$<\/small>—/);
    assert.doesNotMatch(ui.get("asset-content").innerHTML, /USD (?:1,050\.00|700\.00|350\.00|NaN|Infinity|∞)/);
  }
});

test("display currency preference is local, restores safely and amount privacy applies in USD", async () => {
  const writes = [];
  const storage = { getItem: () => "USD", setItem: (key, value) => writes.push([key, value]) };
  const ui = await view(displayState(), null, { storage });
  assert.match(ui.get("asset-content").innerHTML, /<small>\$<\/small>150\.00/);
  ui.run("hidden=true; render()");
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /150\.00|100\.00|50\.00|66\.7%|700\.00/);
  await clickCurrency(ui, "CNY");
  assert.deepEqual(writes, [["personal-assets-display-currency", "CNY"]]);
  const unavailable = { getItem() { throw new Error("unavailable"); }, setItem() { throw new Error("unavailable"); } };
  const noStorage = await view(displayState(), null, { storage: unavailable });
  assert.match(noStorage.get("asset-content").innerHTML, /<small>¥<\/small>1,050\.00/);
  await clickCurrency(noStorage, "USD");
  assert.match(noStorage.get("asset-content").innerHTML, /<small>\$<\/small>150\.00/);
  const invalidStorage = await view(displayState(), null, { storage: { getItem: () => "BTC" } });
  assert.match(invalidStorage.get("asset-content").innerHTML, /<small>¥<\/small>1,050\.00/);
});

test("a load failure remains distinct from an empty portfolio", async () => {
  const ui = await view(stateWith(), async () => { throw new Error("offline"); });
  assert.match(ui.get("asset-content").innerHTML, /不会用空资产替代读取失败/);
  assert.match(ui.get("asset-error").innerHTML, /offline/);
  assert.equal(ui.run("state"), null);
});

test("manual entry saves confirmed fields through the revision checked endpoint", async () => {
  const ui = await view();
  await ui.run('openEntry(); draft.currency="CNY"; draft.amount=250; draft.name="真实资产"; saveEntry()');
  const write = ui.requests.find((request) => request.options.method === "PUT");
  assert.ok(write);
  const body = JSON.parse(write.options.body);
  assert.equal(body.revision, 0);
  assert.equal(body.portfolio.entries[0].amount, 250);
  assert.equal(body.portfolio.entries[0].name, "真实资产");
  assert.equal(ui.get("asset-dialog").open, false);
});

test("escapes saved names and OCR text and privacy mode hides amounts and charts", async () => {
  const initial = stateWith([entry({ kind: "holding", name: '<img src=x onerror="alert(1)">' })]);
  initial.portfolio.accounts[0].basis = "holdings";
  const ui = await view(initial);
  ui.run('page="holdings"; render()');
  assert.match(ui.get("asset-content").innerHTML, /&lt;img src=x/);
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /<img/);
  ui.run('hidden=true; page="overview"; render()');
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /1,234\.56|100\.0%|bar-fill/);
  assert.match(ui.get("asset-content").innerHTML, /分布及占比已隐藏/);
  ui.run('openImport(); ocrImage="blob:local"; ocrText="<script>1234.56</script>"; candidates=[{label:ocrText,amount:1234.56}]; renderImport()');
  assert.match(ui.get("dialog-body").innerHTML, /隐私模式已隐藏原图/);
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /1234\.56|<img|<script>/);
  ui.run('hidden=false; renderImport()');
  assert.match(ui.get("dialog-body").innerHTML, /&lt;script&gt;1234\.56&lt;\/script&gt;/);
});

test("CSV preview requires explicit consent before replacing a matching record and rejects duplicates", async () => {
  const ui = await view(stateWith([entry()]));
  await ui.run('openImport(); importTab="csv"; csvEntries=[{...state.portfolio.entries[0],id:"csv-1",amount:500}]; renderImport(); confirmCsv()');
  assert.equal(ui.requests.filter((request) => request.options.method === "PUT").length, 0);
  assert.match(ui.get("dialog-error").innerHTML, /勾选同意替换/);
  ui.run('csvEntries.push({...csvEntries[0],id:"csv-2"}); renderImport()');
  assert.match(ui.get("dialog-body").innerHTML, /重复记录/);
  ui.run('csvEntries.pop(); replaceConfirmed=true');
  await ui.run("confirmCsv()");
  const body = JSON.parse(ui.requests.find((request) => request.options.method === "PUT").options.body);
  assert.equal(body.portfolio.entries.length, 1);
  assert.equal(body.portfolio.entries[0].id, "entry-1");
  assert.equal(body.portfolio.entries[0].amount, 500);
});

test("409 preserves the draft and requires explicit reload before saving again", async () => {
  const initial = stateWith();
  const ui = await view(initial, async (_url, options) => options.method === "PUT" ? { ok: false, status: 409, json: async () => ({ error: "conflict" }) } : { ok: true, status: 200, json: async () => initial });
  await ui.run('openEntry(); draft.currency="CNY"; draft.amount=42; saveEntry()');
  assert.equal(ui.run("draft.amount"), 42);
  assert.equal(ui.get("asset-dialog").open, true);
  assert.match(ui.get("dialog-error").innerHTML, /当前草稿仍保留/);
  assert.match(ui.get("dialog-error").innerHTML, /重新载入最新数据/);
  await ui.run("saveEntry()");
  assert.equal(ui.requests.filter((request) => request.options.method === "PUT").length, 1);
  await ui.run("load()");
  assert.equal(ui.run("draft.amount"), 42);
  assert.equal(ui.run("conflict"), false);
});

test("a draft whose original record was deleted cannot silently save an unchanged map", async () => {
  const ui = await view(stateWith([entry()]));
  await ui.run('openEntry(state.portfolio.entries[0]); state.portfolio.entries=[]; draft.amount=77; saveEntry()');
  assert.equal(ui.requests.filter((request) => request.options.method === "PUT").length, 0);
  assert.equal(ui.get("deleted-draft").hidden, false);
  assert.match(ui.get("dialog-error").innerHTML, /作为新记录继续核对/);
});

test("unknown screenshot currency stays blank and cannot persist without field confirmation", async () => {
  const ui = await view();
  await ui.run('openEntry(null,{label:"余额 100",amount:100}); saveEntry()');
  assert.equal(ui.run("draft.currency"), "");
  assert.equal(ui.requests.filter((request) => request.options.method === "PUT").length, 0);
  assert.match(ui.get("dialog-error").innerHTML, /勾选确认/);
  assert.match(source, /script\.src = "\/assets\/ocr\/tesseract\.min\.js"/);
  assert.doesNotMatch(source, /fetch\([^\n]*(?:file|ocrText|ocrImage)/);
});

test("shows confirmed original-currency totals independently of FX and excludes pending accounts and secondary records", async () => {
  const initial = stateWith([
    entry({ amount: 100 }),
    entry({ id: "usd-total", accountId: "account-2", currency: "USD", amount: 10 }),
    entry({ id: "usd-detail", accountId: "account-2", kind: "holding", currency: "USD", amount: 7, name: "分项" }),
    entry({ id: "usd-pending", accountId: "account-3", currency: "USD", amount: 30 })
  ]);
  initial.portfolio.accounts[2].reviewStatus = "pending";
  const ui = await view(initial);
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(originalCurrencyTotals())")), [{ name: "CNY", value: 100 }, { name: "USD", value: 10 }]);
  assert.match(ui.get("asset-content").innerHTML, /原币参考/);
  assert.match(ui.get("asset-content").innerHTML, /按最新可用汇率折算/);
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /不依赖汇率|汇率设置/);
  assert.match(ui.get("asset-content").innerHTML, /部分估值/);
});

test("pending accounts and imported dates are explicit, notes are escaped and all note text is hidden in privacy mode", async () => {
  const initial = stateWith([entry({ amount: 9876.54, asOfBasis: "imported", note: '<img src=x>分项备注4321.09' })]);
  initial.portfolio.accounts[0] = { ...initial.portfolio.accounts[0], reviewStatus: "pending", name: "待核实账户", note: '<script>账户备注5678.12</script>' };
  const ui = await view(initial);
  assert.match(ui.get("asset-content").innerHTML, /待确认账户/);
  assert.match(ui.get("asset-content").innerHTML, /待核实账户/);
  assert.match(ui.get("asset-content").innerHTML, /9,876\.54/);
  assert.match(ui.get("asset-content").innerHTML, /&lt;script&gt;账户备注5678\.12&lt;\/script&gt;/);
  ui.run('page="holdings"; render()');
  assert.match(ui.get("asset-content").innerHTML, /截图日期未核实/);
  assert.match(ui.get("asset-content").innerHTML, /待确认排除/);
  assert.match(ui.get("asset-content").innerHTML, /&lt;img src=x&gt;分项备注4321\.09/);
  ui.run('hidden=true; render()');
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /9876\.54|9,876\.54|4321\.09|5678\.12|分项备注|账户备注/);
  ui.run('openAccount("account-1")');
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /账户备注5678\.12/);
  ui.run('openEntry(state.portfolio.entries[0])');
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /分项备注4321\.09/);
});

test("editing an account preserves its identity and explicitly resolves pending status", async () => {
  const initial = stateWith([entry()]);
  initial.portfolio.accounts[0].reviewStatus = "pending";
  const ui = await view(initial);
  await ui.run('openAccount("account-1"); accountDraft.name="已核实账户"; accountDraft.platform="ZA Bank"; accountDraft.reviewStatus="confirmed"; accountDraft.note="已核对平台"; saveAccount()');
  const write = ui.requests.find((request) => request.options.method === "PUT");
  assert.ok(write);
  const body = JSON.parse(write.options.body);
  assert.equal(body.portfolio.accounts.length, initial.portfolio.accounts.length);
  assert.equal(body.portfolio.accounts[0].id, "account-1");
  assert.equal(body.portfolio.accounts[0].name, "已核实账户");
  assert.equal(body.portfolio.accounts[0].reviewStatus, "confirmed");
  assert.equal(body.portfolio.accounts[0].note, "已核对平台");
  assert.equal(body.portfolio.entries[0].accountId, "account-1");
});

test("unattributed platform cannot become confirmed and changing account basis never resolves pending status", async () => {
  const initial = stateWith([entry()]);
  initial.portfolio.accounts[0].reviewStatus = "pending";
  const ui = await view(initial);
  await ui.run('openAccount("account-1"); accountDraft.platform="待确认"; accountDraft.reviewStatus="confirmed"; saveAccount()');
  assert.equal(ui.requests.filter((request) => request.options.method === "PUT").length, 0);
  assert.match(ui.get("dialog-error").innerHTML, /实际平台/);
  ui.run("closeDialog()");
  await ui.listeners.change({ target: { dataset: { basis: "account-1" }, value: "holdings" } });
  const body = JSON.parse(ui.requests.find((request) => request.options.method === "PUT").options.body);
  assert.equal(body.portfolio.accounts[0].reviewStatus, "pending");
  assert.equal(body.portfolio.accounts[0].basis, "holdings");
});

test("editing entries keeps date provenance and notes and allows an explicit date review", async () => {
  const initial = stateWith([entry({ asOfBasis: "imported", note: "日期待核实" })]);
  const ui = await view(initial);
  ui.run("openEntry(state.portfolio.entries[0])");
  assert.match(ui.get("dialog-body").innerHTML, /entry-date-basis/);
  assert.match(ui.get("dialog-body").innerHTML, /日期待核实/);
  await ui.run('draft.asOfBasis="statement"; draft.note="已核对资产日期"; saveEntry()');
  const body = JSON.parse(ui.requests.find((request) => request.options.method === "PUT").options.body);
  assert.equal(body.portfolio.entries[0].asOfBasis, "statement");
  assert.equal(body.portfolio.entries[0].note, "已核对资产日期");
});

test("automatic FX shows its source and observation time in a read-only table and escapes provider text", async () => {
  const initial = stateWith([entry({ currency: "USD" })]);
  initial.portfolio.rates.USD = { value: 7, date: entry().asOf, note: '<img src=x>参考来源 123.45' };
  initial.fx = { mode: "automatic", status: "fresh", fetchedAt: "2026-10-24T12:00:00.000Z", source: '<img src=x>公开汇率', rates: { USD: { value: 7, date: entry().asOf, asOf: "2026-10-24T11:59:00.000Z", source: '<img src=x>汇率服务' } } };
  const ui = await view(initial);
  ui.run('page="analysis"; render()');
  assert.match(ui.get("asset-content").innerHTML, /自动汇率/);
  assert.match(ui.get("asset-content").innerHTML, /&lt;img src=x&gt;汇率服务/);
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /<img/);
  ui.run("openRates()");
  assert.match(ui.get("dialog-body").innerHTML, /7\.000000/);
  assert.match(ui.get("dialog-body").innerHTML, /19:59:00/);
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /<input|data-rate|rates-form|手动填写/);
  assert.match(ui.get("dialog-footer").innerHTML, /刷新汇率/);
  ui.run('hidden=true; render(); openRates()');
  assert.doesNotMatch(ui.get("asset-content").innerHTML + ui.get("dialog-body").innerHTML, /7\.000000|参考来源|123\.45/);
  assert.equal(ui.requests.filter((request) => request.options.method === "PUT").length, 0);
});

test("refreshing automatic FX replaces valuations and preserves the ledger revision without writing asset records", async () => {
  const initial = stateWith([entry({ currency: "USD", amount: 10 })]);
  initial.revision = 4;
  initial.portfolio.rates.USD = { value: 7, date: entry().asOf };
  const refreshed = structuredClone(initial);
  refreshed.portfolio.rates.USD.value = 8;
  refreshed.fx = { mode: "automatic", status: "fresh", fetchedAt: "2026-10-24T12:00:00.000Z", source: "公开汇率", rates: { USD: { value: 8, date: entry().asOf, asOf: "2026-10-24T12:00:00.000Z", source: "公开汇率" } } };
  const ui = await view(initial, async (url) => syncResponse(url.endsWith("/rates/refresh") ? refreshed : initial));
  ui.run("openRates()");
  await ui.listeners.click({ target: { closest: () => ({ disabled: false, dataset: { action: "refresh-rates" } }) } });
  const request = ui.requests.find((item) => item.url === "/api/assets/rates/refresh");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {});
  assert.equal(ui.run("state.revision"), 4);
  assert.equal(ui.run("summarize(portfolio()).total"), 80);
  assert.equal(ui.run("state.portfolio.entries[0].amount"), 10);
  assert.match(ui.get("dialog-body").innerHTML, /8\.000000/);
  assert.equal(ui.requests.filter((item) => item.options.method === "PUT").length, 0);
});

test("stale and unavailable automatic FX stay explicit and a refresh failure keeps the last asset view", async () => {
  const initial = stateWith([entry({ currency: "USD", amount: 10 })]);
  initial.portfolio.rates.USD = { value: 7, date: entry().asOf };
  initial.fx = { mode: "automatic", status: "stale", fetchedAt: "2026-10-24T08:00:00.000Z", source: "公开汇率", rates: { USD: { value: 7, date: entry().asOf, asOf: "2026-10-24T08:00:00.000Z", source: "公开汇率" } } };
  const ui = await view(initial, async (url) => url.endsWith("/rates/refresh") ? syncResponse({ error: "汇率服务暂时不可用" }, 503) : syncResponse(initial));
  assert.match(ui.get("asset-content").innerHTML, /汇率更新延迟/);
  await ui.run("refreshRates()");
  assert.equal(ui.run("summarize(portfolio()).total"), 70);
  assert.match(ui.get("asset-error").innerHTML, /汇率服务暂时不可用/);
  await ui.run("openRates(); refreshRates()");
  assert.match(ui.get("dialog-error").innerHTML, /汇率服务暂时不可用/);
  ui.run('state.fx.status="unavailable"; state.fx.rates={}; state.portfolio.rates={CNY:state.portfolio.rates.CNY}; render(); openRates()');
  assert.match(ui.get("asset-content").innerHTML, /自动汇率暂不可用/);
  assert.match(ui.get("dialog-body").innerHTML, /等待自动获取/);
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /手动填写|保存汇率/);
});

test("automatic rates distinguish retrieval time, daily references and independent stablecoin trade times", async () => {
  const initial = stateWith([entry({ currency: "USD" })]);
  initial.portfolio.rates.USD = { value: 7, date: "2026-10-24" };
  initial.portfolio.rates.HKD = { value: 0.9, date: "2026-10-23" };
  initial.portfolio.rates.USDT = { value: 6.99, date: "2026-10-24" };
  initial.fx = { mode: "automatic", status: "stale", fetchedAt: "2026-10-24T12:00:00.000Z", source: "Coinbase / Kraken", errors: ["HKD 使用日参考汇率。", '<img src=x>报价暂不可用'], rates: {
    USD: { value: 7, date: "2026-10-24", asOf: null, timeBasis: "retrieved", fetchedAt: "2026-10-24T12:00:00.000Z", source: "Coinbase", stale: false },
    HKD: { value: 0.9, date: "2026-10-23", asOf: null, timeBasis: "daily", fetchedAt: "2026-10-24T12:00:00.000Z", source: "ECB / Frankfurter（日参考）", stale: false },
    USDT: { value: 6.99, date: "2026-10-24", asOf: "2026-10-24T11:59:00.000Z", timeBasis: "market-and-retrieved", fetchedAt: "2026-10-24T12:00:00.000Z", source: "Kraken × Coinbase", fiatTimeBasis: "retrieved", stale: true }
  } };
  const ui = await view(initial);
  assert.match(ui.get("asset-content").innerHTML, /HKD 使用日参考汇率/);
  assert.match(ui.get("asset-content").innerHTML, /&lt;img src=x&gt;报价暂不可用/);
  ui.run("openRates()");
  const html = ui.get("dialog-body").innerHTML;
  assert.match(html, /<th>时间 \/ 来源<\/th>/);
  assert.match(html, /获取[^<]*20:00:00（源未提供报价时间）/);
  assert.match(html, /2026-10-23（日参考）/);
  assert.match(html, /最近成交[^<]*19:59:00/);
  assert.match(html, /Coinbase[\s\S]*?<td>自动汇率<\/td>/);
  assert.match(html, /Kraken × Coinbase[\s\S]*?<td>更新延迟<\/td>/);
  assert.doesNotMatch(html, /<img|尚未更新/);
});

test("twice-daily page refresh reads only visible pages without pending drafts, writes or conflicts", async () => {
  const ui = await view(stateWith());
  const timer = ui.intervals.find((item) => item.delay === 12 * 60 * 60 * 1000);
  assert.ok(timer);
  const initialReads = ui.requests.length;
  for (const condition of ['modal="manual"', "saving=true", "loading=true", "conflict=true", 'document.visibilityState="hidden"']) {
    ui.run('modal=null; saving=false; loading=false; conflict=false; document.visibilityState="visible"');
    ui.run(condition);
    await timer.handler();
    assert.equal(ui.requests.length, initialReads);
  }
  ui.run('modal=null; saving=false; loading=false; conflict=false; document.visibilityState="visible"');
  await timer.handler();
  assert.equal(ui.requests.length, initialReads + 1);
  assert.equal(ui.requests.at(-1).url, "/api/assets");
  assert.equal(ui.requests.at(-1).options.method, undefined);
});

test("overview leads with total, floating stock PnL and distributions before AI and collapsed source details", async () => {
  const initial = stateWith([entry({ amount: 500 })]);
  initial.portfolio.stockPnl = [{ accountId: "account-1", amount: -123.45, currency: "CNY", asOf: entry().asOf, source: "screenshot", asOfBasis: "imported" }];
  const ui = await view(initial);
  const html = ui.get("asset-content").innerHTML;
  assert.match(html, /股票浮动盈亏[\s\S]*-123\.45/);
  assert.match(html, /已含在当前市值中，不重复加减/);
  assert.match(html, /截图核对[\s\S]*截图时点未核实/);
  assert.ok(html.indexOf('class="metrics"') < html.indexOf('aria-label="资产类型"'));
  assert.ok(html.indexOf('aria-label="资产类型"') < html.indexOf('aria-label="AI 资产点评"'));
  assert.match(html, /<details class="source-details">/);
  assert.match(html, /09:00.*21:00/);
  assert.equal(ui.run("summarize(portfolio()).total"), 500);
  ui.run("hidden=true;render()");
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /123\.45|500\.00/);
});

test("stock PnL edits retain drafts under privacy and save signed amounts without changing market values", async () => {
  const initial = stateWith([entry({ category: "股票", amount: 500 })]);
  const ui = await view(initial);
  ui.run("openStockPnl()");
  assert.match(ui.get("dialog-body").innerHTML, /浮动盈亏（可为负数）/);
  await ui.listeners.input({ target: { dataset: { pnlAccount: "account-1", pnlField: "amount" }, value: "-80.25" } });
  ui.run("hidden=true;rerenderDialog()");
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /80\.25/);
  assert.equal(ui.run('stockPnlDraft["account-1"].amount'), "-80.25");
  ui.run("hidden=false;rerenderDialog()");
  assert.match(ui.get("dialog-body").innerHTML, /-80\.25/);
  await ui.run("saveStockPnl()");
  const saved = JSON.parse(ui.requests.find(row => row.options.method === "PUT").options.body);
  assert.equal(saved.portfolio.stockPnl[0].amount, -80.25);
  assert.deepEqual(saved.portfolio.entries, initial.portfolio.entries);
  assert.equal(ui.run("summarize(portfolio()).total"), 500);
  ui.run('page="overview";displayCurrency="USD";state.portfolio.rates.USD={value:5,date:currentDate()};render()');
  assert.match(ui.get("asset-content").innerHTML, /USD -16\.05/);
});

function categorizedState() {
  const initial = stateWith([
    entry({ id: "combined", name: "未拆分账户", category: "组合资产", amount: 100 }),
    entry({ id: "excluded-stock", name: "已包含在组合总额的股票", kind: "holding", category: "股票", amount: 40 }),
    entry({ id: "included-stock", accountId: "account-2", name: "已计入股票账户", category: "股票", amount: 50 }),
    entry({ id: "pending-stock", accountId: "account-3", name: "待确认股票账户", category: "股票", amount: 900 }),
    entry({ id: "missing-stock", accountId: "account-4", name: "缺汇率股票账户", category: "股票", currency: "USD", amount: 200 })
  ]);
  initial.portfolio.accounts[2].reviewStatus = "pending";
  return initial;
}

test("overview distinguishes asset types using accounted category values without counting component or pending records twice", async () => {
  const ui = await view(categorizedState());
  const html = ui.get("asset-content").innerHTML;
  assert.match(html, /aria-label="资产类型"/);
  assert.match(html, /data-category="组合资产"[\s\S]*?CNY 100\.00/);
  assert.match(html, /data-category="股票"[\s\S]*?CNY 50\.00/);
  assert.match(html, /66\.7%/);
  assert.match(html, /33\.3%/);
  assert.doesNotMatch(html, /CNY 990\.00|CNY 1,190\.00/);
  assert.match(html, /组合资产待拆分/);
  assert.match(html, /货币基金与现金分开/);
  assert.match(html, /稳定币与银行存款分开/);
  assert.match(html, /股票ETF与个股分开/);
  assert.match(html, /稳定币仅统计已识别部分/);
  assert.match(html, /分类金额各自四舍五入/);
});

test("type navigation filters holdings but shows pending, missing FX and excluded matches without summing their displayed rows", async () => {
  const ui = await view(categorizedState());
  await ui.listeners.click({ target: { closest: () => ({ disabled: false, dataset: { action: "category", category: "股票" } }) } });
  assert.equal(ui.run("page"), "holdings");
  const html = ui.get("asset-content").innerHTML;
  assert.match(html, /id="holding-category-filter"/);
  assert.match(html, /股票[\s\S]*?筛选后已计入[\s\S]*?CNY 50\.00/);
  assert.match(html, /已包含在组合总额的股票/);
  assert.match(html, /已计入股票账户/);
  assert.match(html, /待确认股票账户/);
  assert.match(html, /缺汇率股票账户/);
  assert.match(html, /口径排除/);
  assert.match(html, /待确认排除/);
  assert.match(html, /缺汇率/);
  assert.doesNotMatch(html, /class="name">未拆分账户</);
  await ui.listeners.change({ target: { id: "holding-category-filter", dataset: {}, value: "组合资产" } });
  assert.match(ui.get("asset-content").innerHTML, /class="name">未拆分账户</);
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /已计入股票账户/);
  await ui.listeners.click({ target: { closest: () => ({ disabled: false, dataset: { action: "clear-category" } }) } });
  assert.match(ui.get("asset-content").innerHTML, /class="name">未拆分账户</);
  assert.match(ui.get("asset-content").innerHTML, /已计入股票账户/);
  assert.equal(ui.requests.filter((request) => request.options.method).length, 0);
});

test("analysis links each asset type to details and retains the valuation-currency boundary", async () => {
  const ui = await view(categorizedState());
  ui.run('page="analysis"; render()');
  assert.match(ui.get("asset-content").innerHTML, /data-action="category" data-category="股票"/);
  assert.match(ui.get("asset-content").innerHTML, /data-action="category" data-category="组合资产"/);
  assert.match(ui.get("asset-content").innerHTML, /估值币种分布/);
  assert.match(ui.get("asset-content").innerHTML, /不代表实际外汇敞口/);
  assert.match(ui.get("asset-content").innerHTML, /组合资产待拆分/);
});

test("type cards and filtered totals respect privacy without leaking stored notes", async () => {
  const initial = categorizedState();
  initial.portfolio.accounts[1].note = "核对金额12345.67";
  initial.portfolio.entries[2].note = '<script>金额54321.09</script>';
  const ui = await view(initial);
  ui.run('hidden=true; render()');
  assert.match(ui.get("asset-content").innerHTML, /data-category="股票"/);
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /CNY 50\.00|CNY 100\.00|66\.7%|33\.3%|12345\.67|54321\.09/);
  await ui.listeners.click({ target: { closest: () => ({ disabled: false, dataset: { action: "category", category: "股票" } }) } });
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /50\.00|900\.00|200\.00|12345\.67|54321\.09|<script>/);
  assert.match(ui.get("asset-content").innerHTML, /筛选后已计入/);
});

test("platform atlas derives separate confirmed currencies from selected account bases and isolates pending amounts", async () => {
  const initial = stateWith([
    entry({ amount: 10, currency: "USD" }),
    entry({ id: "secondary", kind: "holding", amount: 700, currency: "CNY", name: "口径外" }),
    entry({ id: "hkd", accountId: "account-2", amount: 20, currency: "HKD" }),
    entry({ id: "pending", accountId: "account-3", amount: 999, currency: "USD" })
  ]);
  for (const account of initial.portfolio.accounts.slice(0, 3)) account.platform = "ZA Bank";
  initial.portfolio.accounts[2].reviewStatus = "pending";
  initial.portfolio.rates.USD = { value: 7, date: entry().asOf };
  initial.portfolio.rates.HKD = { value: 1, date: entry().asOf };
  const ui = await view(initial);
  const card = ui.run('platformCard("ZA Bank",1,summarize(portfolio()))');
  assert.match(card, /已确认原币[\s\S]*?HKD 20\.00[\s\S]*?USD 10\.00/);
  assert.match(card, /折合 CNY 90\.00/);
  assert.match(card, /待确认原币[\s\S]*?USD 999\.00/);
  assert.doesNotMatch(card, /USD 1,009\.00|CNY 700\.00/);
  assert.match(card, /data-action="correct-currency" data-platform="ZA Bank"/);
  ui.run('hidden=true; render()');
  assert.doesNotMatch(ui.run('platformCard("ZA Bank",1,summarize(portfolio()))'), /20\.00|10\.00|90\.00|999\.00/);
});

test("currency corrections save only the selected labels through CAS and retain original amounts and provenance", async () => {
  const original = entry({ asOfBasis: "imported", source: "screenshot", note: "需核对币种", amount: 77 });
  const initial = stateWith([original]);
  initial.revision = 8;
  const ui = await view(initial);
  await ui.listeners.click({ target: { closest: () => ({ disabled: false, dataset: { action: "correct-currency", platform: initial.portfolio.accounts[0].platform } }) } });
  assert.match(ui.get("dialog-body").innerHTML, /不自动兑换金额/);
  assert.match(ui.get("dialog-body").innerHTML, /缺少汇率.*排除/);
  await ui.listeners.input({ target: { dataset: { currencyEntry: "entry-1" }, value: "HKD" } });
  await ui.run("saveCurrencyCorrections()");
  const write = ui.requests.find((request) => request.options.method === "PUT");
  const body = JSON.parse(write.options.body);
  assert.equal(body.revision, 8);
  assert.deepEqual(body.portfolio.entries[0], { ...original, currency: "HKD" });
  assert.equal(body.portfolio.accounts[0].platform, initial.portfolio.accounts[0].platform);
  assert.equal(ui.get("asset-dialog").open, false);
});

test("manual currency identification leaves ambiguous text blank and respects manual corrections and saved labels", async () => {
  const ui = await view(stateWith([entry({ name: "美元资产 USD", currency: "HKD" })]));
  ui.run("openEntry()");
  assert.equal(ui.run("draft.currency"), "");
  await ui.listeners.input({ target: { dataset: { entryField: "name" }, value: "美元现金 USD" } });
  assert.equal(ui.run("draft.currency"), "USD");
  assert.match(ui.get("manual-currency-note").innerHTML, /已自动识别.*USD/);
  await ui.listeners.input({ target: { dataset: { entryField: "currency" }, value: "HKD" } });
  await ui.listeners.input({ target: { dataset: { entryField: "name" }, value: "美元现金 USD" } });
  assert.equal(ui.run("draft.currency"), "HKD");
  ui.run("openEntry()");
  await ui.listeners.input({ target: { dataset: { entryField: "name" }, value: "USDT" } });
  assert.equal(ui.run("draft.currency"), "");
  await ui.listeners.input({ target: { dataset: { entryField: "name" }, value: "USDT资产" } });
  assert.equal(ui.run("draft.currency"), "");
  await ui.listeners.input({ target: { dataset: { entryField: "name" }, value: "USDT 持仓市值" } });
  assert.equal(ui.run("draft.currency"), "");
  await ui.listeners.input({ target: { dataset: { entryField: "name" }, value: "USDT 计价" } });
  assert.equal(ui.run("draft.currency"), "USDT");
  await ui.listeners.input({ target: { dataset: { entryField: "name" }, value: "BTC" } });
  assert.equal(ui.run("draft.currency"), "");
  await ui.listeners.input({ target: { dataset: { entryField: "name" }, value: "账户余额 $100" } });
  assert.equal(ui.run("draft.currency"), "");
  assert.match(ui.get("manual-currency-note").innerHTML, /请手动选择/);
  ui.run("openEntry(state.portfolio.entries[0])");
  await ui.listeners.input({ target: { dataset: { entryField: "name" }, value: "美元现金 USD" } });
  assert.equal(ui.run("draft.currency"), "HKD");
});

test("screenshot candidate currency can be corrected before its confirmed save without conversion", async () => {
  const ui = await view();
  ui.run('openEntry(null,{label:"总资产 HKD 250",currency:"HKD",amount:250})');
  assert.equal(ui.run("draft.currency"), "HKD");
  await ui.listeners.input({ target: { dataset: { entryField: "currency" }, value: "USD" } });
  await ui.run('draft.name="截图账户"; screenshotConfirmed=true; saveEntry()');
  const body = JSON.parse(ui.requests.find((request) => request.options.method === "PUT").options.body);
  assert.equal(body.portfolio.entries[0].currency, "USD");
  assert.equal(body.portfolio.entries[0].amount, 250);
  assert.equal(body.portfolio.entries[0].source, "screenshot");
});

test("a token name never overwrites the screenshot's already identified valuation currency", async () => {
  const ui = await view();
  ui.run('openEntry(null,{label:"USDT 估值 USD 250",currency:"USD",amount:250})');
  await ui.listeners.input({ target: { dataset: { entryField: "name" }, value: "USDT" } });
  assert.equal(ui.run("draft.currency"), "USD");
  await ui.run('screenshotConfirmed=true; saveEntry()');
  const body = JSON.parse(ui.requests.find((request) => request.options.method === "PUT").options.body);
  assert.equal(body.portfolio.entries[0].currency, "USD");
  assert.equal(body.portfolio.entries[0].amount, 250);
  ui.run('openEntry(null,{label:"账户金额 HKD 77",currency:"HKD",amount:77})');
  await ui.listeners.input({ target: { dataset: { entryField: "name" }, value: "普通持仓名称" } });
  assert.equal(ui.run("draft.currency"), "HKD");
});

test("OCR candidates with deliberately unresolved currencies stay blank through the entry editor", async () => {
  const ui = await view();
  ui.run('openEntry(null, extractOcrCandidates("USDT 持仓市值 2419.17")[0])');
  assert.equal(ui.run("draft.currency"), "");
  await ui.run('screenshotConfirmed=true; saveEntry()');
  assert.equal(ui.requests.filter((request) => request.options.method === "PUT").length, 0);
  await ui.listeners.input({ target: { dataset: { entryField: "currency" }, value: "USD" } });
  await ui.run('screenshotConfirmed=true; saveEntry()');
  const body = JSON.parse(ui.requests.find((request) => request.options.method === "PUT").options.body);
  assert.equal(body.portfolio.entries[0].currency, "USD");
  assert.equal(body.portfolio.entries[0].amount, 2419.17);
});

test("currency correction conflicts preserve edits and reloading does not revert unchanged labels", async () => {
  const initial = stateWith([
    entry(),
    entry({ id: "unchanged", kind: "holding", name: "参考明细", currency: "USD", amount: 25 })
  ]);
  const latest = structuredClone(initial);
  latest.revision = 5;
  latest.portfolio.entries[1].currency = "EUR";
  let writes = 0;
  let reads = 0;
  const ui = await view(initial, async (_url, options) => {
    if (options.method === "PUT") {
      writes++;
      return writes === 1 ? { ok: false, status: 409, json: async () => ({ error: "conflict" }) } : { ok: true, status: 200, json: async () => ({ ...latest, revision: 6, portfolio: JSON.parse(options.body).portfolio }) };
    }
    return { ok: true, status: 200, json: async () => reads++ ? latest : initial };
  });
  await ui.run('openCurrencyCorrections(state.portfolio.accounts[0].platform); currencyDraft["entry-1"]="HKD"; saveCurrencyCorrections()');
  assert.equal(ui.run('currencyDraft["entry-1"]'), "HKD");
  assert.match(ui.get("dialog-error").innerHTML, /当前草稿仍保留/);
  await ui.run("saveCurrencyCorrections()");
  assert.equal(writes, 1);
  await ui.run("load();");
  await ui.run("saveCurrencyCorrections()");
  const body = JSON.parse(ui.requests.filter((request) => request.options.method === "PUT")[1].options.body);
  assert.equal(body.revision, 5);
  assert.equal(body.portfolio.entries[0].currency, "HKD");
  assert.equal(body.portfolio.entries[1].currency, "EUR");
  assert.equal(body.portfolio.entries[1].amount, 25);
});

test("overview and analysis render an accessible category pie using only accounted values with matching legend colors", async () => {
  const ui = await view(categorizedState());
  const pie = ui.run("assetTypeChart(summarize(portfolio()))");
  assert.match(pie, /<svg[^>]*role="img"[^>]*aria-labelledby="asset-type-pie-title asset-type-pie-description"/);
  assert.match(pie, /<title id="asset-type-pie-title">资产类型占比<\/title>/);
  assert.match(pie, /<desc id="asset-type-pie-description">/);
  assert.match(pie, /stroke-dasharray="66\.666667 33\.333333"/);
  assert.match(pie, /stroke-dasharray="33\.333333 66\.666667"/);
  const colors = [...pie.matchAll(/data-pie-category="([^"]+)"[^>]*stroke="(#[0-9a-f]{6})"/g)];
  assert.equal(colors.length, 2);
  for (const [, category, color] of colors) assert.ok(pie.includes(`data-category="${category}"`) && pie.includes(`background:${color}`));
  assert.doesNotMatch(pie, /990\.00|1,190\.00|900\.00|200\.00/);
  assert.ok(ui.get("asset-content").innerHTML.includes(pie.match(/<svg[\s\S]*?<\/svg>/)[0]));
  ui.run('page="analysis"; render()');
  assert.ok(ui.get("asset-content").innerHTML.includes(pie));
});

test("category pie handles empty, zero and single-category portfolios and removes geometry in privacy mode", async () => {
  const empty = await view();
  assert.match(empty.run("assetTypeChart(summarize(portfolio()))"), /暂无可绘制的资产类型金额/);
  const zero = await view(stateWith([entry({ amount: 0 })]));
  assert.doesNotMatch(zero.run("assetTypeChart(summarize(portfolio()))"), /<svg|NaN|Infinity/);
  const single = await view(stateWith([entry({ amount: 37.25, category: "现金" })]));
  const pie = single.run("assetTypeChart(summarize(portfolio()))");
  assert.match(pie, /stroke-dasharray="100\.000000 0\.000000"/);
  assert.match(pie, /现金[\s\S]*?100\.0%/);
  single.run("hidden=true; render()");
  const privatePie = single.run("assetTypeChart(summarize(portfolio()))");
  assert.doesNotMatch(privatePie, /<svg|stroke-dash|37\.25|100\.0%|aria-label="[^"\n]*%/);
  assert.match(privatePie, /分布及占比已隐藏/);
  assert.match(privatePie, /data-category="现金"/);
});

function syncStatus(overrides = {}) {
  return { serverIp: "173.199.122.23", providers: { okx: { connected: false, enabled: false }, futu: { connected: false, enabled: false }, polymarket: { connected: false, enabled: false }, future: { connected: false, enabled: false }, okxweb3: { connected: false, enabled: false }, tokenpocket: { connected: false, enabled: false }, ...overrides } };
}
function syncResponse(data, status = 200) { return { ok: status < 400, status, json: async () => data }; }
function syncPreviewState() {
  return syncStatus({ okx: { connected: true, enabled: false, accountLabel: "只读交易所账户", preview: { id: "preview-1", provider: "okx", currency: "USD", total: 123.45, asOf: "2026-10-24", fetchedAt: "2026-10-24T12:00:00.000Z", targetAccountId: "account-1", revision: 0, countedBasis: "total", holdings: [{ name: '<img src=x>BTC', category: "加密资产", currency: "USD", amount: 23.45 }], coverage: ["交易账户"], warnings: ["未展开金额100.00，不与总额相加"] } } });
}

test("read-only sync opens lazily and explains the exact OKX authorization and account boundary", async () => {
  const ui = await view(stateWith(), async (url) => syncResponse(url === "/api/assets" ? stateWith() : syncStatus()));
  assert.equal(ui.requests.length, 1);
  await ui.run("openSync()");
  assert.equal(ui.requests[1].url, "/api/assets/sync");
  const html = ui.get("dialog-body").innerHTML;
  assert.match(html, /尚未授权/);
  assert.match(html, /Read（读取）/);
  assert.match(html, /173\.199\.122\.23/);
  assert.match(html, /不包含 OKX Web3 钱包/);
  assert.match(html, /账户所属地区/);
  for (const id of ["sync-okx-key", "sync-okx-secret", "sync-okx-passphrase"]) assert.match(html, new RegExp(`id="${id}" type="password"`));
  assert.equal(ui.requests.filter((request) => request.options.method).length, 0);
});

test("OKX credentials stay outside asset drafts and exports and are cleared after validation and close", async () => {
  const storageWrites = [];
  const ui = await view(stateWith(), async (url) => syncResponse(url === "/api/assets" ? stateWith() : url.endsWith("/connect") ? syncPreviewState() : syncStatus()), { storage: { getItem: () => null, setItem: (...values) => storageWrites.push(values) } });
  await ui.run("openSync()");
  ui.get("sync-okx-key").value = "test-key-only";
  ui.get("sync-okx-secret").value = "test-secret-only";
  ui.get("sync-okx-passphrase").value = "test-passphrase-only";
  ui.get("sync-okx-region").value = "global";
  ui.run('var exportedJson=""; download=(text)=>{exportedJson=text}; exportJson()');
  assert.doesNotMatch(ui.run("exportedJson"), /test-key-only|test-secret-only|test-passphrase-only/);
  await ui.run("connectOkx()");
  const write = ui.requests.find((request) => request.url.endsWith("/connect"));
  assert.deepEqual(JSON.parse(write.options.body), { apiKey: "test-key-only", secret: "test-secret-only", passphrase: "test-passphrase-only", region: "global", targetAccountId: "account-5" });
  assert.equal(ui.run("state.revision"), 0);
  assert.match(ui.get("dialog-body").innerHTML, /已授权 · 待核对入账/);
  assert.equal(ui.get("sync-okx-secret").value, "");
  assert.equal(ui.requests.filter((request) => request.url.endsWith("/apply")).length, 0);
  ui.get("sync-okx-secret").value = "abandoned-secret";
  ui.run("closeDialog()");
  assert.equal(ui.get("sync-okx-secret").value, "");
  assert.equal(ui.get("dialog-body").innerHTML, "");
  assert.doesNotMatch(source, /sessionStorage|localStorage\.(?:clear|removeItem|key)/);
  assert.deepEqual(storageWrites, []);
});

test("sync previews escape upstream labels and respect amount privacy including warnings", async () => {
  const ui = await view(stateWith(), async (url) => syncResponse(url === "/api/assets" ? stateWith() : syncPreviewState()));
  await ui.run("openSync()");
  const html = ui.get("dialog-body").innerHTML;
  assert.match(html, /USD 123\.45/);
  assert.match(html, /&lt;img src=x&gt;BTC/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /账户总额和持仓明细不重复计入/);
  assert.match(html, /手动修改此账户后，自动同步会暂停/);
  ui.run("hidden=true; renderSync()");
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /123\.45|23\.45|100\.00|未展开金额/);
  assert.match(ui.get("dialog-body").innerHTML, /隐私模式已隐藏覆盖详情/);
});

test("preview application sends its revision once and loads the returned ledger and sync status", async () => {
  const initial = stateWith();
  const applied = { ...initial, revision: 1, portfolio: { ...initial.portfolio, entries: [entry({ amount: 123.45 })] } };
  const enabled = syncStatus({ okx: { connected: true, enabled: true, lastAppliedAt: "2026-10-24T12:00:00.000Z" } });
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : url.endsWith("/apply") ? { sync: enabled, assets: applied } : syncPreviewState()));
  await ui.run('openSync();');
  await ui.run('applySyncPreview("okx")');
  const request = ui.requests.find((item) => item.url.endsWith("/apply"));
  assert.deepEqual(JSON.parse(request.options.body), { previewId: "preview-1", revision: 0 });
  assert.equal(ui.run("state.revision"), 1);
  assert.equal(ui.run("state.portfolio.entries[0].amount"), 123.45);
  assert.match(ui.get("dialog-body").innerHTML, /自动同步已开启/);
  assert.equal(ui.requests.filter((item) => item.options.method === "PUT").length, 0);
});

test("stale sync previews cannot apply and authorization failures never become connected", async () => {
  const ui = await view(stateWith(), async (url) => url.endsWith("/connect") ? syncResponse({ error: "需要仅 Read 权限" }, 400) : syncResponse(url === "/api/assets" ? stateWith() : syncPreviewState()));
  await ui.run("openSync()");
  ui.run("state.revision=2; renderSync()");
  await ui.run('applySyncPreview("okx")');
  assert.equal(ui.requests.filter((request) => request.url.endsWith("/apply")).length, 0);
  assert.match(ui.get("dialog-error").innerHTML, /重新获取预览/);
  ui.run('syncState.providers.okx={connected:false,enabled:false}; renderSync()');
  for (const id of ["sync-okx-key", "sync-okx-secret", "sync-okx-passphrase"]) ui.get(id).value = "test-only";
  ui.get("sync-okx-region").value = "global";
  await ui.run("connectOkx()");
  assert.equal(ui.run("syncState.providers.okx.connected"), false);
  assert.match(ui.get("dialog-body").innerHTML, /需要仅 Read 权限/);
  assert.equal(ui.get("sync-okx-secret").value, "");
});

test("Futu authorizes through the official HTTPS URL and refuses unexpected destinations", async () => {
  let authUrl = "https://webapi.futunn.com/oauth2/authorize/confirm?state=test-state";
  const ui = await view(stateWith(), async (url) => syncResponse(url === "/api/assets" ? stateWith() : url.endsWith("/authorize") ? { authorizationUrl: authUrl } : syncStatus()));
  await ui.run("openSync()");
  ui.get("sync-okx-secret").value = "abandoned-secret";
  await ui.run("authorizeFutu()");
  assert.deepEqual(ui.navigations, [authUrl]);
  assert.equal(ui.get("sync-okx-secret").value, "");
  authUrl = "https://futunn.com.evil.invalid/steal";
  await ui.run("authorizeFutu()");
  assert.equal(ui.navigations.length, 1);
  assert.match(ui.get("dialog-body").innerHTML, /授权地址无效/);
  authUrl = "https://webapi.futunn.com/other-path";
  await ui.run("authorizeFutu()");
  assert.equal(ui.navigations.length, 1);
});

test("Futu account changes discard the old preview, refresh the chosen account and disconnect preserves assets", async () => {
  const initial = stateWith([entry()]);
  const connected = syncStatus({ futu: { connected: true, enabled: false, accounts: [{ id: "real-1", label: "真实账户1" }, { id: "real-2", label: "真实账户2" }], preview: { ...syncPreviewState().providers.okx.preview, provider: "futu" } } });
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : url.endsWith("/disconnect") ? syncStatus() : connected));
  await ui.run("openSync()");
  await ui.listeners.change({ target: { id: "sync-futu-account", dataset: {}, value: "real-2" } });
  assert.equal(ui.run("syncState.providers.futu.preview"), undefined);
  await ui.run('refreshSyncPreview("futu")');
  const preview = ui.requests.find((request) => request.url.endsWith("/preview"));
  assert.deepEqual(JSON.parse(preview.options.body), { targetAccountId: "account-3", accountId: "real-2" });
  await ui.listeners.click({ target: { closest: () => ({ disabled: false, dataset: { action: "sync-disconnect", provider: "futu" } }) } });
  assert.equal(ui.run("state.portfolio.entries[0].amount"), 1234.56);
  assert.equal(ui.run("syncState.providers.futu.connected"), false);
  assert.match(ui.get("asset-message").textContent, /已入账资产与历史快照保留/);
  assert.match(ui.get("asset-message").textContent, /官方授权请到对应平台撤销/);
});

test("opening sync refreshes a ledger advanced by the server and disconnected provider errors stay visible", async () => {
  const initial = stateWith();
  const latest = { ...initial, revision: 4 };
  const status = syncPreviewState();
  status.providers.okx.preview.revision = 4;
  status.providers.futu.lastError = "授权已撤销，请重新授权";
  let reads = 0;
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? reads++ ? latest : initial : status));
  assert.equal(ui.run("state.revision"), 0);
  await ui.run("openSync()");
  assert.equal(ui.run("state.revision"), 4);
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /资产记录已变化/);
  assert.match(ui.get("dialog-body").innerHTML, /授权已撤销，请重新授权/);
  ui.run('syncState.providers.okx.preview.total="<img src=x>"; renderSync()');
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /<img/);
});

test("Futu callback opens sync and only confirms authorization using freshly read server status", async () => {
  const connected = syncStatus({ futu: { connected: true, enabled: false, accounts: [{ id: "real-1", label: "真实账户1" }] } });
  const authorized = await view(stateWith(), async (url) => syncResponse(url === "/api/assets" ? stateWith() : connected), { search: "?sync=futu-authorized" });
  assert.equal(authorized.run("modal"), "sync");
  assert.match(authorized.get("asset-message").textContent, /富途只读授权已完成/);
  authorized.run("closeDialog()");
  await authorized.intervals[0].handler();
  assert.equal(authorized.run("modal"), null);
  const failed = await view(stateWith(), async (url) => syncResponse(url === "/api/assets" ? stateWith() : syncStatus()), { search: "?sync=futu-error" });
  assert.equal(failed.run("modal"), "sync");
  assert.match(failed.get("dialog-body").innerHTML, /富途授权未完成/);
  assert.doesNotMatch(failed.get("asset-message").textContent, /授权已完成/);
});

test("Polymarket connects a public address to an explicit local target without writing the ledger", async () => {
  const initial = stateWith();
  initial.portfolio.accounts = initial.portfolio.accounts.filter((account) => account.platform !== "Polymarket");
  const address = `0x${"4".repeat(40)}`;
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : syncStatus({ polymarket: { connected: false, enabled: false } })));
  await ui.run("openSync()");
  assert.match(ui.get("dialog-body").innerHTML, /Polymarket/);
  assert.match(ui.get("dialog-body").innerHTML, /公开持仓地址/);
  assert.match(ui.get("dialog-body").innerHTML, /不需要私钥、助记词或签名/);
  ui.get("sync-polymarket-address").value = address;
  await ui.run("connectPolymarket()");
  const request = ui.requests.find((item) => item.url.endsWith("/polymarket/connect"));
  assert.deepEqual(JSON.parse(request.options.body), { address, targetAccountId: "polymarket-main" });
  assert.equal(ui.requests.filter((item) => item.options.method === "PUT").length, 0);
});

test("local target selection discards a preview and binds updates to the chosen existing account", async () => {
  const initial = stateWith();
  initial.portfolio.accounts = initial.portfolio.accounts.filter((account) => account.platform !== "Polymarket");
  initial.portfolio.accounts.push({ id: "pm-existing", platform: "Polymarket", name: "现有预测账户", basis: "total", reviewStatus: "confirmed" });
  const status = syncStatus({ polymarket: { connected: true, enabled: false, preview: { ...syncPreviewState().providers.okx.preview, provider: "polymarket", targetAccountId: "pm-existing" } } });
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : status));
  await ui.run("openSync()");
  await ui.listeners.change({ target: { id: "sync-polymarket-target", dataset: { syncTarget: "polymarket" }, value: "pm-existing" } });
  assert.equal(ui.run("syncState.providers.polymarket.preview"), undefined);
  await ui.run('refreshSyncPreview("polymarket")');
  const request = ui.requests.find((item) => item.url.endsWith("/preview"));
  assert.deepEqual(JSON.parse(request.options.body), { targetAccountId: "pm-existing" });
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /新建 Polymarket 账户/);
});

test("asset overview and holdings distinguish source time, retrieval, overdue and unconnected sources", async () => {
  const initial = stateWith([entry({ source: "api", asOfBasis: "imported" })]);
  initial.sync = syncStatus({ okx: { connected: true, enabled: true, targetAccountId: "account-1", overdue: true, lastAttemptAt: "2026-10-24T12:16:00.000Z", lastFetchedAt: "2026-10-24T12:00:00.000Z", lastAppliedAt: "2026-10-24T12:00:01.000Z", observedAt: "2026-10-24T11:59:59.000Z", timeBasis: "source", lastError: '<img src=x>接口超时' } });
  const ui = await view(initial);
  assert.match(ui.get("asset-content").innerHTML, /自动同步覆盖/);
  assert.match(ui.get("asset-content").innerHTML, /更新延迟/);
  ui.run('page="holdings"; render()');
  const html = ui.get("asset-content").innerHTML;
  assert.match(html, /源资产时点/);
  assert.match(html, /最近成功读取/);
  assert.match(html, /最近成功入账/);
  assert.match(html, /尚未接入自动同步/);
  assert.match(html, /读取日期 · 源未提供资产时点/);
  assert.doesNotMatch(html, /截图日期未核实|<img/);
  ui.run("hidden=true; render()");
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /接口超时/);
});

test("reopening Futu sync preserves the bound real account instead of silently switching to the first one", async () => {
  const initial = stateWith();
  const connected = syncStatus({ futu: { connected: true, enabled: true, targetAccountId: "account-3", selectedAccountId: "real-2", accounts: [{ id: "real-1", label: "First account" }, { id: "real-2", label: "Bound account" }] } });
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : connected));
  await ui.run("openSync()");
  assert.equal(ui.run("syncAccountId"), "real-2");
  await ui.run('refreshSyncPreview("futu")');
  const preview = ui.requests.find((request) => request.url.endsWith("/preview"));
  assert.deepEqual(JSON.parse(preview.options.body), { targetAccountId: "account-3", accountId: "real-2" });
});

test("Future uses its verified Polygon trading account and never submits a Solana deposit address as a holding wallet", async () => {
  const initial = stateWith();
  initial.portfolio.accounts = initial.portfolio.accounts.filter((account) => account.platform !== "Future");
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : syncStatus()));
  await ui.run("openSync()");
  assert.match(ui.get("dialog-body").innerHTML, /Solana 充值地址/);
  assert.match(ui.get("dialog-body").innerHTML, /不含未到账的充值/);
  ui.get("sync-future-address").value = "synthetic-solana-deposit-address";
  await ui.run("connectFuture()");
  assert.equal(ui.requests.filter((item) => item.url.endsWith("/future/connect")).length, 0);
  ui.get("sync-future-address").value = `0x${"3".repeat(40)}`;
  await ui.run("connectFuture()");
  const request = ui.requests.find((item) => item.url.endsWith("/future/connect"));
  assert.deepEqual(JSON.parse(request.options.body), { address: `0x${"3".repeat(40)}`, targetAccountId: "future-main" });
});

test("unavailable sync metadata leaves asset values visible and connection coverage explicitly unknown", async () => {
  const initial = stateWith([entry()]);
  initial.sync = { status: "unavailable", providers: {} };
  const ui = await view(initial);
  assert.match(ui.get("asset-content").innerHTML, /1,234\.56/);
  assert.match(ui.get("asset-content").innerHTML, /自动同步覆盖当前未核实/);
  ui.run('page="holdings"; render()');
  assert.match(ui.get("asset-content").innerHTML, /当前连接与自动刷新状态未核实/);
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /尚未接入自动同步/);
});

test("applied valuation provenance remains visible after previews are removed and is hidden with amounts", async () => {
  const initial = stateWith([entry()]);
  initial.sync = syncStatus({ polymarket: { connected: true, enabled: true, targetAccountId: "account-1", lastCoverage: ["含全部碎仓"], lastWarnings: ['<img src=x>源口径说明'], lastValuation: { sourceCurrency: "USDC", sourceAmount: 97.654321, usdPrice: 0.998123, quoteObservedAt: "2026-10-24T12:00:00Z" } } });
  const ui = await view(initial);
  ui.run('page="holdings"; render()');
  const html = ui.get("asset-content").innerHTML;
  assert.match(html, /源估值 USDC 97\.654321/);
  assert.match(html, /USD 报价 0\.998123/);
  assert.match(html, /报价时点/);
  assert.match(html, /含全部碎仓/);
  assert.doesNotMatch(html, /<img/);
  ui.run("hidden=true; render()");
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /97\.654321|0\.998123|含全部碎仓|源口径说明/);
});

test("reopened Futu preview keeps its external account visible before application", async () => {
  const initial = stateWith();
  const status = syncStatus({ futu: { connected: true, enabled: false, targetAccountId: "account-3", selectedAccountId: "real-1", accounts: [{ id: "real-1", label: "Old account" }, { id: "real-2", label: "Preview account" }], preview: { ...syncPreviewState().providers.okx.preview, provider: "futu", externalAccountId: "real-2", targetAccountId: "account-3" } } });
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : status));
  await ui.run("openSync()");
  assert.equal(ui.run("syncAccountId"), "real-2");
  assert.match(ui.get("dialog-body").innerHTML, /value="real-2" selected/);
  ui.run('syncAccountId="real-1"');
  await ui.run('applySyncPreview("futu")');
  assert.equal(ui.requests.filter((item) => item.url.endsWith("/apply")).length, 0);
});

test("failed sync status reload adopts readable assets and removes stale connected previews", async () => {
  const initial = stateWith([entry()]);
  let statusFails = false;
  const latest = { ...initial, revision: 2, sync: { status: "unavailable", providers: {} } };
  const ui = await view(initial, async (url) => url === "/api/assets" ? syncResponse(statusFails ? latest : initial) : statusFails ? syncResponse({ error: "同步配置不可读取" }, 500) : syncResponse(syncPreviewState()));
  await ui.run("openSync()");
  statusFails = true;
  await ui.run("openSync()");
  assert.equal(ui.run("state.revision"), 2);
  assert.equal(ui.run("state.sync.status"), "unavailable");
  assert.equal(ui.run("syncState"), null);
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /已授权 · 待核对入账|data-action="sync-apply"/);
  assert.match(ui.get("asset-content").innerHTML, /自动同步覆盖当前未核实/);
});

function walletState(entries = []) {
  const initial = stateWith(entries);
  initial.portfolio.accounts[4].name = "OKX 交易所";
  initial.portfolio.accounts.push({ id: "okx-web3", platform: "OKX", name: "OKX Web3 钱包", basis: "holdings", reviewStatus: "confirmed" });
  return initial;
}
function walletStatus(overrides = {}) {
  return syncStatus({ okxweb3: { connected: false, enabled: false, targetAccountId: "okx-web3", wallets: [{ chainIndex: "1", address: `0x${"1".repeat(40)}` }, { chainIndex: "501", address: "11111111111111111111111111111111" }], ...overrides }, tokenpocket: { connected: false, enabled: false, targetAccountId: "account-10", wallets: [{ chainIndex: "137", address: `0x${"2".repeat(40)}` }] } });
}

test("wallet sync cards distinguish Developer credentials and preserve bound networks and local account boundaries", async () => {
  const initial = walletState();
  initial.portfolio.accounts.push({ id: "english-wallet", platform: "OKX", name: "OKX Wallet", basis: "holdings", reviewStatus: "confirmed" });
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : walletStatus()));
  await ui.run("openSync()");
  const html = ui.get("dialog-body").innerHTML;
  assert.match(html, /OKX Web3 钱包只读同步/);
  assert.match(html, /TokenPocket只读同步/);
  assert.match(html, /Developer API/);
  assert.match(html, /交易所.*API.*不同|不同于.*交易所/);
  assert.match(html, /不需要钱包私钥、助记词/);
  assert.match(html, /不复制.*Agentic.*session/i);
  for (const provider of ["okxweb3", "tokenpocket"]) {
    for (const field of ["key", "secret", "passphrase"]) assert.match(html, new RegExp(`id="sync-${provider}-${field}" type="password"`));
    for (const chain of ["1", "501", "137"]) assert.match(html, new RegExp(`id="sync-${provider}-address-${chain}"`));
  }
  assert.match(html, /value="0x1111111111111111111111111111111111111111"/);
  const walletTarget = ui.run('syncTargetControl("okxweb3",syncState.providers.okxweb3)');
  assert.match(walletTarget, /value="okx-web3" selected/);
  assert.match(walletTarget, /value="english-wallet"/);
  assert.doesNotMatch(walletTarget, /value="account-5"/);
  const exchangeTarget = ui.run('syncTargetControl("okx",syncState.providers.okx)');
  assert.match(exchangeTarget, /value="account-5"/);
  assert.doesNotMatch(exchangeTarget, /value="okx-web3"/);
  assert.doesNotMatch(exchangeTarget, /value="english-wallet"/);
  assert.equal(ui.requests.filter((request) => request.options.method).length, 0);
});

test("wallet credentials submit only once with explicit nonempty bindings and never enter drafts, storage or exports", async () => {
  const initial = walletState();
  const writes = [];
  let release;
  const ui = await view(initial, async (url) => url.endsWith("/okxweb3/connect") ? new Promise((resolve) => { release = () => resolve(syncResponse(walletStatus({ connected: true }))); }) : syncResponse(url === "/api/assets" ? initial : walletStatus()), { storage: { getItem: () => null, setItem: (...args) => writes.push(args) } });
  await ui.run("openSync()");
  for (const [field, value] of [["key", "developer-key-fixture"], ["secret", "developer-secret-fixture"], ["passphrase", "developer-passphrase-fixture"]]) ui.get(`sync-okxweb3-${field}`).value = value;
  ui.get("sync-okxweb3-address-1").value = `0x${"1".repeat(40)}`;
  ui.get("sync-okxweb3-address-501").value = "11111111111111111111111111111111";
  ui.get("sync-okxweb3-address-137").value = "";
  ui.run('var exportedWalletJson=""; download=(text)=>{exportedWalletJson=text}; exportJson()');
  assert.doesNotMatch(ui.run("exportedWalletJson"), /developer-(?:key|secret|passphrase)-fixture/);
  const pending = ui.run('connectWallet("okxweb3")');
  assert.equal(ui.get("sync-okxweb3-secret").value, "");
  const request = ui.requests.find((item) => item.url.endsWith("/okxweb3/connect"));
  assert.deepEqual(JSON.parse(request.options.body), { apiKey: "developer-key-fixture", secret: "developer-secret-fixture", passphrase: "developer-passphrase-fixture", wallets: [{ chainIndex: "1", address: `0x${"1".repeat(40)}` }, { chainIndex: "501", address: "11111111111111111111111111111111" }], targetAccountId: "okx-web3" });
  release();
  await pending;
  assert.equal(ui.run("draft"), null);
  assert.equal(ui.run("state.revision"), 0);
  assert.equal(ui.requests.filter((item) => item.url.endsWith("/apply")).length, 0);
  ui.get("sync-tokenpocket-secret").value = "abandoned-wallet-secret";
  ui.run("renderSync()");
  assert.equal(ui.get("sync-tokenpocket-secret").value, "");
  ui.get("sync-tokenpocket-passphrase").value = "abandoned-passphrase";
  ui.run("closeDialog()");
  assert.equal(ui.get("sync-tokenpocket-passphrase").value, "");
  assert.deepEqual(writes, []);
});

test("wallet binding validation rejects mixed network addresses and clears credentials on failure", async () => {
  const initial = walletState();
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : walletStatus()));
  await ui.run("openSync()");
  for (const field of ["key", "secret", "passphrase"]) ui.get(`sync-tokenpocket-${field}`).value = "fixture-only";
  ui.get("sync-tokenpocket-address-137").value = "11111111111111111111111111111111";
  await ui.run('connectWallet("tokenpocket")');
  assert.equal(ui.requests.filter((item) => item.url.endsWith("/connect")).length, 0);
  assert.match(ui.get("dialog-error").innerHTML, /Polygon.*地址/);
  assert.equal(ui.get("sync-tokenpocket-secret").value, "");
  ui.run('hidden=true; renderSync()');
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /value="0x2222222222222222222222222222222222222222"/);
});

function unpricedFixture() {
  return { chainIndex: "501", contract: "synthetic-mint", symbol: "UNKNOWN", name: '<img src=x>未知代币', quantity: "123456789.123456789", reason: "独立报价过期，未核算" };
}

test("wallet previews keep exact unpriced quantities separate from the priced subtotal and hide the full list in privacy mode", async () => {
  const initial = walletState();
  const preview = { ...syncPreviewState().providers.okx.preview, provider: "okxweb3", targetAccountId: "okx-web3", total: 23.45, valuationComplete: false, unpricedAssets: [unpricedFixture()] };
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : walletStatus({ connected: true, preview })));
  await ui.run("openSync()");
  const html = ui.get("dialog-body").innerHTML;
  assert.match(html, /已定价部分合计/);
  assert.match(html, /USD 23\.45/);
  assert.match(html, /估值不完整/);
  assert.match(html, /123456789\.123456789/);
  assert.match(html, /&lt;img src=x&gt;未知代币/);
  assert.match(html, /独立报价过期，未核算/);
  assert.match(html, /NFT.*DeFi/);
  assert.doesNotMatch(html, /<img|UNKNOWN[^<]*USD 0\.00/);
  ui.run("hidden=true; renderSync()");
  assert.doesNotMatch(ui.get("dialog-body").innerHTML, /123456789|UNKNOWN|synthetic-mint|未知代币|独立报价过期/);
  assert.match(ui.get("dialog-body").innerHTML, /隐私模式已隐藏未估值资产/);
  ui.run('hidden=false; syncState.providers.okxweb3.preview.total=0; syncState.providers.okxweb3.preview.holdings=[]; renderSync()');
  const emptyPreview = ui.run('syncPreview("okxweb3",syncState.providers.okxweb3)');
  assert.match(emptyPreview, /USD —/);
  assert.doesNotMatch(emptyPreview, /USD 0\.00/);
});

test("applied partial valuation changes overview coverage and preserves unknown quantities on empty wallet accounts", async () => {
  const initial = walletState();
  initial.sync = walletStatus({ connected: true, enabled: true, lastAppliedAt: "2026-10-24T12:00:00Z", lastValuationComplete: false, lastUnpricedAssets: [unpricedFixture()] });
  const ui = await view(initial);
  const html = ui.get("asset-content").innerHTML;
  assert.match(html, /已核算资产 · 部分估值/);
  assert.match(html, /<small>¥<\/small>—/);
  assert.match(html, /1 项未估值/);
  assert.match(html, /协议资产待核实/);
  assert.match(html, /1 \/ 1 个已录入账户完成首次同步/);
  assert.doesNotMatch(html, /尚未录入真实金额|<small>¥<\/small>0\.00/);
  const card = ui.run('platformCard("OKX",4,summarize(portfolio()))');
  assert.match(card, /已记录未估值资产/);
  assert.doesNotMatch(card, /尚未录入|USD 0\.00|CNY 0\.00/);
  ui.run('page="holdings"; render()');
  assert.match(ui.get("asset-content").innerHTML, /123456789\.123456789/);
  assert.match(ui.get("asset-content").innerHTML, /已记录未估值资产/);
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /<img/);
  ui.run('hidden=true; render()');
  assert.doesNotMatch(ui.get("asset-content").innerHTML, /123456789|UNKNOWN|synthetic-mint|未知代币|独立报价过期/);
});

test("partial priced ledgers keep chart totals numeric and exports disclose their metadata boundary", async () => {
  const initial = walletState([entry({ accountId: "okx-web3", kind: "holding", name: "已定价原生币", category: "加密资产", amount: 50 })]);
  initial.sync = walletStatus({ connected: false, enabled: false, lastAppliedAt: "2026-10-24T12:00:00Z", lastValuationComplete: false, lastUnpricedAssets: [unpricedFixture()] });
  const ui = await view(initial);
  assert.equal(ui.run("summarize(portfolio()).total"), 50);
  assert.match(ui.get("asset-content").innerHTML, /已核算资产 · 部分估值/);
  assert.match(ui.get("asset-content").innerHTML, /<small>¥<\/small>50\.00/);
  ui.run('page="analysis"; render()');
  assert.match(ui.get("asset-content").innerHTML, /仅含已定价/);
  ui.run("openExport()");
  assert.match(ui.get("dialog-body").innerHTML, /CSV[\s\S]*未估值/);
  assert.match(ui.get("dialog-body").innerHTML, /JSON[\s\S]*来源.*未估值/);
  ui.run('var walletExport=""; download=(text)=>{walletExport=text}; exportCsv()');
  assert.doesNotMatch(ui.run("walletExport"), /UNKNOWN|123456789/);
  ui.run("exportJson()");
  assert.match(ui.run("walletExport"), /123456789\.123456789/);
});

test("TokenPocket form submits its edited Polygon binding and wallet preview and disconnect preserve the asset ledger", async () => {
  const initial = walletState([entry()]);
  const status = walletStatus();
  let ui;
  ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : status));
  await ui.run("openSync()");
  for (const field of ["key", "secret", "passphrase"]) ui.get(`sync-tokenpocket-${field}`).value = "developer-fixture";
  ui.get("sync-tokenpocket-address-137").value = `0x${"3".repeat(40)}`;
  await ui.listeners.submit({ target: { id: "sync-tokenpocket-form" }, preventDefault() {} });
  const connect = ui.requests.find((item) => item.url.endsWith("/tokenpocket/connect"));
  assert.deepEqual(JSON.parse(connect.options.body).wallets, [{ chainIndex: "137", address: `0x${"3".repeat(40)}` }]);
  assert.equal(JSON.parse(connect.options.body).targetAccountId, "account-10");
  await ui.run('refreshSyncPreview("tokenpocket")');
  assert.deepEqual(JSON.parse(ui.requests.find((item) => item.url.endsWith("/tokenpocket/preview")).options.body), { targetAccountId: "account-10" });
  await ui.listeners.click({ target: { closest: () => ({ disabled: false, dataset: { action: "sync-disconnect", provider: "tokenpocket" } }) } });
  assert.ok(ui.requests.some((item) => item.url.endsWith("/tokenpocket/disconnect")));
  assert.equal(ui.run("state.portfolio.entries[0].amount"), 1234.56);
  assert.equal(ui.requests.filter((item) => item.options.method === "PUT").length, 0);
});

test("applying an unknown-only wallet preview adopts its source metadata without creating a zero asset", async () => {
  const initial = walletState();
  const preview = { ...syncPreviewState().providers.okx.preview, provider: "okxweb3", targetAccountId: "okx-web3", total: 0, holdings: [], countedBasis: "holdings", valuationComplete: false, unpricedAssets: [unpricedFixture()] };
  const pending = walletStatus({ connected: true, preview });
  const applied = walletStatus({ connected: true, enabled: true, lastAppliedAt: "2026-10-24T12:00:00Z", lastValuationComplete: false, lastUnpricedAssets: [unpricedFixture()] });
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : url.endsWith("/okxweb3/apply") ? { assets: { ...initial, revision: 1 }, sync: applied } : pending));
  await ui.run("openSync()");
  await ui.run('applySyncPreview("okxweb3")');
  const request = ui.requests.find((item) => item.url.endsWith("/okxweb3/apply"));
  assert.deepEqual(JSON.parse(request.options.body), { previewId: "preview-1", revision: 0 });
  assert.equal(ui.run("state.revision"), 1);
  assert.equal(ui.run("state.portfolio.entries.length"), 0);
  assert.equal(ui.run("state.sync.providers.okxweb3.lastValuationComplete"), false);
  assert.match(ui.get("asset-content").innerHTML, /<small>¥<\/small>—/);
  assert.match(ui.get("dialog-body").innerHTML, /自动同步已开启/);
});

test("disconnected wallet cards retain the last applied unknown quantities and time without claiming automatic updates", async () => {
  const initial = walletState();
  const status = walletStatus({ connected: false, enabled: false, lastAppliedAt: "2026-10-24T12:00:00Z", lastFetchedAt: "2026-10-24T11:59:00Z", lastValuationComplete: false, lastUnpricedAssets: [unpricedFixture()], lastCoverage: ["上次入账网络范围"] });
  initial.sync = status;
  const ui = await view(initial, async (url) => syncResponse(url === "/api/assets" ? initial : status));
  await ui.run("openSync()");
  const card = ui.run('syncProviderCard("okxweb3")');
  assert.match(card, /已断开本站同步/);
  assert.match(card, /上次入账.*自动刷新已停止/);
  assert.match(card, /最近成功入账/);
  assert.match(card, /123456789\.123456789/);
  assert.match(card, /上次入账网络范围/);
  assert.match(card, /id="sync-okxweb3-key" type="password"/);
  assert.doesNotMatch(card, /自动同步已开启|data-action="sync-apply"|<img/);
  assert.match(ui.get("asset-content").innerHTML, /<small>¥<\/small>—/);
  assert.equal(ui.requests.filter((item) => item.options.method).length, 0);
  ui.run("hidden=true; renderSync()");
  const hiddenCard = ui.run('syncProviderCard("okxweb3")');
  assert.match(hiddenCard, /已断开本站同步/);
  assert.match(hiddenCard, /隐私模式已隐藏未估值资产/);
  assert.doesNotMatch(hiddenCard, /123456789|UNKNOWN|synthetic-mint|未知代币|独立报价过期|上次入账网络范围/);
});

test("HKD base uses the current quote across views and preserves native records and frozen history", async () => {
  const initial = displayState();
  initial.portfolio.rates.HKD = { value: 0.875, date: entry().asOf };
  const ui = await view(initial);
  await clickCurrency(ui, "HKD");
  assert.match(ui.get("asset-content").innerHTML, /data-currency="HKD" aria-pressed="true"/);
  assert.match(ui.get("asset-content").innerHTML, /<small>HK\$<\/small>1,200\.00/);
  ui.run('page="holdings"; render()');
  assert.match(ui.get("asset-content").innerHTML, /<th>折合 HKD<\/th>/);
  assert.equal(ui.run("state.revision"), 3);
  assert.equal(ui.run("state.portfolio.entries[0].amount"), 700);
  ui.run('delete state.portfolio.rates.HKD; page="overview"; render()');
  assert.match(ui.get("asset-content").innerHTML, /<small>HK\$<\/small>—/);
  assert.match(ui.get("asset-content").innerHTML, /HKD\/CNY 自动汇率暂不可用/);
  const restored = await view(initial, null, { storage: {getItem:()=>"HKD"} });
  assert.equal(restored.run("displayCurrency"), "HKD");
  for (const platform of ["币安Agentic Wallet", "OKX Agentic Wallet"]) assert.ok(core.PLATFORMS.includes(platform));
});

test("opening the page automatically requests AI once, polling does not, and privacy and escaping cover the review", async () => {
 const ui=await view(displayState(),null,{aiHandler:async()=>syncResponse({configured:true,status:"fresh",review:{text:'<img src=x>金额 999',model:'gpt-5.4-mini',revision:3,generatedAt:'2026-10-24T14:00:00Z'}})});
 assert.equal(ui.aiRequests.length,1);
 assert.equal(ui.aiRequests[0].url,"/api/assets/ai/review");
 assert.equal(ui.aiRequests[0].options.body,"{}");
 assert.match(ui.get("asset-content").innerHTML,/AI 资产点评/);
 assert.match(ui.get("asset-content").innerHTML,/&lt;img src=x&gt;金额 999/);
 await ui.run("load()");assert.equal(ui.aiRequests.length,1);
 ui.run("hidden=true;render()");assert.doesNotMatch(ui.get("asset-content").innerHTML,/金额 999/);
 assert.match(ui.get("asset-content").innerHTML,/隐私模式已隐藏点评/);
});

test("OpenAI configuration clears secrets immediately and preserves assets when verification fails",async()=>{
 const ui=await view(displayState(),null,{aiHandler:async(url)=>url.endsWith("configure")?syncResponse({error:"认证失败"},400):syncResponse({configured:false,status:"unconfigured",review:null})});
 ui.run('openAiSettings();document.getElementById("ai-api-key").value="sk-synthetic-only"');
 await ui.listeners.submit({target:{id:"ai-config-form"},preventDefault(){}});
 assert.equal(ui.get("ai-api-key").value,"");
 assert.equal(ui.run("state.revision"),3);
 assert.match(ui.get("dialog-error").innerHTML,/认证失败/);
 assert.equal(ui.requests.some(row=>row.options.method==="PUT"),false);
});
