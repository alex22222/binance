import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { STRATEGIES } from "./strategy-lab.mjs";

const WALLETS = [{ id: "binance", provider: "binanceagentic", platform: "币安Agentic Wallet", name: "Binance Agentic Wallet" },
  { id: "okx", provider: "okxagentic", platform: "OKX Agentic Wallet", name: "OKX Agentic Wallet" }];
const text = value => typeof value === "string" ? value.slice(0, 200) : "";
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const amount = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;

export function walletStrategyChoices(walletId) {
  const observe = { id: "observe-only", name: "仅观察", stage: "观察方案", thesis: "不申请启用交易；保存此选项也不会停止现有策略。", canExecute: false };
  if (walletId === "binance") return [observe, ...STRATEGIES.filter(row => row.status !== "REJECTED").map(row => ({
    id: row.id, name: row.name, stage: ({ ACTIVE: "执行支持 · 资格另审", SHADOW: "Shadow 观察", RESEARCH: "研究中" })[row.status] || "待核实",
    thesis: row.thesis, canExecute: false
  }))];
  if (walletId === "okx") return [observe, { id: "okx-pullback-second-wave", name: "OKX 回调二波", stage: "独立策略 · 接入待核实",
    thesis: "对应既有 OKX 研究系统；资产账户、链范围与执行资格需独立核对。", canExecute: false }];
  return [];
}

// A display DTO, not a wallet connection or trade adapter. Only exact platform
// bindings enter the view; neither arbitrary notes nor un-applied previews do.
export function projectAgenticWallets({ assets, sync, now = new Date() } = {}) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
  const accounts = Array.isArray(assets?.portfolio?.accounts) ? assets.portfolio.accounts : [];
  const entries = Array.isArray(assets?.portfolio?.entries) ? assets.portfolio.entries : [];
  return { checkedAt: now.toISOString(), wallets: WALLETS.map(wallet => {
    const source = sync?.providers?.[wallet.provider];
    const projected = accounts.filter(account => account.platform === wallet.platform).map(account => {
      const rows = entries.filter(row => row.accountId === account.id).map(row => {
        const asOf = date(row.asOf);
        return { name: text(row.name), kind: ["total", "holding"].includes(row.kind) ? row.kind : null,
          currency: /^[A-Z]{3,5}$/.test(row.currency || "") ? row.currency : null, amount: amount(row.amount), asOf,
          historical: !asOf || asOf < today, future: Boolean(asOf && asOf > today),
          timeBasis: ["statement", "imported"].includes(row.asOfBasis) ? row.asOfBasis : "unknown",
          source: ["api", "manual", "csv", "screenshot"].includes(row.source) ? row.source : "unknown",
          counted: account.reviewStatus === "confirmed" && (account.basis === "holdings" ? row.kind === "holding" : account.basis === "total" && row.kind === "total") };
      });
      const selected = rows.filter(row => row.counted);
      const totals = new Map();
      for (const row of selected) {
        const currency = row.currency || "UNKNOWN";
        const subtotal = totals.get(currency) || { currency, amount: 0, complete: true };
        subtotal.complete &&= row.amount !== null && !row.future;
        subtotal.amount += row.amount ?? 0;
        totals.set(currency, subtotal);
      }
      const applied = source?.targetAccountId === account.id && timestamp(source.lastAppliedAt);
      return { name: text(account.name), basis: ["total", "holdings"].includes(account.basis) ? account.basis : "unknown",
        confirmed: account.reviewStatus === "confirmed", rows,
        subtotals: [...totals.values()].map(row => ({ currency: row.currency, amount: row.complete ? row.amount : null })),
        unpriced: applied && Array.isArray(source.lastUnpricedAssets) ? source.lastUnpricedAssets.map(row => ({
          name: text(row.name), symbol: text(row.symbol), chain: text(row.chainIndex), contract: text(row.contract),
          quantity: typeof row.quantity === "string" && /^\d+(?:\.\d+)?$/.test(row.quantity) && row.quantity.length <= 120 ? row.quantity : null,
          reason: text(row.reason)
        })) : [] };
    });
    return { id: wallet.id, name: wallet.name, selectionMode: "DRAFT_ONLY", strategies: walletStrategyChoices(wallet.id),
      assetsStatus: assets?.status === "ERROR" ? "ERROR" : projected.some(account => account.rows.length || account.unpriced.length) ? "SAVED" : "MISSING", accounts: projected,
      sync: { status: !source ? "UNKNOWN" : "AVAILABLE", appliedAt: timestamp(source?.lastAppliedAt), failed: Boolean(source?.lastError),
        enabled: source?.enabled === true, valuationComplete: typeof source?.lastValuationComplete === "boolean" ? source.lastValuationComplete : null } };
  }) };
}

const preferenceFile = "agentic-wallet-preferences.json";
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function validatePreferences(value) {
  if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.drafts || typeof value.drafts !== "object" || Array.isArray(value.drafts)
    || Object.keys(value.drafts).some(key => !WALLETS.some(wallet => wallet.id === key))) throw failure("待启用策略记录无法读取。", 500);
  for (const [walletId, draft] of Object.entries(value.drafts)) {
    if (!walletStrategyChoices(walletId).some(row => row.id === draft?.strategyId) || !timestamp(draft.savedAt)) throw failure("待启用策略记录无法读取。", 500);
  }
  return { schemaVersion: 1, revision: value.revision, drafts: Object.fromEntries(Object.entries(value.drafts).map(([id, row]) => [id, { strategyId: row.strategyId, savedAt: row.savedAt }])) };
}

export async function readWalletPreferences(stateDir) {
  let file;
  try {
    file = await open(join(stateDir, preferenceFile), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 16384) throw failure("待启用策略记录无法读取。", 500);
    return validatePreferences(JSON.parse(await file.readFile("utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, revision: 0, drafts: {} };
    throw failure("待启用策略记录无法读取。", 500);
  } finally { await file?.close(); }
}

// Deliberately separate from strategy-control, Bot state and all authorizations.
// No importer in the execution path consumes these preferences.
export async function saveWalletPreference(stateDir, body, now = new Date()) {
  if (!body || Object.keys(body).some(key => !["walletId", "strategyId", "revision"].includes(key))
    || !Number.isSafeInteger(body.revision) || body.revision < 0 || !walletStrategyChoices(body.walletId).some(row => row.id === body.strategyId)) {
    throw failure("钱包、策略或版本无效；未修改运行策略。");
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, preferenceFile), lockPath = `${path}.lock`, temporary = `${path}.${randomUUID()}.tmp`;
  let lock;
  try {
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") throw failure("其他页面正在保存，请刷新后重试。", 409); throw error; }
    const current = await readWalletPreferences(stateDir);
    if (current.revision !== body.revision) throw failure("待启用策略已更新，请刷新后重试。", 409);
    const next = { schemaVersion: 1, revision: current.revision + 1, drafts: { ...current.drafts, [body.walletId]: { strategyId: body.strategyId, savedAt: now.toISOString() } } };
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(next) + "\n"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    return next;
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}
