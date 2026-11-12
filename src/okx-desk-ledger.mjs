import { readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Stage-1 OKX desk shadow log. The Obsidian file is the source of truth.
// This module only reads markdown and never places or sizes an order.
export const VAULT_LEDGER_PATH = "/Users/henry/Library/Mobile Documents/iCloud~md~obsidian/Documents/warehouse/投资学习/04-交易日志/OKX交易台-影子日志.md";
export const VAULT_REPORTS_DIR = "/Users/henry/Library/Mobile Documents/iCloud~md~obsidian/Documents/warehouse/投资学习/04-交易日志/日报";
export const DESK_FIXTURE_PATH = fileURLToPath(new URL("../fixtures/okx-desk/shadow-log.sample.md", import.meta.url));

const SLOTS = [9, 13, 17, 21];
const COLUMNS = ["time", "role", "symbol", "idea", "evidence", "scoreText", "entry", "stop", "target", "size", "riskPct", "riskDecision", "status", "result", "lesson"];
const EMPTY = new Set(["", "—", "-", "–", "―"]);
const STATUS_KEYS = ["开始日", "阶段1起算", "阶段", "交易员", "白名单", "熔断"];

const pad = (value) => String(value).padStart(2, "0");
export const present = (value) => {
  const text = String(value ?? "").trim();
  return EMPTY.has(text) ? "" : text;
};

export function slotOf(hour, minute) {
  const clock = hour * 60 + minute;
  for (const slot of SLOTS) {
    const start = slot * 60 - 10;
    const end = slot * 60 + 50;
    if (clock >= start && clock <= end) return `${pad(slot)}:00`;
  }
  return null;
}

function stampMs(date, hour, minute) {
  return Date.parse(`${date}T${pad(hour)}:${pad(minute)}:00+08:00`);
}

function section(markdown, title) {
  const match = markdown.match(new RegExp(`(?:^|\\n)## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match ? match[1] : "";
}

function splitCells(line) {
  let cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length > COLUMNS.length) {
    cells = [...cells.slice(0, COLUMNS.length - 1), cells.slice(COLUMNS.length - 1).join(" | ")];
  }
  return cells;
}

function parseRows(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = splitCells(line);
    if (cells.length < 5) continue;
    const time = cells[0];
    const clock = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(time);
    if (!clock) continue;
    const row = { index: rows.length, date: clock[1], hour: Number(clock[2]), minute: Number(clock[3]) };
    COLUMNS.forEach((name, index) => { row[name] = cells[index] || ""; });
    const score = present(row.scoreText);
    row.score = /^\d+(?:\.\d+)?$/.test(score) ? Number(score) : null;
    rows.push(row);
  }
  return rows;
}

export function classifyRow(row) {
  if (row.role === "图表分析") return "chart";
  if (row.role === "策略师") return "strategy";
  if (row.role === "风控") return "risk";
  if (/全表|自选覆盖|自选全表|OI新旧源|OI普查/.test(row.symbol) || /^(汇总|无信号汇总|弱关注汇总|已更新覆盖)/.test(row.idea)) return "coverage";
  if (row.idea.startsWith("有点子")) return "idea";
  if (row.idea.startsWith("弱关注")) return "watch";
  if (row.idea.startsWith("无信号") || row.idea.startsWith("作废") || row.idea.includes("无信号：")) return "flat";
  if (row.idea.startsWith("上班有点子")) return "review";
  return "note";
}

export function statedCounts(text) {
  const read = (label) => {
    const match = String(text || "").match(new RegExp(`${label}\\s*(\\d+)`));
    return match ? Number(match[1]) : null;
  };
  return { ideas: read("有点子"), watch: read("弱关注"), none: read("无信号") };
}

export function breakerOf(text) {
  const source = String(text || "");
  if (/熔断已触发|是否触熔断：是/.test(source)) return "已触发";
  if (/熔断未触发|是否触熔断：否/.test(source)) return "未触发";
  return null;
}

export function falsifierOf(text) {
  const match = String(text || "").match(/(?:可机检否决|否决(?:句|条件)?)：\s*([\s\S]+)/);
  return match ? match[1].trim() : "";
}

export function gateOf(text) {
  const source = String(text || "");
  if (/闸不过|流动性不过|未过闸|ATR闸不过/.test(source)) return "闸门未过";
  if (/闸过|闸全过|流动性过/.test(source)) return "闸门已过";
  return "";
}

function parseBlocks(body) {
  return body.split(/^### /m).slice(1).map((part) => {
    const breakAt = part.indexOf("\n");
    const heading = (breakAt === -1 ? part : part.slice(0, breakAt)).trim();
    const rest = breakAt === -1 ? "" : part.slice(breakAt + 1);
    const fence = rest.match(/```[^\n]*\n([\s\S]*?)```/);
    const text = (fence ? fence[1] : rest).trim();
    const date = heading.match(/\d{4}-\d{2}-\d{2}/)?.[0] || text.match(/^日期：(\d{4}-\d{2}-\d{2})/m)?.[1] || "";
    const clock = heading.match(/(\d{2}):(\d{2})/);
    return {
      heading,
      text,
      date,
      hour: clock ? Number(clock[1]) : null,
      minute: clock ? Number(clock[2]) : null,
      line: text.match(/^一句话：(.+)$/m)?.[1]?.trim() || ""
    };
  }).filter((block) => block.date && block.heading !== "模板" && block.heading !== "记录");
}

function groupShifts(rows) {
  const ordered = [...rows].sort((left, right) => stampMs(left.date, left.hour, left.minute) - stampMs(right.date, right.hour, right.minute) || left.index - right.index);
  const scheduled = new Map();
  const manual = [];
  for (const row of ordered) {
    const slot = slotOf(row.hour, row.minute);
    if (slot) {
      const id = `${row.date}T${slot}`;
      if (!scheduled.has(id)) scheduled.set(id, { id, date: row.date, slot, kind: "scheduled", rows: [] });
      scheduled.get(id).rows.push(row);
      continue;
    }
    const previous = manual.at(-1);
    const gap = previous ? (stampMs(row.date, row.hour, row.minute) - stampMs(previous.date, previous.rows.at(-1).hour, previous.rows.at(-1).minute)) / 60_000 : Infinity;
    if (!previous || previous.date !== row.date || gap > 20) {
      manual.push({ id: `${row.date}T${pad(row.hour)}:${pad(row.minute)}`, date: row.date, slot: null, kind: "manual", rows: [row] });
    } else previous.rows.push(row);
  }
  return [...scheduled.values(), ...manual].sort((left, right) => stampMs(left.date, left.rows[0].hour, left.rows[0].minute) - stampMs(right.date, right.rows[0].hour, right.rows[0].minute));
}

function attachBlocks(blocks, shifts, loose) {
  for (const block of blocks) {
    if (block.hour === null) { loose.push(block); continue; }
    const slot = slotOf(block.hour, block.minute);
    const direct = slot ? shifts.find((shift) => shift.id === `${block.date}T${slot}`) : null;
    if (direct) { direct.notes.push(block); continue; }
    const when = stampMs(block.date, block.hour, block.minute);
    let best = null;
    let bestGap = Infinity;
    for (const shift of shifts) {
      if (shift.date !== block.date) continue;
      for (const row of shift.rows) {
        const gap = Math.abs(stampMs(row.date, row.hour, row.minute) - when) / 60_000;
        if (gap < bestGap) { bestGap = gap; best = shift; }
      }
    }
    if (best && bestGap <= 45) best.notes.push(block);
    else loose.push(block);
  }
}

function finishShift(shift) {
  for (const row of shift.rows) row.kind = classifyRow(row);
  const coverage = shift.rows.find((row) => row.kind === "coverage" && statedCounts(row.idea).ideas !== null && statedCounts(row.idea).watch !== null);
  const stated = coverage ? statedCounts(coverage.idea) : { ideas: null, watch: null, none: null };
  const fromScan = stated.ideas !== null || stated.watch !== null || stated.none !== null;
  const counted = {
    ideas: shift.rows.filter((row) => row.kind === "idea").length,
    watch: shift.rows.filter((row) => row.kind === "watch").length,
    none: shift.rows.filter((row) => row.kind === "flat").length
  };
  const count = (key) => (stated[key] !== null ? stated[key] : fromScan ? null : counted[key]);
  const text = [coverage?.idea, ...shift.notes.map((note) => note.text)].filter(Boolean).join("\n");
  const summary = [...shift.notes].reverse().find((note) => note.line) || shift.notes.at(-1);
  const { notes, ...rest } = shift;
  return {
    ...rest,
    label: shift.kind === "scheduled" ? `${shift.date} ${shift.slot}` : `${shift.date} ${pad(shift.rows[0].hour)}:${pad(shift.rows[0].minute)}`,
    coverage: coverage || shift.rows.find((row) => row.kind === "coverage") || null,
    counts: { ideas: count("ideas"), watch: count("watch"), none: count("none"), source: fromScan ? "scan" : "rows" },
    breaker: breakerOf(text),
    summaryLine: summary?.line || "",
    plans: notes.filter((note) => note.plan),
    summaries: notes.filter((note) => !note.plan)
  };
}

export function parseOkxDeskLedger(markdown) {
  const source = String(markdown || "").replace(/^\uFEFF/, "").replace(/^<!--[\s\S]*?-->\s*/, "");
  const statusBody = section(source, "运行状态");
  const status = {};
  for (const key of STATUS_KEYS) {
    const match = statusBody.match(new RegExp(`^- ${key}：(.+)$`, "m"));
    if (match) status[key] = match[1].trim();
  }
  const capital = source.match(/^记账本金（影子）：(.+)$/m)?.[1]?.replace(/\*\*/g, "").trim() || "";
  const shifts = groupShifts(parseRows(source)).map((shift) => ({ ...shift, notes: [] }));
  const loose = [];
  attachBlocks(parseBlocks(section(source, "每日摘要")), shifts, loose);
  attachBlocks(parseBlocks(section(source, "策略计划明细（演练）")).map((block) => ({ ...block, plan: true })), shifts, loose);
  return {
    capital,
    status,
    shifts: shifts.map(finishShift),
    loose
  };
}

export function shadowSentences(markdown) {
  const sentences = [];
  for (const raw of String(markdown || "").split(/\n+/)) {
    const line = raw.replace(/^[-*>\s]+/, "").replace(/\[[^\]]+\]\([^)]*\)/g, (link) => link.slice(1, link.indexOf("]"))).trim();
    if (!line.includes("影子")) continue;
    for (const sentence of line.split(/(?<=。)/)) {
      const text = sentence.trim();
      if (text.includes("影子")) sentences.push(text);
    }
  }
  return [...new Set(sentences)];
}

async function readReports(dir, dates, readText, listDirectory) {
  if (!dir) return { notes: {}, status: "skipped" };
  let names;
  try { names = await listDirectory(dir); } catch { return { notes: {}, status: "unavailable" }; }
  const root = resolve(dir);
  const notes = {};
  for (const date of [...new Set(dates)]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const name = `${date}.md`;
    if (!names.includes(name)) continue;
    const file = resolve(root, name);
    if (file !== root + sep + name) continue;
    try {
      const sentences = shadowSentences(await readText(file, "utf8"));
      if (sentences.length) notes[date] = sentences;
    } catch { /* one unreadable report does not invent a note */ }
  }
  return { notes, status: "ok" };
}

export async function loadOkxDeskLedger({
  ledgerPath = process.env.OKX_DESK_LEDGER_PATH || VAULT_LEDGER_PATH,
  reportsDir = process.env.OKX_DESK_REPORTS_DIR || VAULT_REPORTS_DIR,
  fixturePath = DESK_FIXTURE_PATH,
  readText = readFile,
  listDirectory = readdir
} = {}) {
  let markdown = null;
  let kind = "unavailable";
  try {
    markdown = await readText(ledgerPath, "utf8");
    kind = ledgerPath === fixturePath ? "fixture" : "vault";
  } catch {
    if (ledgerPath !== fixturePath) {
      try {
        markdown = await readText(fixturePath, "utf8");
        kind = "fixture";
      } catch { kind = "unavailable"; }
    }
  }
  const parsed = markdown ? parseOkxDeskLedger(markdown) : { capital: "", status: {}, shifts: [], loose: [] };
  const reports = await readReports(reportsDir, parsed.shifts.map((shift) => shift.date), readText, listDirectory);
  const label = kind === "vault" ? "本机 Obsidian 影子日志" : kind === "fixture" ? "内置 2026-11-12 班次样本" : "影子日志不可读";
  return {
    ...parsed,
    reports,
    source: { kind, label, readAt: new Date().toISOString() }
  };
}
