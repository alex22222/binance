import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { summarize, validatePortfolio } from "./personal-assets-core.mjs";

const pick = (row, keys) => Object.fromEntries(keys.filter(key => row?.[key] !== undefined).map(key => [key, row[key]]));
const timestamps = ["enabled", "targetAccountId", "lastAttemptAt", "lastFetchedAt", "lastAppliedAt", "observedAt", "lastError", "overdue", "lastCoverage", "lastWarnings", "lastUnpricedAssets", "lastValuationComplete"];

function safeCoverage(sync) {
  if (!sync) return null;
  return {
    status: sync.status,
    refresh: pick(sync.refresh, ["time", "lastAttemptAt", "lastCompletedAt", "lastError"]),
    providers: Object.fromEntries(Object.entries(sync.providers || {}).map(([name, row]) => [name, pick(row, timestamps)])),
    funds: {
      status: sync.funds?.status,
      bindings: (sync.funds?.bindings || []).map(row => pick(row, [...timestamps, "entryId", "accountId", "isin", "symbol", "quantity", "quantityBasis", "confirmedOn", "nav", "navDate", "price", "priceDate", "currency", "priceBasis", "source", "sourceTime", "timeBasis", "quote"])),
      stockPnlEstimates: (sync.funds?.stockPnlEstimates || []).map(row => pick(row, [...timestamps, "accountId", "costBasisAmount", "positions", "currency", "confirmedOn"])),
    },
  };
}

const schema = `
  CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, beijing_day TEXT NOT NULL, phase TEXT NOT NULL,
    revision INTEGER NOT NULL, total_cny REAL, pnl_cny REAL, missing_fx INTEGER NOT NULL,
    portfolio_json TEXT NOT NULL, fx_json TEXT NOT NULL, coverage_json TEXT NOT NULL, sha256 TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS snapshot_time ON snapshots(beijing_day, at);
  CREATE TABLE IF NOT EXISTS asset_values (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id), entry_id TEXT NOT NULL, account_id TEXT NOT NULL,
    currency TEXT NOT NULL, amount REAL NOT NULL, cny_value REAL, included INTEGER NOT NULL,
    asset_date TEXT NOT NULL, detail_json TEXT NOT NULL, PRIMARY KEY(snapshot_id, entry_id)
  );
  CREATE TABLE IF NOT EXISTS account_pnl (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id), account_id TEXT NOT NULL, currency TEXT NOT NULL,
    amount REAL NOT NULL, cny_value REAL, asset_date TEXT NOT NULL, detail_json TEXT NOT NULL,
    PRIMARY KEY(snapshot_id, account_id)
  );
  CREATE VIEW IF NOT EXISTS daily_points AS
    SELECT id,at,beijing_day,phase,revision,total_cny,pnl_cny,missing_fx FROM (
      SELECT *,row_number() OVER(PARTITION BY beijing_day ORDER BY at DESC,id DESC) n FROM snapshots
    ) WHERE n=1;
  CREATE VIEW IF NOT EXISTS daily_changes AS
    SELECT *,CASE WHEN previous_day=date(beijing_day,'-1 day') AND missing_fx=0 AND previous_missing_fx=0 THEN total_cny-previous_total_cny END change_cny,
      CASE WHEN previous_day=date(beijing_day,'-1 day') THEN pnl_cny-previous_pnl_cny END pnl_change_cny
    FROM (SELECT *,lag(id) OVER(ORDER BY beijing_day) previous_id,
      lag(beijing_day) OVER(ORDER BY beijing_day) previous_day,
      lag(total_cny) OVER(ORDER BY beijing_day) previous_total_cny,
      lag(missing_fx) OVER(ORDER BY beijing_day) previous_missing_fx,
      lag(pnl_cny) OVER(ORDER BY beijing_day) previous_pnl_cny FROM daily_points);
  CREATE VIEW IF NOT EXISTS daily_asset_changes AS
    WITH pairs AS (SELECT *,CASE WHEN previous_day=date(beijing_day,'-1 day') THEN previous_id END before_id FROM daily_changes),
    keys AS (SELECT p.id,p.beijing_day,p.before_id,a.entry_id FROM pairs p JOIN asset_values a ON a.snapshot_id=p.id
      UNION SELECT p.id,p.beijing_day,p.before_id,a.entry_id FROM pairs p JOIN asset_values a ON a.snapshot_id=p.before_id)
    SELECT k.beijing_day,k.id snapshot_id,k.entry_id,coalesce(a.account_id,b.account_id) account_id,
      b.cny_value before_cny,a.cny_value after_cny,
      CASE WHEN k.before_id IS NULL OR a.included=1 AND a.cny_value IS NULL OR b.included=1 AND b.cny_value IS NULL THEN NULL
        ELSE (CASE WHEN a.included=1 THEN a.cny_value ELSE 0 END)-(CASE WHEN b.included=1 THEN b.cny_value ELSE 0 END) END change_cny,
      b.detail_json before_json,a.detail_json after_json
    FROM keys k LEFT JOIN asset_values a ON a.snapshot_id=k.id AND a.entry_id=k.entry_id
      LEFT JOIN asset_values b ON b.snapshot_id=k.before_id AND b.entry_id=k.entry_id;
`;

