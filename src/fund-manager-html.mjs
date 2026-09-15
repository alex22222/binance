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

export function fundManagerHtml({ date, text = "", edition = "daily", history = [] }) {
  const pieces = text.replace(/^# [^\n]+\n/m, "").split(/^## (.+)\s*$/m);
  const sections = [];
  for (let index = 1; index < pieces.length; index += 2) sections.push({ title: pieces[index], body: pieces[index + 1] || "" });
  const preview = edition === "preview";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>基金经理日报${date ? ` · ${escapeHtml(date)}` : ""}</title>
<style>
:root{--paper:#f7f8f5;--ink:#182824;--muted:#697670;--line:#dce3dd;--green:#215b46}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:32px}body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:16px;line-height:1.85}a{color:var(--green);text-underline-offset:4px}a:focus-visible{outline:3px solid #c3923e;outline-offset:4px}nav{display:flex;align-items:center;justify-content:space-between;gap:20px;max-width:1180px;margin:auto;padding:20px 28px;font-size:14px}.brand{font-weight:750;color:var(--ink);text-decoration:none}nav span{display:flex;gap:20px}header{background:#163d32;color:#f6f8f3;padding:48px max(28px,calc((100vw - 1124px)/2)) 44px}.eyebrow{font-size:12px;letter-spacing:.2em;color:#b7cfc0}h1{font-size:clamp(28px,4vw,43px);line-height:1.3;margin:14px 0}.subtitle{color:#cbdbd0;margin:0}.badge{display:inline-block;font-size:12px;border:1px solid #729988;border-radius:30px;padding:3px 12px;margin-bottom:12px}.layout{max-width:1180px;padding:36px 28px 80px;margin:auto;display:grid;grid-template-columns:210px minmax(0,1fr);gap:48px}aside{font-size:13px}aside h2{font-size:12px;color:var(--muted);margin:8px 0 15px;letter-spacing:.12em}aside a{display:block;padding:7px 0;text-decoration:none}aside a:hover{text-decoration:underline}.history{margin-top:32px;padding-top:20px;border-top:1px solid var(--line)}article{min-width:0;max-width:800px}.preface{font-size:13px;color:var(--muted);border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:28px}section{padding:10px 0 24px;border-bottom:1px solid var(--line);margin-bottom:24px}section:first-of-type{background:#eaf1e9;border:1px solid #d1dfd1;border-radius:14px;padding:24px 28px}h2{font-size:22px;font-weight:700;letter-spacing:-.025em;margin:8px 0 16px}h2 small{font:500 12px ui-monospace,monospace;color:#698775;margin-right:12px}p{margin:12px 0;overflow-wrap:anywhere}li{padding-left:4px;margin:10px 0}ol,ul{padding-left:24px}code{font-size:.85em;background:#edf0ea;border-radius:4px;padding:2px 5px;overflow-wrap:anywhere}footer{font-size:12px;color:var(--muted);padding-top:12px}.empty{padding:40px 0;color:var(--muted)}@media(max-width:760px){nav{padding:15px 20px;font-size:12px;gap:12px}nav span{gap:12px}header{padding:32px 22px}.layout{display:block;padding:24px 20px 50px}aside{margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid var(--line)}.contents{display:flex;flex-wrap:wrap;gap:0 16px}.history{margin-top:14px;padding-top:10px}.history a{display:inline-block;margin-right:16px}section:first-of-type{padding:18px}h2{font-size:21px}body{font-size:15px}}@media print{body{background:white;font-size:11pt}nav,aside{display:none}header{background:white;color:black;padding:0 0 16px;border-bottom:2px solid #163d32}.eyebrow,.subtitle{color:#555}.layout{display:block;padding:12px 0}article{max-width:none}section:first-of-type{background:white}section{break-inside:avoid}a{color:black}.badge{border-color:#999}}
</style></head><body>
<nav><a class="brand" href="/fund-manager">基金经理 · 投资日报</a><span><a href="/reviews">交易复盘</a><a href="/">仪表盘</a></span></nav>
<header><div class="eyebrow">DAILY INVESTMENT LETTER</div><h1>基金经理日报</h1><span class="badge">${preview ? "验收预览" : "每日报告"}</span><p class="subtitle">${date ? `${escapeHtml(date)} · 北京时间` : "报告档案"}　｜　事实、风险与下一步判断</p></header>
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

export async function loadManagerPage(directory, { date, edition = "daily" } = {}) {
  if ((date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) || !["daily", "preview"].includes(edition)) {
    const error = new Error("Invalid report date or edition"); error.statusCode = 400; throw error;
  }
  const history = await managerHistory(directory);
  const selected = date ? { date, edition } : history[0];
  if (!selected) return fundManagerHtml({ history });
  const text = await readFile(join(directory, `${selected.date}-${selected.edition}.md`), "utf8").catch((error) => {
    if (error.code === "ENOENT") error.statusCode = 404;
    throw error;
  });
  return fundManagerHtml({ ...selected, text, history });
}
