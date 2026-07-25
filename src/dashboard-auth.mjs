import { createHmac, timingSafeEqual } from "node:crypto";

const sessionCookieName = "dashboard_session";
const sessionMaxAgeSeconds = 12 * 60 * 60;

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

export function dashboardCredentialsAuthorized(username, password, config) {
  return (
    config.enabled &&
    equalString(username, config.username) &&
    equalString(password, config.password)
  );
}

function basicRequestAuthorized(request, config) {
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
  return dashboardCredentialsAuthorized(
    decoded.slice(0, separator),
    decoded.slice(separator + 1),
    config
  );
}

function sessionSignature(config, expiresAtMs) {
  return createHmac("sha256", config.password)
    .update(`dashboard-session:${config.username}:${expiresAtMs}`)
    .digest("base64url");
}

export function dashboardSessionCookie(config, nowMs = Date.now()) {
  const expiresAtMs = nowMs + sessionMaxAgeSeconds * 1000;
  const value = `${expiresAtMs}.${sessionSignature(config, expiresAtMs)}`;
  return `${sessionCookieName}=${value}; Path=/; Max-Age=${sessionMaxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function sessionRequestAuthorized(request, config, nowMs) {
  const cookie = String(request.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookieName}=`));
  if (!cookie) return false;
  const value = cookie.slice(sessionCookieName.length + 1);
  const separator = value.indexOf(".");
  if (separator < 0) return false;
  const expiresAtMs = Number(value.slice(0, separator));
  if (!Number.isFinite(expiresAtMs) || nowMs > expiresAtMs) return false;
  return equalString(
    value.slice(separator + 1),
    sessionSignature(config, expiresAtMs)
  );
}

export function dashboardRequestAuthorized(request, config, nowMs = Date.now()) {
  if (!config.enabled) return true;
  return (
    basicRequestAuthorized(request, config) ||
    sessionRequestAuthorized(request, config, nowMs)
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
