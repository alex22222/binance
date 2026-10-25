import { readAssetAiStatus, reviewPersonalAssets, configureAssetAi } from "./personal-assets-ai.mjs";
import { readAssetFundStatus, configureAssetFund } from "./personal-assets-funds.mjs";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { personalAssetsHtml } from "./personal-assets-html.mjs";
import { readPersonalAssets, savePersonalAssets, createPersonalAssetsSnapshot } from "./personal-assets.mjs";
import { valuePersonalAssetState } from "./personal-assets-fx.mjs";
import { readAssetSyncStatus, performAssetSyncAction, completeFutuAuthorization } from "./personal-assets-sync.mjs";

const sourceFile = (name) => fileURLToPath(new URL(name, import.meta.url));
const files = new Map([
  ["/assets/app.mjs", { path: sourceFile("personal-assets-client.mjs"), type: "text/javascript; charset=utf-8" }],
  ["/assets/core.mjs", { path: sourceFile("personal-assets-core.mjs"), type: "text/javascript; charset=utf-8" }]
]);
for (const name of [
  "tesseract.min.js", "tesseract.min.js.LICENSE.txt", "worker.min.js", "worker.min.js.LICENSE.txt", "NOTICE.txt",
  "core/LICENSE", "core/tesseract-core-lstm.wasm.js", "core/tesseract-core-simd-lstm.wasm.js", "core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "lang/eng.traineddata.gz", "lang/chi_sim.traineddata.gz", "lang/chi_tra.traineddata.gz"
]) {
  files.set(`/assets/ocr/${name}`, {
    path: sourceFile(`../assets/personal-assets/ocr/${name}`),
    type: name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".gz") ? "application/gzip" : "text/plain; charset=utf-8"
  });
}

function requestError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function json(response, data, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function sessionBinding(request) {
  const session = String(request.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("dashboard_session="));
  return session || request.headers.authorization || "";
}

async function assetView(state, options) {
  const [valued, sync] = await Promise.all([valuePersonalAssetState(state, options), readAssetSyncStatus({ stateDir: options.stateDir }).catch(() => ({
    status: "unavailable", error: "同步状态暂不可用，请检查同步配置；已保存资产仍可查看。", providers: {},
  }))]);
  const funds = await readAssetFundStatus({ stateDir: options.stateDir, state }).catch(() => ({ status: "unavailable", bindings: [] }));
  return { ...valued, funds, sync: { ...sync, providers: Object.fromEntries(Object.entries(sync.providers).map(([name, details]) => {
    const { preview, accounts, selectedAccountId, wallets, ...summary } = details;
    return [name, summary];
  })) } };
}

async function readAssetBody(request) {
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw requestError("请使用 JSON 格式提交资产。", 415);
  }
  const body = await new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let oversized = false;
    request.on("data", (chunk) => {
      if (oversized) return;
      size += chunk.length;
      if (size > 1_500_000) {
        oversized = true;
        chunks = [];
        reject(requestError("资产数据过大，请减少本次记录数量。", 413));
      } else chunks.push(chunk);
    });
    request.once("end", () => { if (!oversized) resolve(Buffer.concat(chunks).toString("utf8")); });
    request.once("error", reject);
  });
  try {
    const data = JSON.parse(body);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw requestError("无法读取资产数据，请检查格式。", 400);
  }
}

