import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardAllowedOrigins,
  dashboardAuthConfig,
  dashboardRequestAuthorized,
  dashboardSessionAuthorized,
  dashboardSessionCookie
} from "../src/dashboard-auth.mjs";

function request(authorization) {
  return { headers: authorization ? { authorization } : {} };
}

test("dashboard authentication is optional for loopback-only development", () => {
  const config = dashboardAuthConfig({});
  assert.deepEqual(config, { enabled: false });
  assert.equal(dashboardRequestAuthorized(request(), config), true);
});

test("dashboard authentication requires username and password together", () => {
  assert.throws(
    () => dashboardAuthConfig({ DASHBOARD_USERNAME: "operator" }),
    /must be configured together/
  );
  assert.throws(
    () => dashboardAuthConfig({ DASHBOARD_PASSWORD: "secret" }),
    /must be configured together/
  );
});

test("dashboard authentication accepts only the exact basic credentials", () => {
  const config = dashboardAuthConfig({
    DASHBOARD_USERNAME: "operator",
    DASHBOARD_PASSWORD: "correct horse"
  });
  const valid = `Basic ${Buffer.from("operator:correct horse").toString("base64")}`;
  const invalid = `Basic ${Buffer.from("operator:wrong").toString("base64")}`;
  assert.equal(dashboardRequestAuthorized(request(valid), config), true);
  assert.equal(dashboardRequestAuthorized(request(invalid), config), false);
  assert.equal(dashboardRequestAuthorized(request(), config), false);
});

test("dashboard session cookies are signed and expire after twelve hours", () => {
  const config = dashboardAuthConfig({
    DASHBOARD_USERNAME: "operator",
    DASHBOARD_PASSWORD: "correct horse"
  });
  const nowMs = Date.parse("2026-07-26T10:00:00.000Z");
  const cookie = dashboardSessionCookie(config, nowMs).split(";")[0];
  const sessionRequest = { headers: { cookie } };

  assert.equal(dashboardRequestAuthorized(sessionRequest, config, nowMs + 1_000), true);
  assert.equal(dashboardRequestAuthorized(sessionRequest, config, nowMs + 12 * 60 * 60 * 1_000 + 1), false);
  assert.equal(
    dashboardRequestAuthorized({ headers: { cookie: `${cookie}tampered` } }, config, nowMs + 1_000),
    false
  );
});

test("a remembered device stays signed in for thirty days until the password changes", () => {
  const config = dashboardAuthConfig({ DASHBOARD_USERNAME: "operator", DASHBOARD_PASSWORD: "correct horse" });
  const nowMs = Date.parse("2026-10-07T10:00:00.000Z");
  const header = dashboardSessionCookie(config, nowMs, { remember: true });
  assert.match(header, /; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
  assert.match(dashboardSessionCookie(config, nowMs), /; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);
  const sessionRequest = { headers: { cookie: header.split(";")[0] } };
  assert.equal(dashboardSessionAuthorized(sessionRequest, config, nowMs + 29 * 86_400_000), true);
  assert.equal(dashboardSessionAuthorized(sessionRequest, config, nowMs + 30 * 86_400_000 + 1), false);
  const rotated = dashboardAuthConfig({ DASHBOARD_USERNAME: "operator", DASHBOARD_PASSWORD: "new battery staple" });
  assert.equal(dashboardSessionAuthorized(sessionRequest, rotated, nowMs + 1_000), false);
  assert.equal(dashboardSessionAuthorized({ headers: { authorization: `Basic ${Buffer.from("operator:correct horse").toString("base64")}` } }, config), false,
    "only a session cookie skips the login form; Basic credentials do not");
  assert.equal(dashboardSessionAuthorized(sessionRequest, dashboardAuthConfig({}), nowMs), false);
});

test("dashboard allowed origins include loopback and configured HTTPS origins", () => {
  const origins = dashboardAllowedOrigins({
    host: "127.0.0.1",
    port: 4173,
    environment: {
      DASHBOARD_PUBLIC_ORIGIN: "https://stocks.example.com/, https://backup.example.com"
    }
  });
  assert.deepEqual([...origins], [
    "http://127.0.0.1:4173",
    "https://stocks.example.com",
    "https://backup.example.com"
  ]);
});
