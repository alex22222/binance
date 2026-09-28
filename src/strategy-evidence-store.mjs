import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readJsonLinesTail } from "./dashboard.mjs";
import { STRATEGIES } from "./strategy-lab.mjs";
import { archiveEvidence, contentHash } from "./strategy-governance.mjs";

// Snapshot only. Never replay, fetch a quote, access the wallet or mutate a source.
export async function captureSavedEvidence({ projectRoot, config }) {
  const directory = resolve(projectRoot, "state/strategy-evidence");
  const evidenceIds = [], missing = [], errors = [];
  async function archive({ strategyId, kind, evidenceLevel, sourcePath, sourceHash, generatedAt, dataCutoff, costModel, payload, provenance }) {
    const identity = provenance?.identity || null;
    const record = {
      schemaVersion: 1, strategyId, kind, evidenceLevel, sourcePath, sourceHash,
      generatedAt: generatedAt || null, dataCutoff: dataCutoff || null,
      costModel: costModel || null, identity, author: provenance?.author || null,
      validUntil: provenance?.validUntil || null,
      bindingStatus: identity ? "PRODUCER_DECLARED_REQUIRES_REVIEW" : "UNBOUND_LEGACY", payload
    };
    evidenceIds.push(await archiveEvidence(directory, record));
  }
  async function source(path, consume) {
    try {
      const text = await readFile(resolve(projectRoot, path), "utf8");
      await consume(JSON.parse(text), contentHash(text));
    } catch (error) {
      if (error.code === "ENOENT") missing.push(path);
      else errors.push({ source: path, error: error.message });
    }
  }
  const validationPath = "state/strategy-validation/latest.json";
  await source(validationPath, async (value, sourceHash) => {
    for (const [key, kind] of [["historical", "HISTORICAL"], ["forward", "FORWARD"]]) {
      const window = value[key];
      if (!window) continue;
      if (!Array.isArray(window.strategies)) throw new Error("Invalid validation report");
      for (const strategy of window.strategies) await archive({
        strategyId: strategy.id, kind,
        evidenceLevel: window.assumptions?.execution?.model || "CANDLE_PROXY",
        sourcePath: validationPath, sourceHash,
        generatedAt: value.generatedAt, dataCutoff: window.dataCoverage?.to,
        costModel: window.assumptions, provenance: strategy.provenance,
        payload: { ...strategy, dataCoverage: window.dataCoverage || null, limitations: value.limitations || [] }
      });
    }
  });
  for (const [id, path] of [
    ["daily-turtle-55-20", "state/turtle-paper/latest.json"],
    ["weekly-etf-momentum-rsi-rotation", "state/weekly-etf-rotation-paper/latest.json"],
    ["weekly-etf-dual-momentum-defense", "state/weekly-etf-dual-momentum-paper/latest.json"]
  ]) await source(path, async (value, sourceHash) => {
    if (value.strategyId !== id || value.mode !== "paper") throw new Error("Paper identity mismatch");
    await archive({ strategyId: id, kind: "PAPER", evidenceLevel: value.evidenceLevel || "PAPER_CANDLE_PROXY",
      sourcePath: path, sourceHash, generatedAt: value.updatedAt,
      dataCutoff: value.position?.markedAt || value.lastDecision?.signalDate || null,
      costModel: value.costModel || { source: "PAPER_REPORT", totalCostUsdt: value.totalCostUsdt ?? null },
      provenance: value.provenance, payload: value });
  });
  const shadowPath = "state/shadow-outcomes/latest.json";
  await source(shadowPath, async (value, sourceHash) => {
    if (!Array.isArray(value.horizons)) throw new Error("Invalid Shadow report");
    for (const strategy of STRATEGIES) {
      const horizons = value.horizons.filter((h) => h.strategyCohorts?.[strategy.id])
        .map((h) => ({ horizonMinutes: h.horizonMinutes, cohort: h.strategyCohorts[strategy.id] }));
      if (!horizons.length) continue;
      await archive({ strategyId: strategy.id, kind: "SHADOW", evidenceLevel: "COUNTERFACTUAL_NON_EXECUTING",
        sourcePath: shadowPath, sourceHash, generatedAt: value.generatedAt, dataCutoff: value.dataCutoff,
        costModel: value.method, payload: { horizons } });
    }
  });
  if (config.traceFile) {
    try {
      const records = await readJsonLinesTail(resolve(projectRoot, config.traceFile));
      for (const strategy of STRATEGIES) {
        const fills = records.filter((r) => r.event === "pending_order" && r.status === "finished" && r.details?.strategyId === strategy.id);
        if (!fills.length) continue;
        const dates = fills.map((r) => r.timestamp).filter((s) => Number.isFinite(Date.parse(s))).sort();
        await archive({ strategyId: strategy.id, kind: "LIVE", evidenceLevel: "LIVE_TERMINAL_FILLS",
          sourcePath: "configured trace (bounded window)", sourceHash: contentHash(JSON.stringify(fills)),
          generatedAt: dates.at(-1), dataCutoff: dates.at(-1), costModel: { model: "ORIGINAL_RECORDED_COSTS_NOT_REAUDITED" },
          payload: { scope: "TRACE_WINDOW_NOT_FULL_HISTORY", fills } });
      }
    } catch (error) {
      if (error.code === "ENOENT") missing.push("trace");
      else errors.push({ source: "trace", error: error.message });
    }
  }
  return { evidenceIds: [...new Set(evidenceIds)], missing, errors };
}
