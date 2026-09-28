import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { captureSavedEvidence } from "../src/strategy-evidence-store.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(resolve(projectRoot, process.env.BOT_CONFIG || "config.json"), "utf8"));
const result = await captureSavedEvidence({ projectRoot, config });
console.log(JSON.stringify({ archived: result.evidenceIds.length, missing: result.missing, errors: result.errors }));
process.exitCode = result.errors.length ? 1 : 0;