// Called only after the Dashboard's shared authentication gate.
export async function handlePersonalAssetsRequest({ request, response, stateDir, requireAllowedOrigin }) {
  const path = new URL(request.url, "http://localhost").pathname;
  // The site lands on personal assets. The trading dashboard moved to
  // /dashboard, but the Dashboard entry's own "/" route (which the
  // authorization loader extends) still renders it, so hand the request back.
  if (request.method === "GET" && path === "/") {
    response.writeHead(302, { Location: "/assets", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end();
    return true;
  }
  if (request.method === "GET" && ["/dashboard", "/dashboard/"].includes(path)) {
    request.url = "/";
    return false;
  }
  const assetApi = ["/api/assets", "/api/assets/snapshots", "/api/assets/rates/refresh", "/api/assets/funds/configure"].includes(path);
  const syncAction = path.match(/^\/api\/assets\/sync\/(okx|futu|polymarket|future|okxweb3|tokenpocket|binanceagentic|okxagentic)\/(bind|connect|authorize|accounts|preview|apply|disconnect)$/);
  const aiApi = ["/api/assets/ai", "/api/assets/ai/review", "/api/assets/ai/configure"].includes(path);
  const syncApi = path === "/api/assets/sync" || path === "/api/assets/sync/futu/callback" || syncAction;
  const file = files.get(path);
  if (!["/assets", "/assets/"].includes(path) && !assetApi && !syncApi && !aiApi && !file) return false;
  try {
    if (request.method === "GET" && path === "/api/assets/sync/futu/callback") {
      let success = false;
      try {
        await completeFutuAuthorization({ stateDir, query: Object.fromEntries(new URL(request.url, "http://localhost").searchParams), sessionBinding: sessionBinding(request) });
        success = true;
      } catch {}
      response.writeHead(303, { Location: `/assets?sync=${success ? "futu-authorized" : "futu-error"}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      response.end();
      return true;
    }
    if (request.method === "GET" && ["/assets", "/assets/"].includes(path)) {
      const nonce = randomBytes(16).toString("base64");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "X-Content-Type-Options": "nosniff"
      });
      response.end(personalAssetsHtml({ nonce }));
      return true;
    }
    if (request.method === "GET" && file) {
      const body = await readFile(file.path);
      response.writeHead(200, {
        "Content-Type": file.type,
        "Cache-Control": path.endsWith(".mjs") ? "no-store" : "private, max-age=86400",
        "Content-Length": body.length,
        "X-Content-Type-Options": "nosniff"
      });
      response.end(body);
      return true;
    }
    if (request.method === "GET" && path === "/api/assets") {
      json(response, await assetView(await readPersonalAssets({ stateDir }), { stateDir }));
      return true;
    }
    if (request.method === "POST" && path === "/api/assets/funds/configure") {
      if (!request.headers.origin) throw requestError("请从资产页面提交。", 403);
      requireAllowedOrigin(request);
      const body = await readAssetBody(request);
      const assets = await configureAssetFund({ stateDir, entryId: body.entryId, isin: body.isin, symbol: body.symbol, quantity: body.quantity, quantityBasis: body.quantityBasis, confirmedOn: body.confirmedOn, revision: body.revision });
      json(response, await assetView(assets, { stateDir }));
      return true;
    }
    if (request.method === "POST" && path === "/api/assets/rates/refresh") {
      if (!request.headers.origin) throw requestError("请从资产页面提交。", 403);
      requireAllowedOrigin(request);
      await readAssetBody(request);
      json(response, await assetView(await readPersonalAssets({ stateDir }), { stateDir, force: true }));
      return true;
    }
    if (request.method === "GET" && path === "/api/assets/ai") {
      json(response, await readAssetAiStatus({ stateDir }));
      return true;
    }
    if (request.method === "POST" && ["/api/assets/ai/review", "/api/assets/ai/configure"].includes(path)) {
      if (!request.headers.origin) throw requestError("请从资产页面提交。", 403);
      requireAllowedOrigin(request);
      const body = await readAssetBody(request);
      const assets = await assetView(await readPersonalAssets({ stateDir }), { stateDir });
      const action = path.endsWith("/configure") ? configureAssetAi : reviewPersonalAssets;
      json(response, await action({ stateDir, assets, ...(path.endsWith("/configure") ? { apiKey: body.apiKey } : {}) }));
      return true;
    }
    if (request.method === "GET" && path === "/api/assets/sync") {
      json(response, await readAssetSyncStatus({ stateDir }));
      return true;
    }
    if (request.method === "POST" && syncAction) {
      if (!request.headers.origin) throw requestError("请从资产页面提交。", 403);
      requireAllowedOrigin(request);
      const body = await readAssetBody(request);
      const result = await performAssetSyncAction({ stateDir, provider: syncAction[1], action: syncAction[2], body, sessionBinding: sessionBinding(request) });
      if (result.assets) result.assets = await assetView(result.assets, { stateDir });
      json(response, result);
      return true;
    }
    if ((request.method === "PUT" && path === "/api/assets") || (request.method === "POST" && path === "/api/assets/snapshots")) {
      if (!request.headers.origin) throw requestError("请从资产页面提交。", 403);
      requireAllowedOrigin(request);
      const body = await readAssetBody(request);
      const current = await readPersonalAssets({ stateDir });
      let state;
      if (path === "/api/assets") {
        state = await savePersonalAssets({ stateDir, portfolio: { ...body.portfolio, rates: current.portfolio.rates }, revision: body.revision });
      } else {
        const valued = await valuePersonalAssetState(current, { stateDir });
        state = await createPersonalAssetsSnapshot({ stateDir, revision: body.revision, valuation: { rates: valued.portfolio.rates, fx: valued.fx } });
      }
      json(response, await assetView(state, { stateDir }));
      return true;
    }
    json(response, { error: "不支持这个请求方法。" }, 405);
  } catch (error) {
    const status = error.statusCode || 500;
    json(response, { error: status >= 500 && !error.assetAiError && !error.fundError ? "个人资产暂时无法读取或保存，请稍后重试。" : error.message }, status);
  }
  return true;
}
