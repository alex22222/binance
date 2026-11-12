const WINDOW_MS = 15 * 60 * 1000;
const FAILURE_LIMIT = 8;

export function loginClientKey(request) {
  const remote = String(request.socket?.remoteAddress || "");
  const forwarded = String(request.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const key = loopback && forwarded ? forwarded : remote;
  return key || "unknown";
}

export function createLoginLimiter({ limit = FAILURE_LIMIT, windowMs = WINDOW_MS, now = () => Date.now() } = {}) {
  const failures = new Map();
  function entry(key) {
    const current = failures.get(key) || { times: [] };
    const at = now();
    current.times = current.times.filter((time) => at - time < windowMs);
    if (current.times.length) failures.set(key, current);
    else failures.delete(key);
    return current;
  }
  return {
    blocked(key) { return entry(key).times.length >= limit; },
    recordFailure(key) {
      const current = entry(key);
      current.times.push(now());
      failures.set(key, current);
      return current.times.length >= limit;
    },
    recordSuccess(key) { failures.delete(key); }
  };
}
