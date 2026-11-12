import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildStrategyComparison, DEFAULT_STRATEGY_ID, strategyById } from "./strategy-lab.mjs";
import { contentHash, loadApprovalMode, loadStrategyGate, readEvidence, runtimeCodeHash } from "./strategy-governance.mjs";
import { refreshTradeLedger } from "./trade-ledger.mjs";
import { paperExitValuation } from "./paper-valuation.mjs";
import { FREQUENCY_PAPER_HASH } from "./etf-frequency-paper.mjs";
import { readStrategyDaily } from "./strategy-daily.mjs";

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

// Minute-bar validation and Shadow apply only to these ids. Daily and weekly
// rules must not display that engine's empty result as "no history".
const MINUTE_RESEARCH = new Set([
  "adaptive-momentum", "trend-pullback-confirmation", "regime-relative-pullback-momentum",
  "session-momentum", "executable-basis-reversion", "residual-reversal"
]);

// Frozen research dispositions. They label the archive; they do not change
// trading status, authorization, or which strategy the bot is allowed to run.
const CATALOG_REVIEW = {
  "weekly-etf-dual-momentum-defense": {
    layer: "capital", verdict: "WITHHOLD", label: "暂缓实盘",
    summary: "2008-06 至 2026-09、0.35% 往返的底层代理年化 3.74%，最大回撤 36.46%；同期持有 SPY 年化 11.72%。2021-07 起、0.8% 往返加 Gas 的总收益是 −3.96%，同票面半仓持有 SPY 是 +43.99%。2022 年仍亏损。少亏应持有 SGOV，承担股票风险应持有固定比例。",
    nextStep: "月频矩阵继续纸面记录，满 12 个独立决策前不替换当前规则。",
    benchmarks: [
      { label: "周频 20 日年化", value: "3.74%", window: "2008-06 至 2026-09 · 0.35%" },
      { label: "持有 SPY 年化", value: "11.72%", window: "同一窗口 · 同一成本" },
      { label: "周频最大回撤", value: "36.46%", window: "同一窗口" },
      { label: "2021-07 起总收益", value: "−3.96%", window: "0.8% + 每边 0.05 U Gas" }
    ]
  },
  "weekly-etf-momentum-rsi-rotation": {
    layer: "closed", verdict: "CONTROL", label: "旧池对照",
    summary: "2020-07 至 2026-09 代理年化 7.37%、回撤 31%、Sharpe 0.51，弱于静态风险 ETF。旧账本保留，退出主目录。"
  },
  "adaptive-momentum": {
    layer: "closed", verdict: "CLOSED", label: "已关闭",
    summary: "2026-07-28 至 08-24 实盘 37 笔，已实现 −6.92 U，胜率 40.5%，盈利因子 0.55。历史模拟 0 笔，不能当作这条规则的证据。"
  },
  "trend-pullback-confirmation": {
    layer: "closed", verdict: "CLOSED", label: "已关闭",
    summary: "分钟级历史约 3 笔、约 −6%。这条路径的往返摩擦大约 1%，不再单列。"
  },
  "regime-relative-pullback-momentum": {
    layer: "closed", verdict: "CLOSED", label: "已关闭",
    summary: "与趋势回撤同一分钟级实验，横截面小。并入已关闭。"
  },
  "session-momentum": {
    layer: "closed", verdict: "CLOSED", label: "已关闭",
    summary: "历史约 3 笔、约 −6.2%。收进已关闭。"
  },
  "executable-basis-reversion": {
    layer: "closed", verdict: "BLOCKED", label: "数据未就绪",
    summary: "模拟 0 笔，Shadow 0 样本。休市偏离还没有有效双向报价。"
  },
  "residual-reversal": {
    layer: "closed", verdict: "BLOCKED", label: "数据未就绪",
    summary: "模拟 0 笔，Shadow 0 样本。移出主目录。"
  },
  "daily-rsi2-trend-reversion": {
    layer: "closed", verdict: "CLOSED", label: "已关闭",
    summary: "日线均值回归簇。2026-07-27 至 08-21 仅 3 笔、+0.71 U。公开高胜率没有在本地复现。"
  },
  "daily-double7-trend-reversion": {
    layer: "closed", verdict: "CLOSED", label: "已关闭",
    summary: "同一均值回归簇。同窗口 3 笔、−1.78 U，盈利因子 0.24。"
  },
  "daily-ibs-reversal": {
    layer: "closed", verdict: "CLOSED", label: "已关闭",
    summary: "同一均值回归簇。同窗口 3 笔、−1.54 U，并与 Double 7 撞上同一轮 QQQ 下跌。"
  },
  "daily-turtle-55-20": {
    layer: "validating", verdict: "PAPER", label: "继续纸面",
    summary: "低频对照。2026-10-09 账本核对为 1 笔平仓 −1.87 U，另有持仓。样本仍不足。个股代币池没有原始海龟的分散。"
  }
};

