import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardAllowedOrigins,
  dashboardAuthConfig,
  dashboardRequestAuthorized
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
