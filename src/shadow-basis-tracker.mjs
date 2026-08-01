import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function rounded(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(12)) : null;
}

function checkpointKey(item) {
  return `${item.signalId}:${item.horizonMs}`;
}

function amountMatches(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return (
    leftNumber > 0 && rightNumber > 0 &&
    Math.abs(leftNumber - rightNumber) <= Math.max(leftNumber, rightNumber) * 1e-9
  );
}

export function buildShadowBasisCheckpoint({
  decision,
  horizonMs,
  dueAt,
  sampledAt,
  sample
}) {
  const baseline = decision.baseline;
  const current = sample?.executableBasis;
  const baselineExitQuote = sample?.baselineExitQuote;
  const initialUsdt = Number(baseline?.execution?.buy?.inputUsdt);
  const initialToken = Number(baseline?.execution?.buy?.outputToken);
  const exitUsdt = Number(baselineExitQuote?.outputUsdt);
  const valid = (
    Number.isFinite(Number(current?.netEntryEdgePct)) &&
    initialUsdt > 0 && initialToken > 0 && exitUsdt > 0 &&
    amountMatches(baselineExitQuote?.inputToken, initialToken)
  );
  const dueAtIso = new Date(dueAt).toISOString();
  const sampledAtIso = new Date(sampledAt).toISOString();

  if (!valid) {
    return {
      schemaVersion: 1,
      recordType: "shadow_basis_checkpoint",
      signalId: decision.signalId,
      horizonMs,
      dueAt: dueAtIso,
      sampledAt: sampledAtIso,
      actualDelayMs: Date.parse(sampledAtIso) - Date.parse(dueAtIso),
      status: "UNAVAILABLE",
      reason: "INVALID_CHECKPOINT_SAMPLE",
      baseline,
      sample: sample || null
    };
  }

  const executableReturnPct = (exitUsdt / initialUsdt - 1) * 100;
  const gasCostPct = Number.isFinite(Number(baseline.gasCostPct)) ? Number(baseline.gasCostPct) : 0;
  const executionBufferPct = Number.isFinite(Number(baseline.executionBufferPct))
    ? Number(baseline.executionBufferPct)
    : 0;
  return {
    schemaVersion: 1,
    recordType: "shadow_basis_checkpoint",
    signalId: decision.signalId,
    instrument: baseline.instrument,
    horizonMs,
    dueAt: dueAtIso,
    sampledAt: sampledAtIso,
    actualDelayMs: Date.parse(sampledAtIso) - Date.parse(dueAtIso),
    status: "CAPTURED",
    reason: null,
    deviationSurvived: (
      Number(current.netEntryEdgePct) > 0 &&
      Number(current.grossDiscountPct) > 0 &&
      (current.vetoReasons || []).length === 0
    ),
    executableReturnPct: rounded(executableReturnPct),
    netExecutableReturnPct: rounded(executableReturnPct - gasCostPct),
    conservativeReturnPct: rounded(executableReturnPct - gasCostPct - executionBufferPct),
    changes: {
      buyBasisPctPoints: rounded(Number(current.buyBasisPct) - Number(baseline.buyBasisPct)),
      sellBasisPctPoints: rounded(Number(current.sellBasisPct) - Number(baseline.sellBasisPct)),
      grossDiscountPctPoints: rounded(Number(current.grossDiscountPct) - Number(baseline.grossDiscountPct)),
      allInCostPctPoints: rounded(Number(current.allInCostPct) - Number(baseline.allInCostPct)),
      netEntryEdgePctPoints: rounded(Number(current.netEntryEdgePct) - Number(baseline.netEntryEdgePct))
    },
    baseline,
    currentExecutableBasis: current,
    baselineExitQuote,
    marketStatus: sample.marketStatus || null,
    dataQuality: sample.dataQuality || null
  };
}

async function loadState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return {
      schemaVersion: 1,
      pending: Array.isArray(state.pending) ? state.pending : []
    };
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, pending: [] };
    throw error;
  }
}

async function saveState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statePath);
}

export function createShadowBasisTracker({
  statePath,
  sample,
  record,
  now = Date.now,
  setTimerImpl = setTimeout,
  clearTimerImpl = clearTimeout,
  maxLatenessMs = 1_500
}) {
  let state = null;
  let stopped = false;
  const timers = new Map();
  const active = new Set();
  let writes = Promise.resolve();

  const persist = async () => {
    writes = writes.then(() => saveState(statePath, state));
    await writes;
  };

  const removePending = async (item) => {
    const key = checkpointKey(item);
    state.pending = state.pending.filter((candidate) => checkpointKey(candidate) !== key);
    timers.delete(key);
    await persist();
  };

  const missedRecord = (item, sampledAtMs) => ({
    schemaVersion: 1,
    recordType: "shadow_basis_checkpoint",
    signalId: item.signalId,
    instrument: item.decision.baseline.instrument,
    horizonMs: item.horizonMs,
    dueAt: item.dueAt,
    sampledAt: new Date(sampledAtMs).toISOString(),
    actualDelayMs: sampledAtMs - Date.parse(item.dueAt),
    status: "MISSED",
    reason: "CHECKPOINT_WINDOW_MISSED",
    baseline: item.decision.baseline
  });

  const execute = async (item) => {
    const key = checkpointKey(item);
    if (stopped || active.has(key)) return;
    active.add(key);
    try {
      const sampledAtMs = now();
      const latenessMs = sampledAtMs - Date.parse(item.dueAt);
      let result;
      if (latenessMs > maxLatenessMs) {
        result = missedRecord(item, sampledAtMs);
      } else {
        try {
          const value = await sample({
            decision: item.decision,
            horizonMs: item.horizonMs,
            dueAt: item.dueAt
          });
          result = buildShadowBasisCheckpoint({
            decision: item.decision,
            horizonMs: item.horizonMs,
            dueAt: item.dueAt,
            sampledAt: new Date(now()).toISOString(),
            sample: value
          });
        } catch (error) {
          result = {
            ...missedRecord(item, now()),
            status: "UNAVAILABLE",
            reason: error.message
          };
        }
      }
      await record(result);
      await removePending(item);
    } finally {
      active.delete(key);
    }
  };

  const schedule = (item) => {
    const key = checkpointKey(item);
    if (stopped || timers.has(key) || active.has(key)) return;
    const delayMs = Math.max(0, Date.parse(item.dueAt) - now());
    const timer = setTimerImpl(() => execute(item), delayMs);
    if (typeof timer?.unref === "function") timer.unref();
    timers.set(key, timer);
  };

  return {
    async start() {
      if (state) return;
      state = await loadState(statePath);
      const pending = [...state.pending].sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt));
      for (const item of pending) {
        if (now() - Date.parse(item.dueAt) > maxLatenessMs) await execute(item);
        else schedule(item);
      }
    },

    async track(decision) {
      if (!state) await this.start();
      if (decision?.decision !== "SHADOW_SIGNAL") return false;
      const existing = new Set(state.pending.map(checkpointKey));
      const baselineMs = Date.parse(decision.decidedAt);
      for (const horizonMs of decision.checkpointHorizonsMs || []) {
        const item = {
          signalId: decision.signalId,
          horizonMs,
          dueAt: new Date(baselineMs + horizonMs).toISOString(),
          decision
        };
        if (!existing.has(checkpointKey(item))) state.pending.push(item);
      }
      await persist();
      for (const item of state.pending.filter((item) => item.signalId === decision.signalId)) schedule(item);
      return true;
    },

    async stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimerImpl(timer);
      timers.clear();
      await writes;
    }
  };
}