export function catalogFor(strategyId) {
  const review = CATALOG_REVIEW[strategyId] || {
    layer: "validating", verdict: "INSUFFICIENT", label: "证据不足", summary: "目录里没有单独的冻结结论。"
  };
  return { historyApplies: MINUTE_RESEARCH.has(strategyId), shadowApplies: MINUTE_RESEARCH.has(strategyId), ...review };
}

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
    ...pick(value, ["strategyId", "evidenceLevel", "startedAt", "updatedAt", "initialCapitalUsdt", "equityUsdt", "totalReturnPct", "realizedPnlUsdt", "totalCostUsdt", "roundTripCostPct", "lastObservation", "collectionStatus"]),
    producerIdentityHash: value.provenance?.identity?.identityHash || null,
    accountingSeriesHash: contentHash(JSON.stringify([strategyId, value.schemaVersion, value.startedAt,
      value.initialCapitalUsdt, value.roundTripCostPct, value.costModel, value.provenance?.identity,
      value.universe?.id, value.universe?.symbols])),
    closedTrades: value.trades.length,
    ...paperExitValuation(value),
    position: value.position ? pick(value.position, ["symbol", "markedAt", "unrealizedPnlUsdt"]) : null
  };
}

// Saved evidence only: no wallet, quote, trading, or report-generation calls.
export async function loadStrategyResearch({ projectRoot, configPath, nowMs = Date.now(), ledgerPath }) {
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
          ledgerPath: ledgerPath || tradeLedgerPath(projectRoot, config),
          nowMs
        });
        return { status: "AVAILABLE", sourceHash: contentHash(JSON.stringify(ledger.records)), records: ledger.records, period: { from: ledger.firstAt, to: ledger.lastAt } };
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
        ...pick(value, ["generatedAt", "dataCutoff", "method"]),
        strategyDataCutoffs: Object.fromEntries([...new Set((value.outcomes || []).flatMap(o => o.strategyIds || []))].map(id => [id,
          (value.outcomes || []).filter(o => o.strategyIds?.includes(id) && Number.isFinite(Date.parse(o.labeledAt))).map(o => o.labeledAt).sort().at(-1) || null])),
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
  const positionState = await (async () => {
    try {
      const value = JSON.parse(await readFile(resolve(projectRoot, config.stateFile), "utf8"));
      if (!Array.isArray(value.positions)) throw new Error("Invalid positions");
      return { status: "AVAILABLE", positions: value.positions };
    } catch (error) { return { status: error.code === "ENOENT" ? "MISSING" : "ERROR", positions: [] }; }
  })();
  const strategies = await Promise.all(buildStrategyComparison(activeStrategyId, records, { scope: "FULL_TRADE_LEDGER", positions: positionState.positions }).map(async (strategy) => {
    const governance = await loadStrategyGate({ projectRoot, config, strategyId: strategy.id, nowMs, codeHash });
    return { ...strategy, catalog: catalogFor(strategy.id), runtimeSupported: strategy.switchable,
      switchable: strategy.switchable && (config.mode !== "live" || governance.allowed),
      governance, approvalMode: approval.mode };
  }));
  return {
    generatedAt: new Date(nowMs).toISOString(), mode: config.mode,
    activeStrategyId, control,
    strategies, approval, archive, positionsStatus: positionState.status,
    dailyJournal: await readStrategyDaily(resolve(projectRoot, "state/strategy-daily")).catch(() => ({ status: "ERROR", records: [], errors: ["READ_FAILED"] })),
    trace: { ...traceStatus, scope: "FULL_TRADE_LEDGER" },
    validation, shadow, paper: Object.fromEntries(paperEntries),
    frequencyPaper: await readReport(resolve(projectRoot, "state/etf-frequency-paper/latest.json"), (value) => {
      if (value.mode !== "paper" || value.specificationHash !== FREQUENCY_PAPER_HASH || value.automaticTradingEligible !== false || !Array.isArray(value.experiments)) throw new Error("Frequency Paper identity mismatch");
      return { ...pick(value, ["startedAt", "updatedAt", "evidenceLevel", "specificationHash", "specification", "collectionStatus", "lastObservation", "automaticTradingEligible"]),
        experiments: value.experiments.map(ledger => ({ ...pick(ledger, ["id", "frequency", "momentumDays", "cost", "eligibleFrom", "liquidationEquityUsdt", "liquidationReturnPct", "realizedPnlUsdt", "totalCostUsdt", "maxDrawdownPct", "closedTrades", "observations"]),
          position: ledger.position ? pick(ledger.position, ["symbol", "markedAt", "hypotheticalExitNetPnlUsdt", "estimatedExitCostUsdt"]) : null })) };
    })
  };
}
