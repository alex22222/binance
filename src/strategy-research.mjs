import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildStrategyComparison, DEFAULT_STRATEGY_ID, strategyById } from "./strategy-lab.mjs";
import { contentHash, loadApprovalMode, loadStrategyGate, readEvidence, runtimeCodeHash } from "./strategy-governance.mjs";
import { refreshTradeLedger } from "./trade-ledger.mjs";
import { paperExitValuation } from "./paper-valuation.mjs";
import { FREQUENCY_PAPER_HASH } from "./etf-frequency-paper.mjs";

// The ledger lives beside the trace (state/trade-ledger.json in production);
// TRADE_LEDGER_FILE overrides it, e.g. for a local preview.
export function tradeLedgerPath(projectRoot, config) {
  return process.env.TRADE_LEDGER_FILE
    ? resolve(process.env.TRADE_LEDGER_FILE)
    : resolve(dirname(resolve(projectRoot, config.traceFile)), "trade-ledger.json");
}

const PAPER_REPORTS = {
  "daily-turtle-55-20": "state/turtle-paper/latest.json",
  "weekly-etf-momentum-rsi-rotation": "state/weekly-etf-rotation-paper/latest.json",
  "weekly-etf-dual-momentum-defense": "state/weekly-etf-dual-momentum-paper/latest.json"
};

const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value?.[key] ?? null]));

async function readReport(path, project) {
  try {
    const source = await readFile(path, "utf8");
    const value = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid report");
    return { status: "AVAILABLE", sourceHash: contentHash(source), ...project(value) };
  } catch (error) {
    return { status: error.code === "ENOENT" ? "MISSING" : "ERROR" };
  }
}

function validationWindow(value) {
  if (!value) return null;
  if (!Array.isArray(value.strategies)) throw new Error("Invalid validation strategies");
  return {
    ...pick(value, ["generatedAt", "dataCoverage", "assumptions"]),
    strategies: value.strategies.map((strategy) => pick(strategy, ["id", "name", "evidenceLevel", "performance"]))
  };
}

function paperReport(value, strategyId) {
  if (value.mode !== "paper" || value.strategyId !== strategyId || !Array.isArray(value.trades)) {
    throw new Error("Paper identity mismatch");
  }
  return {
    ...pick(value, ["strategyId", "evidenceLevel", "startedAt", "updatedAt", "initialCapitalUsdt", "equityUsdt", "totalReturnPct", "realizedPnlUsdt", "totalCostUsdt"]),
    closedTrades: value.trades.length,
    ...paperExitValuation(value),
    position: value.position ? pick(value.position, ["symbol", "markedAt", "unrealizedPnlUsdt"]) : null
  };
}

// Saved evidence only: no wallet, quote, trading, or report-generation calls.
export async function loadStrategyResearch({ projectRoot, configPath, nowMs = Date.now() }) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const [control, trace, validation, shadow, paperEntries] = await Promise.all([
    readReport(resolve(projectRoot, config.strategyControlFile), (value) => {
      if (!strategyById(value.strategyId)) throw new Error("Unknown current strategy");
      return pick(value, ["strategyId", "entriesPaused", "updatedAt"]);
    }),
    (async () => {
      try {
        const ledger = await refreshTradeLedger({
          tracePath: resolve(projectRoot, config.traceFile),
          ledgerPath: tradeLedgerPath(projectRoot, config),
          nowMs
        });
        return { status: "AVAILABLE", records: ledger.records, period: { from: ledger.firstAt, to: ledger.lastAt } };
      } catch (error) {
        return { status: error.code === "ENOENT" ? "MISSING" : "ERROR", records: [], period: null };
      }
    })(),
    readReport(resolve(projectRoot, "state/strategy-validation/latest.json"), (value) => ({
      ...pick(value, ["generatedAt", "sources", "limitations"]),
      historical: validationWindow(value.historical), forward: validationWindow(value.forward)
    })),
    readReport(resolve(projectRoot, "state/shadow-outcomes/latest.json"), (value) => {
      if (!Array.isArray(value.horizons)) throw new Error("Invalid shadow horizons");
      return {
        ...pick(value, ["generatedAt", "method"]),
        horizons: value.horizons.map((horizon) => pick(horizon, ["horizonMinutes", "strategyCohorts"]))
      };
    }),
    Promise.all(Object.entries(PAPER_REPORTS).map(async ([id, path]) => [id,
      await readReport(resolve(projectRoot, path), (value) => paperReport(value, id))
    ]))
  ]);
  const activeStrategyId = control.status === "ERROR" ? null : control.strategyId || config.defaultStrategyId || DEFAULT_STRATEGY_ID;
  const { records, ...traceStatus } = trace;
  const approval = await loadApprovalMode(projectRoot, config);
  const codeHash = await runtimeCodeHash();
  let archive;
  try {
    archive = { status: "AVAILABLE", records: (await readEvidence(resolve(projectRoot, "state/strategy-evidence")))
      .map(({ id, record }) => ({ id, ...pick(record, ["strategyId", "kind", "evidenceLevel", "generatedAt", "dataCutoff", "identity", "sourceHash", "costModel", "bindingStatus"]) })) };
  } catch { archive = { status: "ERROR", records: [] }; }
  const positions = await (async () => {
    try { return JSON.parse(await readFile(resolve(projectRoot, config.stateFile), "utf8")).positions || []; } catch { return []; }
  })();
  const strategies = await Promise.all(buildStrategyComparison(activeStrategyId, records, { scope: "FULL_TRADE_LEDGER", positions }).map(async (strategy) => {
    const governance = await loadStrategyGate({ projectRoot, config, strategyId: strategy.id, nowMs, codeHash });
    return { ...strategy, runtimeSupported: strategy.switchable,
      switchable: strategy.switchable && (config.mode !== "live" || governance.allowed),
      governance, approvalMode: approval.mode };
  }));
  return {
    generatedAt: new Date(nowMs).toISOString(), mode: config.mode,
    activeStrategyId, control,
    strategies, approval, archive,
    trace: { ...traceStatus, scope: "FULL_TRADE_LEDGER" },
    validation, shadow, paper: Object.fromEntries(paperEntries),
    frequencyPaper: await readReport(resolve(projectRoot, "state/etf-frequency-paper/latest.json"), (value) => {
      if (value.mode !== "paper" || value.specificationHash !== FREQUENCY_PAPER_HASH || value.automaticTradingEligible !== false || !Array.isArray(value.experiments)) throw new Error("Frequency Paper identity mismatch");
      return { ...pick(value, ["startedAt", "updatedAt", "evidenceLevel", "specificationHash", "specification", "collectionStatus", "lastObservation", "automaticTradingEligible"]),
        experiments: value.experiments.map(ledger => ({ ...pick(ledger, ["id", "frequency", "momentumDays", "cost", "eligibleFrom", "liquidationEquityUsdt", "liquidationReturnPct", "realizedPnlUsdt", "totalCostUsdt", "maxDrawdownPct", "closedTrades", "observations"]),
          position: ledger.position ? pick(ledger.position, ["symbol", "markedAt", "hypotheticalExitNetPnlUsdt"]) : null })) };
    })
  };
}
