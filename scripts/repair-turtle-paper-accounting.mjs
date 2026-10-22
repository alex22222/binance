import { createHash } from "node:crypto";
import { chown, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repairTurtlePaperAccounting } from "../src/turtle-paper-repair.mjs";

const args = process.argv.slice(2);
const allowed = new Set(["--directory", "--backup-directory", "--expect-state-sha256", "--expect-events-sha256"]);
const options = {};
let apply = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--apply") apply = true;
  else if (allowed.has(args[index]) && args[index + 1] && !args[index + 1].startsWith("--")) {
    options[args[index]] = args[++index];
  } else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
}
const directory = resolve(options["--directory"] || "state/turtle-paper");
const statePath = join(directory, "latest.json"), eventsPath = join(directory, "events.jsonl");
const [stateText, eventsText] = await Promise.all([readFile(statePath, "utf8"), readFile(eventsPath, "utf8")]);
const hash = text => createHash("sha256").update(text).digest("hex");
const inputHashes = { state: hash(stateText), events: hash(eventsText) };
const inputState = JSON.parse(stateText);
const inputEvents = eventsText.trim().split("\n").filter(Boolean).map(JSON.parse);
const result = repairTurtlePaperAccounting(inputState, inputEvents);
const changed = JSON.stringify(inputState) !== JSON.stringify(result.state) || result.report.changedEvents > 0;
const output = { mode: apply ? "APPLY" : "DRY_RUN", changed, inputHashes, ...result.report };

if (apply && changed) {
  // The Paper timer/service must be stopped by the operator; hashes pin the reviewed preview.
  if (options["--expect-state-sha256"] !== inputHashes.state || options["--expect-events-sha256"] !== inputHashes.events) {
    throw new Error("Input hashes do not match the reviewed dry run; no files changed");
  }
  const backupDirectory = resolve(options["--backup-directory"]
    || join(directory, "accounting-backups", new Date().toISOString().replaceAll(":", "-")));
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await copyFile(statePath, join(backupDirectory, "latest.json"), 1);
  await copyFile(eventsPath, join(backupDirectory, "events.jsonl"), 1);
  const reportPath = join(backupDirectory, "repair-report.json");
  const stateOutput = `${JSON.stringify(result.state, null, 2)}\n`;
  const eventsOutput = result.events.map(event => `${JSON.stringify(event)}\n`).join("");
  output.backupDirectory = backupDirectory;
  output.outputHashes = { state: hash(stateOutput), events: hash(eventsOutput) };
  await writeFile(reportPath, `${JSON.stringify({ ...output, status: "PREPARED", repairedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const stateTemporary = `${statePath}.accounting-repair.tmp`, eventsTemporary = `${eventsPath}.accounting-repair.tmp`;
  async function stage(path, temporary, contents) {
    const original = await stat(path);
    await writeFile(temporary, contents, { mode: original.mode & 0o777, flag: "wx" });
    await chown(temporary, original.uid, original.gid);
  }
  await stage(statePath, stateTemporary, stateOutput);
  await stage(eventsPath, eventsTemporary, eventsOutput);
  if (hash(await readFile(statePath, "utf8")) !== inputHashes.state
    || hash(await readFile(eventsPath, "utf8")) !== inputHashes.events) throw new Error("Paper ledger changed during repair; no files replaced");
  await rename(eventsTemporary, eventsPath);
  try {
    await rename(stateTemporary, statePath);
  } catch (error) {
    await copyFile(join(backupDirectory, "events.jsonl"), eventsPath);
    throw error;
  }
  await writeFile(reportPath, `${JSON.stringify({ ...output, status: "APPLIED", repairedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify(output, null, 2));
