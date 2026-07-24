#!/usr/bin/env node
// 飞书信号 → 本地仪表盘确认 监控器
// 轮询飞书群消息，发现 [Agentic Stock Bot] BUY/SELL SUBMITTED 信号后，
// 通过 Kimi WebBridge 在 http://127.0.0.1:4173/ 的“待确认订单”卡中
// （必要时先勾选“审计数据不可用”复选框）点击“确认买入/确认卖出”。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(DIR, "state.json");
const LOG_FILE = path.join(DIR, "watch.log");

const CHAT_ID = "oc_30d5acfaae4ea1eb5b66fc767d20399c";
const DASHBOARD_URL = "http://127.0.0.1:4173/";
const WEBBRIDGE = "http://127.0.0.1:10086/command";
const SESSION = "feishu-order-watch";
const POLL_MS = 15_000;
const CARD_WAIT_MS = 180_000; // 信号出现后等待卡片出现的最长时间
const CARD_RETRY_MS = 5_000;

const PROXY_ENV = {
  ...process.env,
  HTTP_PROXY: "http://127.0.0.1:7890",
  HTTPS_PROXY: "http://127.0.0.1:7890",
  NO_PROXY: "127.0.0.1,localhost",
};

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

async function keychain(service) {
  const { stdout } = await execFileP("security", ["find-generic-password", "-a", "henry", "-s", service, "-w"]);
  return stdout.trim();
}

async function curlJson(url, { method = "GET", headers = {}, body, proxy = true } = {}) {
  const args = ["-s", "-X", method];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (body !== undefined) args.push("-d", typeof body === "string" ? body : JSON.stringify(body));
  args.push(url);
  const env = proxy ? PROXY_ENV : { ...process.env, NO_PROXY: "*" };
  let stdout;
  try {
    ({ stdout } = await execFileP("curl", args, { env, maxBuffer: 8 * 1024 * 1024, timeout: 20_000 }));
  } catch (err) {
    // 不回显命令行（headers/body 含凭据），只保留 curl 退出码与 stderr
    const stderr = String(err.stderr || "").replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`curl ${method} ${url} failed: exit=${err.code ?? err.signal ?? "?"}${stderr ? " " + stderr : ""}`);
  }
  return JSON.parse(stdout);
}

// ---------- 飞书 ----------
let feishu = { appId: null, appSecret: null, token: null, tokenExpiresAt: 0 };

async function feishuToken() {
  if (feishu.token && feishu.tokenExpiresAt > Date.now() + 60_000) return feishu.token;
  const res = await curlJson("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { app_id: feishu.appId, app_secret: feishu.appSecret },
  });
  if (res.code !== 0) throw new Error("tenant_access_token failed: " + JSON.stringify(res));
  feishu.token = res.tenant_access_token;
  feishu.tokenExpiresAt = Date.now() + res.expire * 1000;
  return feishu.token;
}