// Private, local analysis storage only. No network, source refresh or credentials.
export async function archivePersonalAssetsSnapshot({ stateDir, snapshot }) {
  if (!/^[a-f0-9-]{36}$/.test(snapshot.id) || !Number.isFinite(Date.parse(snapshot.at)) || !Number.isSafeInteger(snapshot.revision)) throw new Error("Invalid history snapshot");
  const portfolio = validatePortfolio(snapshot.portfolio), summary = summarize(portfolio);
  if (summary.total !== snapshot.total || summary.missing.length !== snapshot.missing) throw new Error("History valuation does not match saved snapshot");
  const fx = snapshot.fx ? { ...pick(snapshot.fx, ["status", "source", "asOf", "fetchedAt"]),
    rates: Object.fromEntries(Object.entries(snapshot.fx.rates || {}).map(([currency, row]) => [currency, pick(row, ["value", "date", "asOf", "source", "fetchedAt"])])) } : null;
  const coverage = safeCoverage(snapshot.sync);
  const payload = JSON.stringify({ at: snapshot.at, revision: snapshot.revision, dailyDate: snapshot.dailyDate, dailyPhase: snapshot.dailyPhase, portfolio, fx, coverage });
  const digest = createHash("sha256").update(payload).digest("hex");
  await mkdir(resolve(stateDir), { recursive: true, mode: 0o700 });
  const path = join(resolve(stateDir), "personal-assets-history.sqlite");
  const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077)) throw new Error("Asset history database must be a private regular file");
  } finally { await handle.close(); }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  let transaction = false;
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
    db.exec(schema);
    db.exec("BEGIN IMMEDIATE");
    transaction = true;
    const existing = db.prepare("SELECT sha256 FROM snapshots WHERE id=?").get(snapshot.id);
    if (existing) {
      if (existing.sha256 !== digest) throw new Error("Archived snapshot identity conflict; existing history retained");
      db.exec("COMMIT");
      transaction = false;
      return { saved: false, id: snapshot.id };
    }
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(snapshot.at));
    db.prepare("INSERT INTO snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(snapshot.id, snapshot.at, day,
      snapshot.dailyDate ? snapshot.dailyPhase || "close" : "snapshot", snapshot.revision, snapshot.total,
      summary.stockPnl.missing.length ? null : summary.stockPnl.total, snapshot.missing, JSON.stringify(portfolio), JSON.stringify(fx), JSON.stringify(coverage), digest);
    const included = new Set([...summary.included, ...summary.missing].map(row => row.id));
    const valued = new Set(summary.included.map(row => row.id));
    const asset = db.prepare("INSERT INTO asset_values VALUES (?,?,?,?,?,?,?,?,?)");
    for (const row of portfolio.entries) asset.run(snapshot.id, row.id, row.accountId, row.currency, row.amount,
      valued.has(row.id) ? row.amount * (row.currency === "CNY" ? 1 : portfolio.rates[row.currency].value) : null,
      Number(included.has(row.id)), row.asOf, JSON.stringify(row));
    const valuedPnl = new Set(summary.stockPnl.included.map(row => row.accountId));
    const pnl = db.prepare("INSERT INTO account_pnl VALUES (?,?,?,?,?,?,?)");
    for (const row of portfolio.stockPnl || []) pnl.run(snapshot.id, row.accountId, row.currency, row.amount,
      valuedPnl.has(row.accountId) ? row.amount * (row.currency === "CNY" ? 1 : portfolio.rates[row.currency].value) : null, row.asOf, JSON.stringify(row));
    db.exec("COMMIT");
    transaction = false;
    return { saved: true, id: snapshot.id };
  } catch (error) {
    if (transaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}

export async function archiveExistingPersonalAssetsSnapshots({ stateDir, snapshots }) {
  let saved = 0;
  for (const metadata of snapshots) {
    if (!/^[a-f0-9-]{36}$/.test(metadata.id)) throw new Error("Invalid history snapshot ID");
    const handle = await open(join(resolve(stateDir), "personal-assets-snapshots", `${metadata.id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    let snapshot;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 8_000_000) throw new Error("Invalid snapshot detail file");
      snapshot = JSON.parse(await handle.readFile("utf8"));
    } finally { await handle.close(); }
    if (["id", "at", "revision", "total", "missing"].some(key => snapshot[key] !== metadata[key])) throw new Error("Snapshot metadata conflict");
    if ((await archivePersonalAssetsSnapshot({ stateDir, snapshot })).saved) saved++;
  }
  return { inspected: snapshots.length, archived: saved };
}
