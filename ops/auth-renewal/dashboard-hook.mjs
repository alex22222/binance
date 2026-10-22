import { createHash } from "node:crypto";

let settings;

export function initialize(data) {
  settings = data;
}

export function transformDashboardSource(source, { dashboardSourceHash, publicStatusURL }) {
  if (createHash("sha256").update(source).digest("hex") !== dashboardSourceHash) {
    throw new Error("Dashboard source hash mismatch");
  }
  const guard = "    if (!requireAuthentication(request, response)) return;";
  const home = "      response.end(liveDashboardHtml());";
  if (source.split(guard).length !== 2 || source.split(home).length !== 2 || source.indexOf(guard) > source.indexOf(home)) {
    throw new Error("Dashboard injection anchors must each occur once in order");
  }
  return source.replace(guard, `${guard}
    const authorizationStatusModule = await import(${JSON.stringify(publicStatusURL)});
    if (new URL(request.url, "http://localhost").pathname === "/api/buy-authorization-status") {
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (request.method !== "GET") {
        response.writeHead(405, { ...headers, "Allow": "GET" });
        response.end(JSON.stringify({ error: "Read-only endpoint" }));
        return;
      }
      response.writeHead(200, headers);
      response.end(JSON.stringify(await authorizationStatusModule.readPublicStatus()));
      return;
    }`).replace(home, "      response.end(authorizationStatusModule.withAuthorizationBanner(liveDashboardHtml()));");
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== settings?.dashboardURL) return result;
  if (result.format !== "module") throw new Error("Dashboard must be an ES module");
  return { ...result, source: transformDashboardSource(typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8"), settings) };
}