async function fetchRecentMessages() {
  const token = await feishuToken();
  const res = await curlJson(
    `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${CHAT_ID}&sort_type=ByCreateTimeDesc&page_size=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.code !== 0) throw new Error("list messages failed: " + JSON.stringify(res));
  return res.data.items || [];
}

function parseSignal(msg) {
  if (msg.msg_type !== "text") return null;
  let text;
  try {
    text = JSON.parse(msg.body.content).text || "";
  } catch {
    return null;
  }
  const m = text.match(/\[Agentic Stock Bot\]\s+(BUY|SELL)\s+SUBMITTED/);
  if (!m) return null;
  const line2 = (text.split("\n")[1] || "").trim().split(/\s+/);
  const symbol = line2[0] || null;
  const address = (line2[1] || "").match(/^0x[0-9a-fA-F]{40}$/) ? line2[1].toLowerCase() : null;
  const order = (text.match(/订单[:：]\s*(\S+)/) || [])[1] || null;
  return { side: m[1], symbol, address, order, text, messageId: msg.message_id, createTime: Number(msg.create_time) };
}

// ---------- WebBridge ----------
async function wb(action, args = {}) {
  const res = await curlJson(WEBBRIDGE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { action, args, session: SESSION },
    proxy: false,
  });
  const data = res.data ?? res;
  if (res.ok === false || data.success === false) throw new Error(`webbridge ${action} failed: ` + JSON.stringify(res));
  return data;
}

let tabReady = false;

async function ensureTab(force = false) {
  if (tabReady && !force) return;
  try {
    const tab = await wb("find_tab", { url: DASHBOARD_URL });
    if (tab?.tabId) { tabReady = true; return; }
  } catch { /* not open yet */ }
  await wb("navigate", { url: DASHBOARD_URL, newTab: true, group_title: "飞书信号盯盘" });
  tabReady = true;
}

// 页面内原子操作（单次 evaluate）：
// 0. 可选先强制执行页面全局 refresh() —— 后台标签页的 setInterval 会被 Chrome 节流到 1 分钟级，
//    不强制刷新的话卡片最长可能滞后 1 分钟以上才出现
// 1. 定位“待确认订单”卡，校验 方向/标的/合约地址 与信号一致
// 2. 若有“审计数据不可用”复选框 → 先勾选并验证生效（兜底：置位+补发 change）
// 3. 按钮可用后点击（勾选→点击在同一同步任务内完成，渲染间隙不会丢状态）
function buildAttemptJs(signal, click, forceRefresh = true) {
  return `(async () => {
    ${forceRefresh ? "try { if (typeof refresh === 'function') await refresh(); } catch (e) {}" : ""}
    const btns = [...document.querySelectorAll("button.approval-button.approve")];
    if (!btns.length) return { status: "not-found" };
    const btn = btns[0];
    const panel = btn.closest(".approval") || document;
    const title = (panel.querySelector(".approval-title")?.textContent || "").trim();
    const badge = (panel.querySelector(".approval-head .badge")?.textContent || "").trim();
    const contract = (panel.querySelector(".approval-head .contract")?.textContent || "").trim().toLowerCase();
    const btnText = btn.textContent.trim();
    const expectedBtn = ${JSON.stringify(signal.side === "BUY" ? "确认买入" : "确认卖出")};
    if (btnText !== expectedBtn) return { status: "mismatch", detail: "button=" + btnText + " title=" + title, badge };
    const wantSymbol = ${JSON.stringify(signal.symbol || null)};
    if (wantSymbol && title && !title.toUpperCase().includes(wantSymbol.toUpperCase()))
      return { status: "mismatch", detail: "title=" + title, badge };
    const wantAddr = ${JSON.stringify(signal.address || null)};
    if (wantAddr && contract && !contract.includes(wantAddr))
      return { status: "mismatch", detail: "contract=" + contract + " want=" + wantAddr, badge };
    if (!${click ? "true" : "false"}) return { status: "ready", detail: "title=" + title, badge };
    const check = panel.querySelector("label.approval-check input[type=checkbox]");
    let auditChecked = null;
    if (check) {
      if (!check.checked) check.click(); // 触发 change → 同步解锁按钮
      if (!check.checked) { // 兜底：直接置位并补发事件
        check.checked = true;
        check.dispatchEvent(new Event("change", { bubbles: true }));
      }
      auditChecked = check.checked;
      if (!auditChecked) return { status: "audit-check-failed", badge };
    }
    if (btn.disabled) return { status: "disabled", detail: "auditChecked=" + auditChecked, badge };
    btn.click();
    return { status: "clicked", detail: "title=" + title + " auditChecked=" + auditChecked, badge };
  })()`;
}
// 点击后验证：结果区“已提交”/按钮禁用/卡片消失 = 成功；“决策未记录” = 后端拒绝，不可重试
const VERIFY_JS = `(() => {
  const result = (document.querySelector(".approval .approval-result")?.textContent || "").trim();
  const btn = document.querySelector("button.approval-button.approve");
  if (result.includes("决策未记录")) return { status: "submit-error", detail: result };
  if (result.includes("已提交")) return { status: "verified", detail: result };
  if (!btn) return { status: "verified", detail: "卡片已消失(已处理)" };
  if (btn.disabled) return { status: "verified", detail: "按钮已禁用(已提交) result=" + result };
  return { status: "unverified", detail: "result=" + result };
})()`;

async function evaluate(js) {
  const res = await wb("evaluate", { code: js });
  return res.value ?? res;
}

async function handleSignal(signal) {
  log(`新信号: ${signal.side} ${signal.symbol || ""} ${signal.address || ""} 订单=${signal.order || "?"} (${signal.messageId})`);
  await ensureTab();
  const deadline = Date.now() + CARD_WAIT_MS;
  const fastUntil = Date.now() + 30_000;
  let lastNote = "";
  let clicks = 0;
  while (Date.now() < deadline) {
    try {
      const attempt = await evaluate(buildAttemptJs(signal, true));
      if (attempt.status === "clicked") {
        clicks += 1;
        log(`已点击确认按钮(${attempt.detail})，验证提交结果…`);
        // 页面每 3s 重渲染一次：等满一个渲染周期再验证，未决再补一次，避免误重试导致重复提交
        let verify = null;
        for (const wait of [3200, 2000]) {
          await new Promise(r => setTimeout(r, wait));
          verify = await evaluate(VERIFY_JS);
          if (verify.status !== "unverified") break;
        }
        if (verify.status === "verified") {
          log(`已确认: ${signal.side} ${signal.symbol} → ${verify.detail}`);
          return;
        }
        if (verify.status === "submit-error") {
          log(`提交被后端拒绝: ${verify.detail}，放弃重试: ${signal.side} ${signal.symbol}`);
          return;
        }
        log(`提交未确认(${verify.detail})` + (clicks < 3 ? "，重试点击…" : "，已达重试上限"));
        if (clicks >= 3) return;
      } else if (attempt.status === "not-found") {
        if (lastNote !== "not-found") { log("等待“待确认订单”卡片出现…"); lastNote = "not-found"; }
      } else if (attempt.status === "disabled") {
        const note = `disabled:${attempt.badge}`;
        if (lastNote !== note) { log(`按钮不可用 badge=${attempt.badge || "?"} (${attempt.detail || ""})`); lastNote = note; }
        if ((attempt.badge || "").includes("过期")) { log(`审批已过期，放弃: ${signal.side} ${signal.symbol}`); return; }
      } else {
        const note = `${attempt.status}:${attempt.detail}`;
        if (lastNote !== note) { log(`未就绪: ${attempt.status} ${attempt.detail || ""} badge=${attempt.badge || ""}`); lastNote = note; }
      }
    } catch (err) {
      log(`页面操作出错: ${err.message}`);
      tabReady = false;
      try { await ensureTab(true); } catch { /* ignore */ }
    }
    // 自适应间隔：信号后前 30s 每 2s 一探（卡片通常立刻出现），之后每 5s
    await new Promise(r => setTimeout(r, Date.now() < fastUntil ? 2000 : CARD_RETRY_MS));
  }
  log(`超时: 等待“待确认订单”卡片超过 ${CARD_WAIT_MS / 1000}s，信号未处理: ${signal.side} ${signal.symbol}`);
}

// ---------- 主循环 ----------
async function main() {
  feishu.appId = await keychain("binance-stock-bot-feishu-app-id");
  feishu.appSecret = await keychain("binance-stock-bot-feishu-app-secret");
  log("飞书凭据已加载，开始监控 chat=" + CHAT_ID);

  let watermark = 0;
  if (fs.existsSync(STATE_FILE)) {
    try { watermark = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).watermark || 0; } catch { /* ignore */ }
  }
  if (!watermark) {
    // 首次运行：以当前最新消息为水位线，不处理历史消息
    const items = await fetchRecentMessages();
    watermark = items.length ? Math.max(...items.map(i => Number(i.create_time))) : Date.now();
    log(`初始化水位线 watermark=${watermark}（跳过历史消息）`);
  } else {
    log(`恢复水位线 watermark=${watermark}`);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ watermark }));

  for (;;) {
    try {
      const items = await fetchRecentMessages();
      const fresh = items
        .map(parseSignal)
        .filter(s => s && s.createTime > watermark)
        .sort((a, b) => a.createTime - b.createTime);
      for (const signal of fresh) {
        watermark = Math.max(watermark, signal.createTime);
        fs.writeFileSync(STATE_FILE, JSON.stringify({ watermark }));
        await handleSignal(signal);
      }
      // 水位线也跟随非信号消息前进，避免积压
      const newest = items.length ? Math.max(...items.map(i => Number(i.create_time))) : watermark;
      if (newest > watermark) {
        watermark = newest;
        fs.writeFileSync(STATE_FILE, JSON.stringify({ watermark }));
      }
    } catch (err) {
      log("轮询出错: " + err.message);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// 被 import 时（测试）不启动主循环
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    log("致命错误: " + (err.stack || err.message));
    process.exit(1);
  });
}

export { parseSignal, buildAttemptJs, VERIFY_JS };
