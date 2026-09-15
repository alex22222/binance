import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishManagerHtml } from "./fund-manager-html.mjs";

export const REPORT_SECTIONS = ["经理结论", "实盘回溯", "Paper", "全球动态", "美联储", "黄金", "美股", "重大事件", "风险与行动", "数据与来源"];

export function validateManagerReport(date, text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !text.includes(date)) throw new Error("Report date missing or invalid");
  for (const section of REPORT_SECTIONS) {
    if (!text.includes(`## ${section}`)) throw new Error(`Missing report section: ${section}`);
  }
  if (!/https:\/\//.test(text)) throw new Error("Report requires source links");
  if (Buffer.byteLength(text, "utf8") > 16000) throw new Error("Report exceeds 16 KB; shorten before sending");
  if (/(?:tenant_access_token|app_secret|FEISHU_APP_SECRET|BEGIN .*PRIVATE KEY)/i.test(text)) throw new Error("Possible credential in report");
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function managerReportUrl(date, edition, environment = process.env) {
  const origin = new URL(environment.DASHBOARD_PUBLIC_ORIGIN || environment.DASHBOARD_URL || "");
  if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error("A public HTTPS Dashboard origin is required");
  return `${origin.origin}/fund-manager?date=${date}&edition=${edition}`;
}

export function managerReportCard(text, reportUrl) {
  const conclusion = text.split("## 经理结论")[1]?.split(/^## /m)[0]?.trim() || "每日投资报告已生成。";
  const title = text.match(/^# (.+)$/m)?.[1] || "基金经理日报";
  return {
    config: { wide_screen_mode: true },
    header: { template: "green", title: { tag: "plain_text", content: title } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: conclusion.slice(0, 1600) } },
      { tag: "note", elements: [{ tag: "plain_text", content: "实盘 · Paper · 全球动态 · 美联储 · 黄金 · 美股 · 重大事件\n完整 HTML 报告保存在系统内，使用现有 Dashboard 登录查看。" }] },
      { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "阅读完整 HTML 报告" }, type: "primary", url: reportUrl }] }
    ]
  };
}

export async function sendManagerFeishu(text, uuid, environment = process.env, fetchImpl = fetch, reportUrl = null) {
  const card = reportUrl ? managerReportCard(text, reportUrl) : null;
  const msgType = card ? "interactive" : "text";
  const content = card || { text };
  async function post(url, body, token) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json();
    if (!response.ok || (data.code ?? data.StatusCode) !== 0) {
      throw new Error(`Feishu rejected request: HTTP ${response.status}, code ${data.code ?? data.StatusCode ?? "missing"}`);
    }
    return data;
  }
  if (environment.FEISHU_WEBHOOK_URL) {
    await post(environment.FEISHU_WEBHOOK_URL, card ? { msg_type: msgType, card } : { msg_type: msgType, content });
    return { channel: "webhook", messageId: null };
  }
  const receiveId = environment.FEISHU_RECEIVE_ID;
  if (!environment.FEISHU_APP_ID || !environment.FEISHU_APP_SECRET || !receiveId) throw new Error("Existing Feishu channel is not configured");
  const receiveIdType = environment.FEISHU_RECEIVE_ID_TYPE || (receiveId.startsWith("oc_") ? "chat_id" : receiveId.startsWith("ou_") ? "open_id" : null);
  if (!receiveIdType) throw new Error("Unrecognized Feishu receive ID type");
  const auth = await post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    app_id: environment.FEISHU_APP_ID, app_secret: environment.FEISHU_APP_SECRET
  });
  if (!auth.tenant_access_token) throw new Error("Missing Feishu tenant token");
  const result = await post(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`, {
    receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content), uuid
  }, auth.tenant_access_token);
  if (!result.data?.message_id) throw new Error("Missing Feishu delivery receipt");
  return { channel: "app", messageId: result.data.message_id };
}

export async function deliverManagerReport({ directory, date, text, edition = "daily", environment = process.env, fetchImpl = fetch }) {
  validateManagerReport(date, text);
  if (!["daily", "preview"].includes(edition)) throw new Error("Invalid report edition");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = `${date}-${edition}`;
  const receiptPath = join(directory, `${key}.receipt.json`);
  const lockPath = join(directory, `${key}.lock`);
  const readReceipt = () => readFile(receiptPath, "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  const existing = await readReceipt();
  if (existing?.status === "SENT") return { ...existing, duplicateSkipped: true };
  const lock = await open(lockPath, "wx", 0o600);
  try {
    const latest = await readReceipt();
    if (latest?.status === "SENT") return { ...latest, duplicateSkipped: true };
    const hash = createHash("sha256").update(text).digest("hex");
    const uuid = createHash("sha256").update(`fund-manager:${key}`).digest("hex").slice(0, 40);
    const now = Date.now();
    if (latest?.status === "SENDING" && latest.hash !== hash) throw new Error("Uncertain delivery: retry the identical archived report only");
    if (latest?.status === "SENDING" && (environment.FEISHU_WEBHOOK_URL || now - Date.parse(latest.attemptedAt) > 50 * 60_000)) {
      throw new Error("Uncertain delivery requires Feishu receipt inspection before resending");
    }
    await publishManagerHtml({ directory, date, text, edition });
    const reportUrl = managerReportUrl(date, edition, environment);
    const receipt = { date, edition, hash, uuid, status: "SENDING", attemptedAt: latest?.attemptedAt || new Date(now).toISOString() };
    await atomicJson(receiptPath, receipt);
    const delivered = await sendManagerFeishu(text, uuid, environment, fetchImpl, reportUrl);
    const sent = { ...receipt, ...delivered, reportUrl, format: "html", status: "SENT", sentAt: new Date().toISOString() };
    await atomicJson(receiptPath, sent);
    return sent;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.env.FUND_MANAGER_SEND === "1" || process.env.FUND_MANAGER_PUBLISH === "1") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { date, text, edition } = JSON.parse(input);
  const directory = join(process.cwd(), "state/fund-manager");
  if (process.env.FUND_MANAGER_PUBLISH === "1") {
    validateManagerReport(date, text);
    const archived = await readFile(join(directory, `${date}-${edition}.md`), "utf8");
    if (archived !== text) throw new Error("Publish must preserve the archived report");
    const { path } = await publishManagerHtml({ directory, date, text, edition });
    console.log(JSON.stringify({ status: "PUBLISHED", path, reportUrl: managerReportUrl(date, edition) }));
  } else console.log(JSON.stringify(await deliverManagerReport({ directory, date, text, edition })));
}
