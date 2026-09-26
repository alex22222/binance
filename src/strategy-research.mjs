import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { buildStrategyComparison, DEFAULT_STRATEGY_ID, strategyById } from "./strategy-lab.mjs";
import { DASHBOARD_TRACE_TAIL_BYTES, readJsonLinesTail } from "./dashboard.mjs";

const PAPER_REPORTS = {
  "daily-turtle-55-20": "state/turtle-paper/latest.json",
  "weekly-etf-momentum-rsi-rotation": "state/weekly-etf-rotation-paper/latest.json",
  "weekly-etf-dual-momentum-defense": "state/weekly-etf-dual-momentum-paper/latest.json"
};

const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value?.[key] ?? null]));

async function readReport(path, project) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid report");
    return { status: "AVAILABLE", ...project(value) };
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
        const path = resolve(projectRoot, config.traceFile);
        const info = await stat(path);
        const records = await readJsonLinesTail(path);
        const times = records.map((record) => Date.parse(record.timestamp)).filter(Number.isFinite);
        return {
          status: "AVAILABLE", records, truncated: info.size > DASHBOARD_TRACE_TAIL_BYTES,
          period: {
            from: times.length ? new Date(times.reduce((a, b) => Math.min(a, b))).toISOString() : null,
            to: times.length ? new Date(times.reduce((a, b) => Math.max(a, b))).toISOString() : null
          }
        };
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
  return {
    generatedAt: new Date(nowMs).toISOString(), mode: config.mode,
    activeStrategyId, control,
    strategies: buildStrategyComparison(activeStrategyId, records),
    trace: { ...traceStatus, scope: "TRACE_WINDOW_NOT_FULL_HISTORY" },
    validation, shadow, paper: Object.fromEntries(paperEntries)
  };
}
