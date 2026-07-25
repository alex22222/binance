import { timingSafeEqual } from "node:crypto";

function equalString(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function dashboardAuthConfig(environment = process.env) {
  const username = environment.DASHBOARD_USERNAME?.trim() || "";
  const password = environment.DASHBOARD_PASSWORD || "";
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("DASHBOARD_USERNAME and DASHBOARD_PASSWORD must be configured together");
  }
  return username ? { enabled: true, username, password } : { enabled: false };
}

export function dashboardRequestAuthorized(request, config) {
  if (!config.enabled) return true;
  const authorization = request.headers.authorization || "";
  if (!authorization.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return (
    equalString(decoded.slice(0, separator), config.username) &&
    equalString(decoded.slice(separator + 1), config.password)
  );
}

export function dashboardAllowedOrigins({ host, port, environment = process.env }) {
  const origins = new Set([`http://${host}:${port}`]);
  for (const origin of String(environment.DASHBOARD_PUBLIC_ORIGIN || "").split(",")) {
    const normalized = origin.trim().replace(/\/$/, "");
    if (normalized) origins.add(normalized);
  }
  return origins;
}
