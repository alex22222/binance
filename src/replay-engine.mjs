export function createReplayFrames(timestamps, { intervalMs = 60_000 } = {}) {
  if (!(Number.isFinite(intervalMs) && intervalMs > 0)) {
    throw new Error("Replay interval must be positive");
  }
  if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) {
    throw new Error("Replay timestamp must be finite");
  }
  return [...new Set(timestamps)]
    .sort((left, right) => left - right)
    .map((marketTime, index) => ({
      sequence: index + 1,
      marketTime,
      frontierTime: marketTime + intervalMs
    }));
}

export function createReplayRecorder({ includeEvents = false } = {}) {
  const eventCounts = {};
  const events = [];
  let sequence = 0;
  let lastFrontierTime = -Infinity;

  function record(type, frame, data = {}) {
    if (!(Number.isFinite(frame?.marketTime) && Number.isFinite(frame?.frontierTime))) {
      throw new Error("Replay event requires a valid frame");
    }
    if (frame.frontierTime < lastFrontierTime) {
      throw new Error("Replay event frontier must not regress");
    }
    lastFrontierTime = frame.frontierTime;
    eventCounts[type] = (eventCounts[type] || 0) + 1;
    sequence += 1;
    if (includeEvents) {
      events.push({
        ...data,
        sequence,
        type,
        marketTime: frame.marketTime,
        frontierTime: frame.frontierTime
      });
    }
  }

  function snapshot() {
    return {
      eventCounts: { ...eventCounts },
      ...(includeEvents ? { events: [...events] } : {})
    };
  }

  return { record, snapshot };
}
