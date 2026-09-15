import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fundManagerHtml, loadManagerPage, publishManagerHtml } from "../src/fund-manager-html.mjs";

test("renders complete readable reports and escapes model HTML and unsafe links", () => {
  const html = fundManagerHtml({ date: "2026-09-13", text: '# 基金经理日报\n\n说明\n\n## 经理结论\n\n1. **事实**\n2. [来源](https://example.com/?q="x")\n\n<script>alert(1)</script>\n\n[执行](javascript:alert(1))\n\n## Paper\n\n未知，不是零。' });
  assert.match(html, /<ol><li><strong>事实<\/strong>/);
  assert.match(html, /id="section-2"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|href="javascript:/);
  assert.match(html, /noopener noreferrer/);
  assert.match(html, /未知，不是零/);
});

test("archives HTML and source and presents dated history with daily ahead of preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manager-html-"));
  await publishManagerHtml({ directory, date: "2026-09-13", edition: "preview", text: "## 经理结论\n\n预览" });
  await publishManagerHtml({ directory, date: "2026-09-13", text: "## 经理结论\n\n正式" });
  const html = await loadManagerPage(directory);
  assert.match(html, /正式/);
  assert.match(html, /2026-09-13 · 预览/);
  assert.match(await readFile(join(directory, "2026-09-13-daily.html"), "utf8"), /<!doctype html>/);
  await assert.rejects(loadManagerPage(directory, { date: "../../etc/passwd" }), { statusCode: 400 });
  await assert.rejects(loadManagerPage(directory, { date: "2026-09-12" }), { statusCode: 404 });
  assert.match(await loadManagerPage(join(directory, "empty")), /日报尚未生成/);
});
