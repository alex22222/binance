import { createHash } from "node:crypto";
import { buildExecutableBasisObservation } from "./executable-basis.mjs";
import { newYorkDate, newYorkSessionBounds } from "./strategy-data.mjs";
import { researchTradingDates } from "./weekly-research-calendar.mjs";
import { nyseSessionPlan } from "./strategy.mjs";

const DAY_MS = 86_400_000;
const OFFHOURS = new Set(["premarket", "postmarket", "overnight", "offhours", "closed"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])
  );
  return value;
}

export function hashOffhoursEvidence(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function positive(value) {
  return value !== "" && value != null && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

function nonnegative(value) {
  return value !== "" && value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

function exactMultiplier(value) {
  const match = String(value ?? "").trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || positive(value) == null) return null;
  const integer = match[1].replace(/^0+(?=\d)/, ""), fraction = (match[2] || "").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function text(value) { return typeof value === "string" && value.trim().length > 0; }
function timestamp(value) { return typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN; }
function fresh(value, at, maxAgeMs) {
  const age = timestamp(at) - timestamp(value);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}
function unique(values) { return [...new Set(values)]; }
function rounded(value) { return Number.isFinite(value) ? Number(value.toFixed(12)) : null; }

function identity(value) {
  if (!value || !["SPY", "QQQ"].includes(value.ticker) || String(value.chainId) !== "56" ||
    !/^0x[0-9a-f]{40}$/i.test(value.contractAddress || "") || value.symbol !== `${value.ticker}on`) return null;
  return { ticker: value.ticker, symbol: value.symbol, chainId: "56", contractAddress: value.contractAddress.toLowerCase() };
}

function sameIdentity(left, right) {
  return identity(left) != null && JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

function referenceReasons(reference, ticker, at) {
  if (!reference) return ["REFERENCE_UNAVAILABLE"];
  const reasons = [];
  if (reference.kind !== "TRUSTED_FAIR_UNDERLYING" || reference.trusted !== true || reference.ticker !== ticker ||
    reference.unit !== "USDT_PER_UNDERLYING_SHARE" || positive(reference.fairUnderlyingPrice) == null) {
    reasons.push("REFERENCE_NOT_NORMALIZED_TO_ETF_SHARE");
  }
  if (!text(reference.source) || !text(reference.methodology) ||
    ["roll", "carry", "dividend", "etfMapping", "currency"].some(key => !text(reference.assumptions?.[key]))) {
    reasons.push("REFERENCE_PROVENANCE_INCOMPLETE");
  }
  if (!fresh(reference.observedAt, at, 120_000) || !fresh(reference.retrievedAt, at, 120_000) ||
    timestamp(reference.retrievedAt) < timestamp(reference.observedAt)) reasons.push("REFERENCE_STALE_OR_INVALID");
  const futures = reference.futures;
  const roots = ticker === "SPY" ? ["ES", "MES"] : ["NQ", "MNQ"];
  if (!roots.includes(futures?.root) || !text(futures?.contract) || !text(futures?.source) ||
    positive(futures?.price) == null || !(timestamp(futures?.expiresAt) > timestamp(at))) {
    reasons.push("FUTURES_PROVENANCE_INCOMPLETE");
  }
  if (!fresh(futures?.observedAt, at, 120_000) || timestamp(futures?.observedAt) > timestamp(reference.observedAt)) {
    reasons.push("FUTURES_STALE_OR_INVALID");
  }
  return reasons;
}

function sessionReasons(session, at) {
  if (!session) return ["NEXT_SESSION_WINDOW_UNAVAILABLE"];
  const previous = timestamp(session.previousCloseAt), open = timestamp(session.openAt), close = timestamp(session.closeAt);
  if (!text(session.source) || !fresh(session.knownAt, at, Infinity) ||
    !(previous <= timestamp(at) && timestamp(at) < open && open < close) ||
    open - previous > 4 * DAY_MS || close - open > 7 * 3_600_000) return ["NEXT_SESSION_WINDOW_INVALID"];
  const previousDate = newYorkDate(previous), openDate = newYorkDate(open);
  const plan = nyseSessionPlan(open), previousPlan = nyseSessionPlan(previous - 1);
  const expectedClose = newYorkSessionBounds(openDate).closeMs - (plan.calendarDayType === "early-close" ? 3 * 3_600_000 : 0);
  const expectedPrevious = newYorkSessionBounds(previousDate).closeMs - (previousPlan.calendarDayType === "early-close" ? 3 * 3_600_000 : 0);
  const dates = previousDate >= "2020-01-01" && openDate <= "2028-12-31" ? researchTradingDates(previousDate, openDate) : [];
  if (!plan.calendarSupported || !plan.regularOpen || previousDate >= openDate ||
    dates.length !== 2 || dates[0] !== previousDate || dates[1] !== openDate ||
    open !== newYorkSessionBounds(openDate).openMs || close !== expectedClose || previous !== expectedPrevious) {
    return ["NEXT_SESSION_WINDOW_INVALID"];
  }
  return [];
}

// Caller supplies measured timestamps. No clock, price fallback, wallet or order path.
export function buildOffhoursBasisObservation(input) {
  const { ticker, instrument, observedAt, assetStatus, marketStatus, rwaDynamic, reference, buyQuote, sellQuote, companyAction } = input;
  if (!Number.isFinite(timestamp(observedAt))) throw new Error("An absolute measured observedAt timestamp is required");
  const at = new Date(observedAt).toISOString();
  const reasons = [...(input.inputErrors || [])];
  const session = assetStatus?.marketStatus || "unknown";
  const verifiedIdentity = identity(instrument);
  if (!verifiedIdentity || instrument?.ticker !== ticker || Number(instrument?.type) !== 1) reasons.push("INSTRUMENT_IDENTITY_UNVERIFIED");
  if (!fresh(input.discoveredAt, at, 120_000)) reasons.push("DISCOVERY_STALE_OR_INVALID");
  if (!sameIdentity(instrument, input.dynamicIdentity) || rwaDynamic?.ticker !== ticker || rwaDynamic?.symbol !== instrument?.symbol ||
    (rwaDynamic?.chainId != null && String(rwaDynamic.chainId) !== String(instrument?.chainId)) ||
    (rwaDynamic?.contractAddress != null && rwaDynamic.contractAddress.toLowerCase() !== verifiedIdentity?.contractAddress)) {
    reasons.push("DYNAMIC_IDENTITY_MISMATCH");
  }
  const multiplier = positive(rwaDynamic?.tokenInfo?.sharesMultiplier);
  const multiplierExact = exactMultiplier(rwaDynamic?.tokenInfo?.sharesMultiplier);
  if (multiplierExact == null || exactMultiplier(instrument?.multiplier) == null) reasons.push("INVALID_MULTIPLIER");
  else if (multiplierExact !== exactMultiplier(instrument.multiplier)) reasons.push("MULTIPLIER_MISMATCH");
  if (!fresh(input.dynamicRetrievedAt, at, 120_000)) reasons.push("MULTIPLIER_STALE_OR_INVALID");
  if (assetStatus?.openState !== true || assetStatus?.reasonCode !== "TRADING") reasons.push("ASSET_NOT_TRADING");
  if (marketStatus?.openState !== true || ![null, "TRADING"].includes(marketStatus?.reasonCode)) reasons.push("MARKET_NOT_TRADING");
  if (!fresh(input.statusRetrievedAt, at, 10_000) || !fresh(input.marketRetrievedAt, at, 10_000)) reasons.push("MARKET_STATUS_STALE_OR_INVALID");
  if (session !== "regular" && !OFFHOURS.has(session)) reasons.push("MARKET_SESSION_UNKNOWN");
  const cashSession = nyseSessionPlan(timestamp(at));
  if (!cashSession.calendarSupported || (session === "regular") !== cashSession.regularOpen) reasons.push("MARKET_SESSION_CALENDAR_CONFLICT");
  if (companyAction?.ticker !== ticker || companyAction?.status !== "CLEAR" || !text(companyAction?.source)) reasons.push("COMPANY_ACTION_UNRESOLVED");
  if (!fresh(companyAction?.checkedAt, at, DAY_MS)) reasons.push("COMPANY_ACTION_STALE_OR_INVALID");

  for (const [side, quote] of [["BUY", buyQuote], ["SELL", sellQuote]]) {
    if (!quote) reasons.push(`${side}_QUOTE_UNAVAILABLE`);
    if (!sameIdentity(instrument, quote?.instrument)) reasons.push(`${side}_QUOTE_IDENTITY_MISMATCH`);
    if (!text(quote?.source)) reasons.push(`${side}_QUOTE_PROVENANCE_MISSING`);
    if (!Number.isFinite(timestamp(quote?.quotedAt))) reasons.push(`${side}_QUOTE_TIME_INVALID`);
    if (quote?.expiresAt != null && !(timestamp(quote.expiresAt) > timestamp(at))) reasons.push(`${side}_QUOTE_EXPIRED`);
  }
  if (timestamp(sellQuote?.quotedAt) < timestamp(buyQuote?.quotedAt)) reasons.push("QUOTE_SEQUENCE_INVALID");
  const referenceVetoes = referenceReasons(reference, ticker, at);
  reasons.push(...referenceVetoes);
  const tradeUsdt = positive(input.tradeUsdt);
  if (tradeUsdt == null) reasons.push("TRADE_AMOUNT_INVALID");
  const gas = nonnegative(input.estimatedRoundTripGasUsdt), buffer = nonnegative(input.executionBufferPct);
  const basis = buildExecutableBasisObservation({
    theoreticalPrice: { instrument: verifiedIdentity, observedAt: reference?.observedAt,
      theoreticalTokenPrice: referenceVetoes.length === 0 && multiplier != null ? Number(reference.fairUnderlyingPrice) * multiplier : null,
      vetoReasons: [] },
    tradeUsdt, buyQuote, sellQuote, observedAt: at,
    estimatedRoundTripGasUsdt: gas ?? -1, executionBufferPct: buffer ?? -1
  });
  // A nonpositive edge is an observation, not bad data. Do not select only winning samples.
  reasons.push(...basis.vetoReasons.filter(reason => reason !== "NET_EXECUTABLE_EDGE_NOT_POSITIVE"));
  basis.execution.buy.source = buyQuote?.source || null;
  basis.execution.sell.source = sellQuote?.source || null;
  basis.gasCostPct = gas == null ? null : basis.gasCostPct;
  basis.executionBufferPct = buffer;
  basis.eligibleForShadowSignal = false;
  basis.automaticTradingEligible = false;
  const vetoReasons = unique(reasons);
  const comparable = vetoReasons.length === 0;
  const pairingReasons = OFFHOURS.has(session) ? sessionReasons(input.nextSession, at) : [];
  const observation = {
    schemaVersion: 1, candidate: "F", observationType: "OFFHOURS_BASIS_RESEARCH", observedAt: at,
    ticker, instrument: verifiedIdentity, multiplier, multiplierExact, session, tradeUsdt,
    status: !buyQuote || !sellQuote ? "NO_QUOTE" : comparable ? "COMPARABLE" : "UNCOMPARABLE",
    evidenceLabel: comparable ? "QUOTE_SHADOW" : "OBSERVATION_ONLY", comparable,
    automaticTradingEligible: false, vetoReasons, pairingReasons,
    warnings: gas == null || buffer == null ? ["ALL_IN_COST_UNAVAILABLE"] : [],
    nextSession: input.nextSession || null, companyAction: companyAction || null,
    reference: reference || null, assetStatus: assetStatus || null, marketStatus: marketStatus || null,
    oracleContext: { tokenPrice: positive(rwaDynamic?.tokenInfo?.price), stockPrice: positive(rwaDynamic?.stockInfo?.price), evidenceLabel: "OBSERVATION_ONLY" },
    basis, inputHash: hashOffhoursEvidence(input)
  };
  return { ...observation, id: hashOffhoursEvidence(observation) };
}

function observationsAsOf(observations, asOf) {
  if (!Number.isFinite(timestamp(asOf))) throw new Error("An absolute asOf timestamp is required");
  return [...new Map(observations.filter(row => timestamp(row.observedAt) <= timestamp(asOf)).map(row => [row.id, row])).values()]
    .sort((a, b) => timestamp(a.observedAt) - timestamp(b.observedAt) || a.id.localeCompare(b.id));
}

export function pairOffhoursBasisObservations(observations, { asOf } = {}) {
  const rows = observationsAsOf(observations, asOf);
  const pending = new Map(), consumed = new Set(), pairs = [], rejectedPairs = [];
  for (const row of rows) {
    if (OFFHOURS.has(row.session) && row.pairingReasons.length === 0) {
      const key = `${row.ticker}:${newYorkDate(timestamp(row.nextSession.openAt))}`;
      if (!consumed.has(key)) pending.set(key, [...(pending.get(key) || []), row]);
    }
    if (row.session !== "regular") continue;
    for (const [overnightId, candidates] of pending) {
      if (candidates[0].ticker !== row.ticker || timestamp(candidates[0].observedAt) >= timestamp(row.observedAt)) continue;
      pending.delete(overnightId);
      consumed.add(overnightId);
      const off = candidates.filter(candidate => candidate.comparable).at(-1);
      const reasons = [];
      if (!off) reasons.push("NO_VALID_OFFHOURS_OBSERVATION");
      const baseline = off || candidates.at(-1);
      const openMs = timestamp(baseline.nextSession.openAt), atMs = timestamp(row.observedAt);
      if (!(atMs >= openMs && atMs < timestamp(baseline.nextSession.closeAt)) || atMs - openMs > 30 * 60_000) reasons.push("OUTSIDE_NEXT_SESSION_WINDOW");
      if (!row.comparable) reasons.push("FIRST_REGULAR_OBSERVATION_INVALID");
      const interval = rows.filter(item => item.ticker === row.ticker && timestamp(item.observedAt) >= timestamp(baseline.observedAt) && timestamp(item.observedAt) <= atMs);
      if (interval.some(item => !sameIdentity(baseline.instrument, item.instrument))) reasons.push("IDENTITY_CHANGED");
      if (interval.some(item => item.multiplierExact !== baseline.multiplierExact)) reasons.push("MULTIPLIER_CHANGED");
      if (interval.some(item => item.companyAction?.status !== "CLEAR")) reasons.push("COMPANY_ACTION_CHANGED_OR_UNKNOWN");
      if (baseline.tradeUsdt !== row.tradeUsdt) reasons.push("PAIR_TRADE_AMOUNT_MISMATCH");
      const pair = { id: hashOffhoursEvidence({ overnightId, offhoursId: baseline.id, regularId: row.id }),
        overnightId, sessionDate: newYorkDate(openMs), ticker: row.ticker,
        offhoursId: baseline.id, regularId: row.id, offhoursAt: baseline.observedAt, regularAt: row.observedAt,
        automaticTradingEligible: false, vetoReasons: reasons };
      if (reasons.length) { rejectedPairs.push(pair); continue; }
      const convergence = Math.abs(off.basis.buyBasisPct) - Math.abs(row.basis.buyBasisPct);
      const cost = off.basis.allInCostPct != null && row.basis.allInCostPct != null ? off.basis.allInCostPct + row.basis.allInCostPct : null;
      pairs.push({ ...pair, evidenceLabel: "QUOTE_SHADOW", offhoursBuyBasisPct: off.basis.buyBasisPct,
        regularBuyBasisPct: row.basis.buyBasisPct, offhoursSellBasisPct: off.basis.sellBasisPct, regularSellBasisPct: row.basis.sellBasisPct,
        absoluteBasisConvergencePct: rounded(convergence), conservativeTwoSnapshotCostPct: rounded(cost),
        costAdjustedConvergencePct: cost == null ? null : rounded(convergence - cost),
        interpretation: "DESCRIPTIVE_BASIS_CHANGE_NOT_EXECUTED_PNL" });
    }
  }
  return { pairs, rejectedPairs, pendingOvernights: pending.size, automaticTradingEligible: false };
}

export function summarizeOffhoursBasisResearch(observations, { asOf } = {}) {
  const rows = observationsAsOf(observations, asOf);
  const pairing = pairOffhoursBasisObservations(rows, { asOf });
  const independentOvernightSessions = new Set(pairing.pairs.map(pair => pair.sessionDate)).size;
  const start = Math.min(...pairing.pairs.map(pair => timestamp(pair.offhoursAt)));
  const end = Math.max(...pairing.pairs.map(pair => timestamp(pair.regularAt)));
  const spanWeeks = pairing.pairs.length ? (end - start) / (7 * DAY_MS) : 0;
  const reviewEligible = spanWeeks >= 8 && independentOvernightSessions >= 30;
  const distribution = key => {
    const values = pairing.pairs.map(pair => pair[key]).filter(Number.isFinite).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return { count: values.length, min: values[0] ?? null, max: values.at(-1) ?? null,
      mean: values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
      median: values.length ? rounded(values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null };
  };
  const reasonCounts = {};
  for (const row of rows) for (const reason of [...row.vetoReasons, ...row.pairingReasons, ...row.warnings]) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  return {
    schemaVersion: 1, candidate: "F", asOf,
    evidenceLabel: rows.some(row => row.comparable) ? "OBSERVATION_ONLY_AND_QUOTE_SHADOW" : "OBSERVATION_ONLY",
    totalObservations: rows.length, observationOnly: rows.filter(row => row.evidenceLabel === "OBSERVATION_ONLY").length,
    noQuote: rows.filter(row => row.status === "NO_QUOTE").length, uncomparable: rows.filter(row => row.status === "UNCOMPARABLE").length,
    comparable: rows.filter(row => row.comparable).length, validPairs: pairing.pairs.length, independentOvernightSessions,
    absoluteBasisConvergencePct: distribution("absoluteBasisConvergencePct"), costAdjustedConvergencePct: distribution("costAdjustedConvergencePct"),
    spanWeeks: rounded(spanWeeks), reviewEligible, decision: reviewEligible ? "REVIEW_ONLY" : "INSUFFICIENT_EVIDENCE",
    automaticTradingEligible: false, reasonCounts, ...pairing
  };
}
