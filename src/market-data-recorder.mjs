import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

function partitionDate(timestamp, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

export function normalizeCandles(candles) {
  return candles.map((candle) => ({
    openTime: Number(candle[0]),
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[5]),
    closeTime: Number(candle[6])
  }));
}

export function createMarketDataRecorder(directory, {
  runId,
  timeZone = "Asia/Shanghai"
}) {
  let sequence = 0;
  let writes = Promise.resolve();

  return async function record(recordType, data, timestamp = new Date().toISOString()) {
    const recordedAt = new Date(timestamp).toISOString();
    const recordValue = {
      schemaVersion: 1,
      recordedAt,
      runId,
      sequence: sequence += 1,
      recordType,
      ...data
    };
    const path = join(directory, `${partitionDate(recordedAt, timeZone)}.jsonl`);
    writes = writes.then(async () => {
      await mkdir(directory, { recursive: true });
      await appendFile(path, `${JSON.stringify(recordValue)}\n`, { mode: 0o600 });
    });
    await writes;
    return recordValue;
  };
}
