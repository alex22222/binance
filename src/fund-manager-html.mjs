import { SITE_CSS, siteHeader } from "./site-shell.mjs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

function inline(text) {
  // Render a small, explicit Markdown subset; raw model HTML is always text.
  return text.split(/(\[[^\]\n]+\]\(https:\/\/[^\s)]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part) => {
    const link = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return `<a href="${escapeHtml(link[2])}" target="_blank" rel="noopener noreferrer">${escapeHtml(link[1])}</a>`;
    if (part.startsWith("**") && part.endsWith("**")) return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`;
    if (part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    return escapeHtml(part);
  }).join("");
}

function blocks(text) {
  return text.trim().split(/\n\s*\n/).filter(Boolean).map((block) => {
    const lines = block.split("\n");
    if (lines.every((line) => /^\d+\.\s/.test(line))) return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\d+\.\s/, ""))}</li>`).join("")}</ol>`;
    if (lines.every((line) => /^[-*]\s/.test(line))) return `<ul>${lines.map((line) => `<li>${inline(line.slice(2))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("\n");
}

export function fundManagerHtml({ date, text = "", edition = "daily", history = [], theme = "light" } = {}) {
  const pieces = text.replace(/^# [^\n]+\n/m, "").split(/^## (.+)\s*$/m);
  const sections = [];
  for (let index = 1; index < pieces.length; index += 2) sections.push({ title: pieces[index], body: pieces[index + 1] || "" });
  const preview = edition === "preview";
  const themeAttr = theme === "dark" ? ' data-theme="dark"' : "";
  return `<!doctype html>
<html lang="zh-CN"${themeAttr}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>基金经理日报${date ? ` · ${escapeHtml(date)}` : ""} · HQ Capital</title>
<style>
${SITE_CSS}
:root{--content-width:1180px}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:96px}body{font-size:var(--text-body);line-height:1.7}a{color:var(--brand);text-decoration-thickness:1.5px;text-underline-offset:4px}a:focus-visible{outline:2px solid var(--brand);outline-offset:4px}.hero,.layout{width:min(var(--content-width),calc(100% - 32px));margin-inline:auto}.hero{margin-top:16px;padding:40px 36px 36px;border:1px solid var(--line);border-radius:var(--radius);background:linear-gradient(135deg,var(--brand-soft),transparent 60%),var(--surface);box-shadow:var(--shadow)}.eyebrow{font-size:var(--text-eyebrow);letter-spacing:.14em;color:var(--brand);font-weight:750;text-transform:uppercase}h1{font-size:clamp(28px,4vw,var(--text-h1));line-height:1.3;margin:12px 0;letter-spacing:-.02em}.subtitle{color:var(--muted);margin:0}.badge{display:inline-block;font-size:var(--text-meta);color:var(--brand);border:1px solid transparent;background:var(--brand-soft);border-radius:var(--radius-pill);padding:3px 10px;margin-bottom:12px;font-weight:650}.layout{padding:32px 0 80px;display:grid;grid-template-columns:210px minmax(0,1fr);gap:48px}aside{font-size:13px;position:sticky;top:96px;align-self:start}aside h2{font-size:var(--text-meta);color:var(--muted);margin:8px 0 15px;letter-spacing:.12em}aside a{display:block;padding:7px 0;color:var(--muted);text-decoration:none;font-weight:550}aside a:hover{color:var(--brand)}.history{margin-top:32px;padding-top:20px;border-top:1px solid var(--line)}article{min-width:0;max-width:860px}.preface{font-size:13px;color:var(--muted);border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);padding:14px 18px;margin-bottom:18px}.preface p{color:var(--muted);margin:0}section{padding:24px 28px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--panel-shadow);margin-bottom:16px}section:first-of-type{background:linear-gradient(135deg,var(--brand-soft),transparent 58%),var(--surface);border-color:rgba(82,102,235,.25)}h2{font-size:22px;font-weight:750;letter-spacing:-.025em;margin:0 0 16px}h2 small{font:650 12px var(--font-num);color:var(--brand);margin-right:12px}p,li{color:var(--text)}p{margin:12px 0;overflow-wrap:anywhere}li{padding-left:4px;margin:10px 0}ol,ul{padding-left:24px}strong{color:var(--text);font-weight:750}code{font-size:.85em;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:4px;padding:2px 5px;overflow-wrap:anywhere}footer{font-size:var(--text-meta);color:var(--muted);padding:12px 4px}.empty{padding:40px 0;color:var(--muted)}@media(max-width:760px){.hero{padding:28px 20px}.layout{display:block;padding:24px 0 50px}aside{position:static;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid var(--line)}.contents{display:flex;flex-wrap:wrap;gap:0 16px}.history{margin-top:14px;padding-top:10px}.history a{display:inline-block;margin-right:16px}section,section:first-of-type{padding:20px}h2{font-size:21px}}@media print{body{background:#fff;color:#000;font-size:11pt}aside{display:none}.hero{width:auto;margin:0;padding:0 0 16px;background:#fff;color:#000;border:0;border-bottom:2px solid #000;border-radius:0;box-shadow:none}.eyebrow,.subtitle,.badge{color:#555}.badge{border-color:#999;background:none}.layout{display:block;width:auto;padding:12px 0}article{max-width:none}.preface,section,section:first-of-type{background:#fff;border-color:#999;box-shadow:none}section{break-inside:avoid}p,li,strong,a{color:#000}}
</style></head><body>
${siteHeader("/fund-manager", "", { theme })}
<div class="hero"><div class="eyebrow">Daily investment letter</div><h1>基金经理日报</h1><span class="badge">${preview ? "验收预览" : "每日报告"}</span><p class="subtitle">${date ? `${escapeHtml(date)} · 北京时间` : "报告档案"}　｜　事实、风险与下一步判断</p></div>
<main class="layout"><aside><h2>本期内容</h2><div class="contents">${sections.map(({ title }, index) => `<a href="#section-${index + 1}">${String(index + 1).padStart(2, "0")} ${escapeHtml(title)}</a>`).join("")}</div><div class="history"><h2>历史报告</h2>${history.map((entry) => `<a href="/fund-manager?date=${encodeURIComponent(entry.date)}&amp;edition=${entry.edition}">${escapeHtml(entry.date)}${entry.edition === "preview" ? " · 预览" : ""}</a>`).join("") || "暂无其他报告"}</div></aside>
<article>${text ? `<div class="preface">${blocks(pieces[0])}</div>${sections.map(({ title, body }, index) => `<section id="section-${index + 1}"><h2><small>${String(index + 1).padStart(2, "0")}</small>${escapeHtml(title)}</h2>${blocks(body)}</section>`).join("")}` : '<div class="empty">日报尚未生成。完成后可在这里查看全文与历史记录。</div>'}<footer>AI 基金经理 · 实盘、Paper 与研究判断分别呈现</footer></article></main></body></html>`;
}

export async function managerHistory(directory) {
  const files = await readdir(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  return files.flatMap((file) => {
    const match = /^(\d{4}-\d{2}-\d{2})-(daily|preview)\.html$/.exec(file);
    return match ? [{ date: match[1], edition: match[2] }] : [];
  }).sort((a, b) => b.date.localeCompare(a.date) || a.edition.localeCompare(b.edition));
}

export async function publishManagerHtml({ directory, date, text, edition = "daily" }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !["daily", "preview"].includes(edition)) throw new Error("Invalid report identity");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const history = await managerHistory(directory);
  if (!history.some((entry) => entry.date === date && entry.edition === edition)) history.unshift({ date, edition });
  const html = fundManagerHtml({ date, text, edition, history });
  const path = join(directory, `${date}-${edition}.html`);
  const sourcePath = join(directory, `${date}-${edition}.md`);
  await writeFile(`${sourcePath}.tmp`, text, { mode: 0o600 });
  await rename(`${sourcePath}.tmp`, sourcePath);
  await writeFile(`${path}.tmp`, html, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  return { path, html };
}

export async function loadManagerPage(directory, { date, edition = "daily", theme = "light" } = {}) {
  if ((date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) || !["daily", "preview"].includes(edition)) {
    const error = new Error("Invalid report date or edition"); error.statusCode = 400; throw error;
  }
  const history = await managerHistory(directory);
  const selected = date ? { date, edition } : history[0];
  if (!selected) return fundManagerHtml({ history, theme });
  const text = await readFile(join(directory, `${selected.date}-${selected.edition}.md`), "utf8").catch((error) => {
    if (error.code === "ENOENT") error.statusCode = 404;
    throw error;
  });
  return fundManagerHtml({ ...selected, text, history, theme });
}
