const REQUIRED_HORIZONS_MS = [3_000, 10_000, 30_000, 60_000];

function rounded(value) {
  return Number.isFinite(value) ? Number(value.toFixed(12)) : null;
}

function qualityPassed(checkpoint) {
  if (typeof checkpoint?.dataQuality?.eligible === "boolean") {
    return checkpoint.dataQuality.eligible;
  }
  return (
    (checkpoint?.dataQuality?.theoreticalVetoReasons || []).length === 0 &&
    (checkpoint?.dataQuality?.executableVetoReasons || []).length === 0 &&
    checkpoint?.dataQuality?.companyActionStatus === "CLEAR"
  );
}

function performance(values) {
  let gains = 0;
  let losses = 0;
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  let wins = 0;
  for (const value of values) {
    if (value > 0) {
      gains += value;
      wins += 1;
    } else if (value < 0) {
      losses += Math.abs(value);
    }
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak - cumulative);
  }
  return {
    signals: values.length,
    netReturnPct: rounded(cumulative),
    averageReturnPct: values.length ? rounded(cumulative / values.length) : null,
    winRate: values.length ? rounded(wins / values.length) : null,
    profitFactor: losses > 0 ? rounded(gains / losses) : null,
    maxDrawdownPct: rounded(maxDrawdownPct)
  };
}

export function buildShadowBasisReadiness(records, {
  minCompleteSignals = 100,
  outOfSampleFraction = 0.3,
  minOutOfSampleSignals = 30,
  minCheckpointCoverage = 0.95,
  minDataQualityPassRate = 0.95,
  minOutOfSampleProfitFactor = 1.1,
  maxOutOfSampleDrawdownPct = 5
} = {}) {
  const decisions = new Map();
  const checkpoints = new Map();

  for (const record of records || []) {
    if (record?.recordType === "shadow_basis_decision") {
      const decision = record.shadowBasisDecision;
      if (decision?.decision === "SHADOW_SIGNAL" && decision.signalId) {
        decisions.set(decision.signalId, decision);
      }
    } else if (record?.recordType === "shadow_basis_checkpoint" && record.signalId) {
      checkpoints.set(`${record.signalId}:${record.horizonMs}`, record);
    }
  }

  let capturedCheckpoints = 0;
  let qualityCheckpoints = 0;
  const complete = [];
  for (const decision of decisions.values()) {
    const signalCheckpoints = REQUIRED_HORIZONS_MS.map(
      (horizonMs) => checkpoints.get(`${decision.signalId}:${horizonMs}`)
    );
    for (const checkpoint of signalCheckpoints) {
      if (checkpoint?.status === "CAPTURED") {
        capturedCheckpoints += 1;
        if (qualityPassed(checkpoint)) qualityCheckpoints += 1;
      }
    }
    if (signalCheckpoints.every((checkpoint) => checkpoint?.status === "CAPTURED")) {
      const finalCheckpoint = signalCheckpoints.at(-1);
      const netReturnPct = Number(finalCheckpoint.netExecutableReturnPct);
      if (Number.isFinite(netReturnPct)) {
        complete.push({
          signalId: decision.signalId,
          decidedAt: decision.decidedAt,
          netReturnPct,
          qualityPassed: signalCheckpoints.every(qualityPassed)
        });
      }
    }
  }
  complete.sort((left, right) => Date.parse(left.decidedAt) - Date.parse(right.decidedAt));

  const expectedCheckpoints = decisions.size * REQUIRED_HORIZONS_MS.length;
  const checkpointCoverage = expectedCheckpoints ? capturedCheckpoints / expectedCheckpoints : 0;
  const dataQualityPassRate = capturedCheckpoints ? qualityCheckpoints / capturedCheckpoints : 0;
  const outOfSampleCount = complete.length
    ? Math.max(1, Math.ceil(complete.length * outOfSampleFraction))
    : 0;
  const training = complete.slice(0, complete.length - outOfSampleCount);
  const outOfSample = complete.slice(complete.length - outOfSampleCount);
  const trainingPerformance = performance(training.map(({ netReturnPct }) => netReturnPct));
  const outOfSamplePerformance = performance(outOfSample.map(({ netReturnPct }) => netReturnPct));

  const modelResearchBlockers = [];
  if (complete.length < minCompleteSignals) modelResearchBlockers.push("INSUFFICIENT_COMPLETE_SIGNALS");
  if (checkpointCoverage < minCheckpointCoverage) modelResearchBlockers.push("INSUFFICIENT_CHECKPOINT_COVERAGE");
  if (dataQualityPassRate < minDataQualityPassRate) modelResearchBlockers.push("INSUFFICIENT_DATA_QUALITY");

  const strategyPromotionBlockers = [...modelResearchBlockers];
  if (outOfSample.length < minOutOfSampleSignals) {
    strategyPromotionBlockers.push("INSUFFICIENT_OUT_OF_SAMPLE_SIGNALS");
  }
  if (
    outOfSamplePerformance.profitFactor == null ||
    outOfSamplePerformance.profitFactor < minOutOfSampleProfitFactor
  ) {
    strategyPromotionBlockers.push("OUT_OF_SAMPLE_PROFIT_FACTOR_TOO_LOW");
  }
  if (
    outOfSamplePerformance.maxDrawdownPct == null ||
    outOfSamplePerformance.maxDrawdownPct > maxOutOfSampleDrawdownPct
  ) {
    strategyPromotionBlockers.push("OUT_OF_SAMPLE_DRAWDOWN_TOO_HIGH");
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    evidenceModel: "FORWARD_SHADOW_AMOUNT_SPECIFIC_QUOTES",
    samples: {
      signals: decisions.size,
      completeSignals: complete.length,
      expectedCheckpoints,
      capturedCheckpoints,
      checkpointCoverage: rounded(checkpointCoverage),
      dataQualityPassRate: rounded(dataQualityPassRate)
    },
    split: {
      method: "CHRONOLOGICAL_LAST_FRACTION_OUT_OF_SAMPLE",
      outOfSampleFraction,
      trainingSignals: training.length,
      outOfSampleSignals: outOfSample.length
    },
    training: trainingPerformance,
    outOfSample: outOfSamplePerformance,
    thresholds: {
      minCompleteSignals,
      minOutOfSampleSignals,
      minCheckpointCoverage,
      minDataQualityPassRate,
      minOutOfSampleProfitFactor,
      maxOutOfSampleDrawdownPct
    },
    modelResearchEligible: modelResearchBlockers.length === 0,
    modelResearchBlockers,
    strategyPromotionEligible: strategyPromotionBlockers.length === 0,
    strategyPromotionBlockers: [...new Set(strategyPromotionBlockers)],
    automaticTradingEligible: false,
    automationBlockers: [
      "EXPLICIT_AUTHORIZATION_REQUIRED",
      "AUTOMATIC_TRADING_NOT_IMPLEMENTED"
    ]
  };
}
