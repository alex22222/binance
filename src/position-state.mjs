function sameText(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function matchesPosition(position, target) {
  if (!position || !target) return false;
  const symbolMatches = target.symbol == null || sameText(position.symbol, target.symbol);
  const addressMatches = target.address == null || sameText(position.address, target.address);
  return symbolMatches && addressMatches;
}

export function openPositions(state) {
  if (Array.isArray(state?.positions)) return state.positions.filter(Boolean);
  return state?.position ? [state.position] : [];
}

export function migratePositionState(state = {}) {
  const { position, ...current } = state;
  return {
    ...current,
    positions: Array.isArray(state.positions)
      ? state.positions.filter(Boolean)
      : position
        ? [position]
        : []
  };
}

export function entryCapacityDecision(state, maxOpenPositions) {
  const count = openPositions(state).length;
  return {
    allowed: count < maxOpenPositions,
    reason: count < maxOpenPositions ? "CAPACITY_AVAILABLE" : "MAX_OPEN_POSITIONS",
    openPositionCount: count,
    maxOpenPositions,
    availableSlots: Math.max(0, maxOpenPositions - count)
  };
}

export function findOpenPosition(state, target) {
  return openPositions(state).find((position) => matchesPosition(position, target)) || null;
}

export function heldPositionSymbols(state) {
  return new Set(openPositions(state).map((position) => String(position.symbol).toUpperCase()));
}

export function addOpenPosition(state, position, maxOpenPositions) {
  const positions = openPositions(state);
  const duplicate = positions.some((current) => (
    (current.symbol && position.symbol && sameText(current.symbol, position.symbol)) ||
    (current.address && position.address && sameText(current.address, position.address))
  ));
  if (duplicate) throw new Error(`Position is already open for ${position.symbol}`);
  if (positions.length >= maxOpenPositions) {
    throw new Error(`Maximum open positions reached: ${maxOpenPositions}`);
  }
  state.positions = [...positions, position];
  delete state.position;
  return position;
}

export function removeOpenPosition(state, target) {
  const positions = openPositions(state);
  const index = positions.findIndex((position) => matchesPosition(position, target));
  if (index < 0) throw new Error(`Open position not found for ${target?.symbol || target?.address || "target"}`);
  const [removed] = positions.splice(index, 1);
  state.positions = positions;
  delete state.position;
  return removed;
}
