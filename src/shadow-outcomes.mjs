import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function scanPrice(record) {
  return finite(record?.signal?.lastPrice) ?? finite(record?.atr?.lastPrice);
}

function average(values) {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length
    ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length
    : null;
}

function cohortMetrics(outcomes) {
  const netReturns = outcomes.map(({ netReturnPct }) => netReturnPct).filter(Number.isFinite);
  return {
    samples: netReturns.length,
    wins: netReturns.filter((value) => value > 0).length,
    winRatePct: netReturns.length
      ? netReturns.filter((value) => value > 0).length / netReturns.length * 100
      : null,
    averageNetReturnPct: average(netReturns),
    averageNetReturnR: average(outcomes.map(({ netReturnR }) => netReturnR))
  };
}

function normalizedDecision(value) {
  if (value === "WOULD_ALLOW") return "WOULD_ALLOW";
  if (["WOULD_BLOCK", "WOULD_VETO"].includes(value)) return "WOULD_BLOCK";
  return "UNKNOWN";
}

export function buildShadowOutcomeReport(records, options = {}) {
  const horizonsMinutes = options.horizonsMinutes || [15, 30, 60, 120];
  const scans = records
    .filter(({ recordType }) => recordType === "market_scan")
    .map((record) => ({ ...record, timestampMs: Date.parse(record.recordedAt || "") }))
    .filter((record) => Number.isFinite(record.timestampMs) && scanPrice(record) > 0)
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const scansById = new Map(scans.map((record) => [record.scanId, record]));
  const marketRegimeByCycle = new Map(
    records
      .filter(({ recordType }) => recordType === "shadow_market_regime")
      .map((record) => [record.cycleId, record])
  );
  const comparisonByScanId = new Map(
    records
      .filter(({ recordType }) => recordType === "shadow_candidate_comparison")
      .map((record) => [record.scanId, record])
  );
  const scansBySymbol = new Map();
  for (const scan of scans) {
    const list = scansBySymbol.get(scan.symbol) || [];
    list.push(scan);
    scansBySymbol.set(scan.symbol, list);
  }
  const candidates = records
    .filter(({ recordType }) => recordType === "quote_evaluation")
    .map((quote) => {
      const scan = scansById.get(quote.scanId);
      const comparison = comparisonByScanId.get(quote.scanId);
      const strategyIds = [];
      if (scan?.gates?.trendPassed === true && quote.costCoverage?.allowed !== false) {
        strategyIds.push("adaptive-momentum");
      }
      if (
        scan?.shadowTrendPullback?.decision === "WOULD_ENTER" &&
        quote.shadowTrendPullbackCostCoverage?.allowed !== false
      ) {
        strategyIds.push("trend-pullback-confirmation");
      }
      if (
        comparison?.regimeRelativePullbackMomentum?.decision === "WOULD_ENTER" &&
        comparison.regimeRelativePullbackMomentum.costAllowed === true
      ) {
        strategyIds.push("regime-relative-pullback-momentum");
      }
      return { quote, scan, comparison, strategyIds };
    })
    .filter(({ scan, strategyIds }) => scan && strategyIds.length > 0);
  const outcomes = [];
  for (const { quote, scan, comparison, strategyIds } of candidates) {
    const entryPrice = scanPrice(scan);
    const allInCostPct = finite(quote.executionCost?.allInCostPct) || 0;
    const initialRiskPct = finite(quote.initialRisk?.initialRiskPct);
    for (const horizonMinutes of horizonsMinutes) {
      const targetMs = scan.timestampMs + horizonMinutes * 60_000;
      const future = (scansBySymbol.get(scan.symbol) || []).find(
        (candidate) => (
          candidate.timestampMs >= targetMs &&
          candidate.timestampMs <= targetMs + 20 * 60_000
        )
      );
      if (!future) continue;
      const grossReturnPct = (scanPrice(future) / entryPrice - 1) * 100;
      const netReturnPct = grossReturnPct - allInCostPct;
      const pathNetReturns = [
        -allInCostPct,
        ...(scansBySymbol.get(scan.symbol) || [])
          .filter((candidate) => (
            candidate.timestampMs > scan.timestampMs &&
            candidate.timestampMs <= future.timestampMs
          ))
          .map((candidate) => (scanPrice(candidate) / entryPrice - 1) * 100 - allInCostPct)
      ];
      const maePct = Math.min(...pathNetReturns);
      const mfePct = Math.max(...pathNetReturns);
      outcomes.push({
        scanId: scan.scanId,
        symbol: scan.symbol,
        observedAt: scan.recordedAt,
        horizonMinutes,
        labeledAt: future.recordedAt,
        downtrendDecision: normalizedDecision(scan.shadowDowntrendVeto?.decision),
        trendQualityDecision: scan.shadowTrendQuality?.decision || "UNKNOWN",
        trendPullbackDecision: scan.shadowTrendPullback?.decision || "UNKNOWN",
        marketRegimeDecision: marketRegimeByCycle.get(scan.cycleId)?.decision || "UNKNOWN",
        regimeRelativePullbackDecision: (
          comparison?.regimeRelativePullbackMomentum?.decision || "UNKNOWN"
        ),
        benchmarkRelativeReturn60mPct: finite(
          comparison?.regimeRelativePullbackMomentum?.benchmarkRelativeReturn60mPct
        ),
        relativeStrengthRank: finite(
          comparison?.regimeRelativePullbackMomentum?.relativeStrengthRank
        ),
        strategyIds,
        entryPrice,
        forwardPrice: scanPrice(future),
        allInCostPct,
        initialRiskPct,
        grossReturnPct,
        netReturnPct,
        netReturnR: initialRiskPct > 0 ? netReturnPct / initialRiskPct : null,
        maePct,
        mfePct,
        maeR: initialRiskPct > 0 ? maePct / initialRiskPct : null,
        mfeR: initialRiskPct > 0 ? mfePct / initialRiskPct : null,
        exitReason: "HORIZON_MARK"
      });
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt || new Date().toISOString(),
    method: {
      priceSource: "TOKEN_SCAN_CLOSE_PROXY",
      costTreatment: "entry all-in cost deducted once",
      executionStatus: "COUNTERFACTUAL_NON_EXECUTING",
      limitation: "Forward token scan closes are not executable sell quotes and do not include an exit-path simulation."
    },
    candidates: candidates.length,
    shadowLabeledCandidates: candidates.filter(
      ({ scan }) => normalizedDecision(scan.shadowDowntrendVeto?.decision) !== "UNKNOWN"
    ).length,
    marketRegimeLabeledCandidates: candidates.filter(
      ({ scan }) => normalizedDecision(marketRegimeByCycle.get(scan.cycleId)?.decision) !== "UNKNOWN"
    ).length,
    regimeRelativePullbackLabeledCandidates: candidates.filter(
      ({ comparison }) => comparison?.regimeRelativePullbackMomentum?.decision === "WOULD_ENTER"
    ).length,
    horizons: horizonsMinutes.map((horizonMinutes) => {
      const horizonOutcomes = outcomes.filter((outcome) => outcome.horizonMinutes === horizonMinutes);
      return {
        horizonMinutes,
        labeled: horizonOutcomes.length,
        strategyCohorts: {
          "adaptive-momentum": cohortMetrics(horizonOutcomes.filter(
            ({ strategyIds }) => strategyIds.includes("adaptive-momentum")
          )),
          "trend-pullback-confirmation": cohortMetrics(horizonOutcomes.filter(
            ({ strategyIds }) => strategyIds.includes("trend-pullback-confirmation")
          )),
          "regime-relative-pullback-momentum": cohortMetrics(horizonOutcomes.filter(
            ({ strategyIds }) => strategyIds.includes("regime-relative-pullback-momentum")
          ))
        },
        marketRegimeCohorts: {
          WOULD_ALLOW: cohortMetrics(horizonOutcomes.filter(
            ({ marketRegimeDecision }) => marketRegimeDecision === "WOULD_ALLOW"
          )),
          WOULD_BLOCK: cohortMetrics(horizonOutcomes.filter(
            ({ marketRegimeDecision }) => marketRegimeDecision === "WOULD_BLOCK"
          )),
          UNKNOWN: cohortMetrics(horizonOutcomes.filter(
            ({ marketRegimeDecision }) => !["WOULD_ALLOW", "WOULD_BLOCK"].includes(marketRegimeDecision)
          ))
        },
        cohorts: {
          WOULD_ALLOW: cohortMetrics(horizonOutcomes.filter(
            ({ downtrendDecision }) => downtrendDecision === "WOULD_ALLOW"
          )),
          WOULD_BLOCK: cohortMetrics(horizonOutcomes.filter(
            ({ downtrendDecision }) => downtrendDecision === "WOULD_BLOCK"
          )),
          UNKNOWN: cohortMetrics(horizonOutcomes.filter(
            ({ downtrendDecision }) => downtrendDecision === "UNKNOWN"
          ))
        }
      };
    }),
    outcomes
  };
}

export async function writeShadowOutcomeReport({
  marketDataDirectory,
  outputPath,
  generatedAt = new Date().toISOString(),
  days = 14
}) {
  const files = (await readdir(marketDataDirectory))
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .slice(-days);
  const records = (await Promise.all(files.map(async (file) => (
    (await readFile(join(marketDataDirectory, file), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  )))).flat();
  const report = buildShadowOutcomeReport(records, { generatedAt });
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, outputPath);
  return report;
}
