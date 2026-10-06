import { dashboardPublicOrigin } from "./dashboard-auth.mjs";

function publicHttpsUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== "https:") return null;
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function feishuMessageWithDashboardLink(text, environment = process.env) {
  const message = String(text);
  const dashboardUrl = (
    publicHttpsUrl(dashboardPublicOrigin(environment)) ||
    publicHttpsUrl(environment.DASHBOARD_URL)
  );
  if (!dashboardUrl || message.includes(dashboardUrl)) return message;
  return `${message}\n\n📱 打开手机 Dashboard：${dashboardUrl}`;
}
