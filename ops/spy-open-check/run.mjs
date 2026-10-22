import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeSpyCheck, checkMessage, deliverCheck, DUE_AT, OPEN_AT, readCheckTrace, safeError, STRATEGY_ID } from "./check.mjs";

const root = "/opt/binance-agentic-stock-bot";
const releaseRoot = await realpath(dirname(process.argv[1]));
const hash = value => createHash("sha256").update(value).digest("hex");
const manifest = JSON.parse(await readFile(resolve(releaseRoot, "release.json"), "utf8"));
for (const file of ["check.mjs", "run.mjs"]) {
  const path = resolve(releaseRoot, file), info = await stat(path);
  if (info.uid !== 0 || (info.mode & 0o022) || hash(await readFile(path)) !== manifest.files[file]) throw new Error("Follow-up release identity or permissions invalid");
}
const kind = process.argv[2];
if (!["verify", "preflight", "scheduled"].includes(kind)) throw new Error("Expected verify, preflight or scheduled");
if (kind === "verify") {
  console.log(JSON.stringify({ event: "spy_check_release_verified", modules: 2 }));
} else {
  const json = async path => JSON.parse(await readFile(path, "utf8"));
  const dataPath = name => {
    const path = resolve(root, name);
    if (!path.startsWith(root + "/state/")) throw new Error("Production data path escaped state directory");
    return path;
  };
  async function restricted(path, mode) {
    try { await access(path, mode); return false; }
    catch (error) { if (["EACCES", "EROFS", "ENOENT"].includes(error.code)) return true; throw error; }
  }
  let report;
  try {
    const config = await json(root + "/config.json");
    const control = await json(dataPath(config.strategyControlFile));
    const statePath = dataPath(config.stateFile), tracePath = dataPath(config.traceFile);
    const restrictions = {
      productionStateReadOnly: await restricted(statePath, constants.W_OK),
      transactionEnvironmentInaccessible: await restricted("/etc/binance-agentic-stock-bot.env", constants.R_OK),
      walletDirectoryInaccessible: await restricted("/var/lib/binance-agentic-stock-bot/.baw", constants.R_OK),
      otherUsersProcessEnvironmentInaccessible: await restricted("/proc/1/environ", constants.R_OK),
      otherUsersProcessRootInaccessible: await restricted("/proc/1/root/etc/binance-agentic-stock-bot.env", constants.R_OK)
    };
    if (!Object.values(restrictions).every(Boolean)) throw new Error("Follow-up sandbox protections missing");
    const trace = await readCheckTrace(tracePath, OPEN_AT, new Date().toISOString());
    const state = await json(statePath);
    const stop = await json(dataPath(config.emergencyStopFile)).catch(e => e.code === "ENOENT" ? null : Promise.reject(e));
    const [{ loadStrategyGate }, strategy, weekly] = await Promise.all([
      import(pathToFileURL(root + "/src/strategy-governance.mjs")),
      import(pathToFileURL(root + "/src/strategy.mjs")),
      import(pathToFileURL(root + "/src/weekly-etf-live.mjs"))
    ]);
    const observedAt = new Date().toISOString(), nowMs = Date.parse(observedAt);
    const gate = await loadStrategyGate({ projectRoot: root, config, strategyId: control.strategyId });
    if (gate.identity?.codeHash !== manifest.liveCodeHash) { gate.allowed = false; gate.reasons = [...gate.reasons, "LIVE_CODE_CHANGED_SINCE_FOLLOWUP_INSTALL"]; }
    const window = weekly.weeklyEtfLiveDecisionWindow(nowMs, state.weeklyEtfLive);
    const symbol = strategy.entrySymbolPolicyDecision({ symbol: "SPY", blockedSymbols: config.entryBlockedSymbols,
      initialStopHistory: state.initialStopHistory, quarantineUntilBySymbol: state.quarantineUntilBySymbol, nowMs });
    const input = {
      observedAt, openAt: OPEN_AT, dueAt: DUE_AT, config, state, control, gate, stop, trace,
      policy: { regularOpen: window.plan.regularOpen, newYorkDate: window.plan.date,
        weeklyTarget: window.decision?.target, weeklyDecisionUsable: window.decisionUsable,
        skipEntryWeek: state.weeklyEtfLive?.skipEntryWeek === window.week,
        fomcAllowed: strategy.fomcEntryBlackoutDecision({ nowMs, dates: config.fomcEntryBlackoutDates }).allowed,
        symbolAllowed: symbol.allowed, cooldownActive: Number(state.cooldownUntil?.SPY || 0) > nowMs }
    };
    report = analyzeSpyCheck(input);
    report.restrictions = restrictions;
    if (kind === "preflight") report = { ...report, status: "PREFLIGHT", reason: "DEPLOYMENT_CHECK_ONLY", plannedAt: DUE_AT };
    if (kind === "scheduled" && nowMs < Date.parse(DUE_AT)) throw new Error("Scheduled follow-up is not yet due");
  } catch (error) {
    if (kind === "preflight") throw error;
    if (Date.now() < Date.parse(DUE_AT)) throw error;
    report = { schemaVersion: 1, strategyId: STRATEGY_ID, symbol: "SPY", observedAt: new Date().toISOString(), openAt: OPEN_AT, dueAt: DUE_AT,
      status: "UNCONFIRMED", reason: "COLLECTION_FAILED", detail: safeError(error.code || error.message), evidence: {} };
  }
  const directory = process.env.STATE_DIRECTORY || "/var/lib/binance-agentic-spy-open-check";
  const text = kind === "preflight"
    ? "[Agentic Stock Bot] 服务器SPY检查部署验收\n今晚2026-10-22北京时间21:45由服务器独立核验SPY真实买入及未买入原因。\n这是部署测试通知，不代表已经买入。检查不能访问钱包或写入交易状态，不下单、不审批、不改授权和风控。\nhttps://spaceflag.site"
    : checkMessage(report);
  const { sendManagerFeishu } = await import(pathToFileURL(root + "/src/fund-manager-delivery.mjs"));
  const receipt = await deliverCheck({ directory, kind, report, text,
    send: (message, uuid) => sendManagerFeishu(message, uuid) });
  console.log(JSON.stringify({ event: "spy_check_delivered", kind, status: receipt.status, reportStatus: report.status, duplicateSkipped: receipt.duplicateSkipped === true, messageIdPresent: Boolean(receipt.messageId) }));
}
