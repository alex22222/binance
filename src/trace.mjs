import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const sensitiveKey = /secret|token|authorization|webhook|api.?key|password|session/i;

function redact(value, key = "") {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redact(childValue, childKey)
    ]));
  }
  return value;
}

export function createTracer(path, { runId }) {
  let sequence = 0;
  let writes = Promise.resolve();

  return async function trace(event, status, details = {}, cycleId = null) {
    const record = {
      timestamp: new Date().toISOString(),
      runId,
      cycleId,
      sequence: sequence += 1,
      event,
      status,
      details: redact(details)
    };
    writes = writes.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    });
    await writes;
  };
}
