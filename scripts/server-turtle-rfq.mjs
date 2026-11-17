// Finite server-only research. No trading imports, model API or Mac dependency.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RFQ_SCHEDULE, RFQ_SERVICE_TIMEOUT_MS, RFQ_SLOT_TIMEOUT_MS, dueRfqSlot, qualifyingRfqPairs, rfqFinalAt, sealSavedRfqReceipt, summarizeScheduledRfq } from "./scheduled-turtle-rfq.mjs";
import { collectServerTurtleRfq } from "./research-turtle-rfq-server.mjs";
import { verifyRfqHistoricalGas } from "./research-turtle-rfq-chain.mjs";

const root = "/opt/binance-turtle-rfq-20261116", state = "/var/lib/binance-turtle-rfq-20261116";
const reportPath = "/opt/binance-agentic-stock-bot/docs/2026-11-15-turtle-eight-etf-research.md";
const prefix = "binance-turtle-rfq-20261116-";
const baseFiles = ["scripts/scheduled-turtle-rfq.mjs", "scripts/research-turtle-rfq-server.mjs", "scripts/research-turtle-rfq.mjs", "scripts/research-turtle-rfq-chain.mjs", "src/turtle-etf-universe.mjs"];
const sha = value => createHash("sha256").update(value).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
async function atomic(path, value) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try { await writeFile(temporary, value, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(e => { if (e.code !== "ENOENT") throw e; }); }
}

export async function verifyNativeRelease(releaseDirectory) {
  const manifest = await json(resolve(releaseDirectory, "release.json"));
  if (manifest.kind !== "FINITE_TURTLE_RFQ_READ_ONLY" || manifest.execution !== "SERVER_NATIVE"
    || manifest.scheduleHash !== sha(JSON.stringify(RFQ_SCHEDULE)) || manifest.stateDirectory !== state || manifest.reportPath !== reportPath
    || JSON.stringify(Object.keys(manifest.sources ?? {}).sort()) !== JSON.stringify([...baseFiles].sort())
    || JSON.stringify(Object.keys(manifest.nativeSources ?? {})) !== JSON.stringify(["scripts/server-turtle-rfq.mjs"])) throw Error("Invalid server research release");
  for (const [file, expected] of Object.entries({ ...manifest.sources, ...manifest.nativeSources })) {
    if (sha(await readFile(resolve(releaseDirectory, file))) !== expected) throw Error("Frozen server research source changed");
  }
  if (sha(await readFile(resolve(releaseDirectory, "baseline.md"))) !== manifest.reportBaselineHash) throw Error("Frozen research baseline changed");
  return manifest;
}

// The CLI holds a kernel flock across this function; there is no crash-persistent global wx lock.
export async function runNativeSlot({ manifest, phase, nowMs = Date.now(), collect = collectServerTurtleRfq, verifyGas = verifyRfqHistoricalGas }) {
  const slot = dueRfqSlot(nowMs, phase);
  if (!slot) return { status: "OUTSIDE_WINDOW_NO_WALLET_CALL", phase };
  const directory = manifest.stateDirectory, location = resolve(directory, "slots", slot.id);
  await mkdir(location, { recursive: true, mode: 0o700 });
  let claimedNow = false;
  try { await writeFile(resolve(location, "claim.json"), JSON.stringify({ slot, claimedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 }); claimedNow = true; }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const sealed = await sealSavedRfqReceipt(location, slot);
  if (!claimedNow) {
    if (!sealed?.created) return { status: "SLOT_ALREADY_CLAIMED_NO_REPEAT", slot: slot.id };
    const progress = await summarizeScheduledRfq(directory);
    return { ...sealed.receipt, totalQualifyingPairs: progress.qualifyingPairs };
  }
  let receipt;
  try {
    const report = await collect(location, { slotAt: slot.at, local: true, feeEvidence: true });
    const raw = await readFile(resolve(location, "quote-report.json"), "utf8");
    if (sha(JSON.stringify(JSON.parse(raw))) !== sha(JSON.stringify(report))) throw Error("Collector output differs from saved source");
    const pairs = qualifyingRfqPairs(report, slot);
    receipt = { slot: slot.id, completedAt: new Date().toISOString(), status: pairs.length === 24 ? "COLLECTED_24" : "PARTIAL_OR_BLOCKED", qualifyingPairs: pairs.length, quoteReportHash: sha(raw), automaticTradingEligible: false };
    try { await verifyGas(location, { local: true }); }
    catch (error) { await writeFile(resolve(location, "gas-error.json"), JSON.stringify({ status: "UNKNOWN", error: error.message }), { flag: "wx", mode: 0o600 }); }
  } catch (error) { receipt = { slot: slot.id, completedAt: new Date().toISOString(), status: "FAILED_WITHOUT_BACKFILL", error: error.message, automaticTradingEligible: false }; }
  await writeFile(resolve(location, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
  const progress = await summarizeScheduledRfq(directory);
  return { ...receipt, totalQualifyingPairs: progress.qualifyingPairs };
}

export function rfqCostStatistics(groups) {
  return [...groups].map(g => {
    const values = [...g.losses].sort((a, b) => a - b), middle = Math.floor(values.length / 2);
    return { symbol: g.symbol, amount: g.amount, n: values.length,
      medianPct: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
      p90Pct: values[Math.ceil(values.length * 0.9) - 1], worstPct: values.at(-1) };
  });
}

export async function finalizeNativeReport({ manifest, releaseDirectory, nowMs = Date.now() }) {
  if (nowMs < Date.parse(RFQ_SCHEDULE.at(-1).at) + RFQ_SLOT_TIMEOUT_MS) throw Error("Scheduled sampling has not ended");
  const directory = manifest.stateDirectory, finalPath = resolve(directory, "final-result.json");
  try { return await json(finalPath); } catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const slot of RFQ_SCHEDULE) await sealSavedRfqReceipt(resolve(directory, "slots", slot.id), slot);
  const baseline = await readFile(resolve(releaseDirectory, "baseline.md"), "utf8");
  if (sha(baseline) !== manifest.reportBaselineHash) throw Error("Research baseline changed");
  const progress = await summarizeScheduledRfq(directory, nowMs), groups = new Map(), gasEvidence = [];
  for (const slot of RFQ_SCHEDULE) {
    const location = resolve(directory, "slots", slot.id), row = progress.slots.find(r => r.id === slot.id);
    if (!row.quoteReportHash) continue;
    const report = await json(resolve(location, "quote-report.json"));
    const receipt = await json(resolve(location, "receipt.json")).catch(e => { if (e.code === "ENOENT") return null; throw e; });
    if (receipt?.quoteReportHash !== row.quoteReportHash) continue;
    for (const pair of qualifyingRfqPairs(report, slot)) {
      const key = pair.symbol + ":" + Number(pair.amount);
      if (!groups.has(key)) groups.set(key, { symbol: pair.symbol, amount: String(Number(pair.amount)), losses: [] });
      groups.get(key).losses.push(pair.quotedRoundTripPct);
    }
    let chain = null;
    try { chain = await json(resolve(location, "historical-gas-chain-verification.json")); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    gasEvidence.push({ slot: slot.id, sourceQuoteHash: row.quoteReportHash, customerFeeEvidence: report.gas?.customerFeeEvidence ?? { status: "UNKNOWN" },
      nativeReceiptStatus: chain?.status ?? "UNKNOWN", nativeReceiptCount: chain?.verified?.length ?? null });
  }
  const statistics = rfqCostStatistics(groups.values());
  if (statistics.reduce((n, g) => n + g.n, 0) !== progress.qualifyingPairs) throw Error("Report coverage differs from verified receipts");
  const result = { generatedAt: new Date(nowMs).toISOString(), status: "WITHHOLD", qualifyingPairs: progress.qualifyingPairs, requiredPairs: 216,
    missingPairs: 216 - progress.qualifyingPairs, statistics, gasEvidence, currentUserGasDebitVerified: false, gasIncludedInQuote: null,
    automaticTradingEligible: false, independentHumanReview: "PENDING", baselineHash: sha(baseline), sourceSlots: progress.slots, publication: { status: "PENDING" } };
  const rows = progress.slots.map(r => `| ${r.id} | ${r.status} | ${r.qualifyingPairs}/24 |`).join("\n");
  const costs = statistics.map(g => `| ${g.symbol} | ${g.amount} | ${g.n}/9 | ${g.medianPct.toFixed(6)}% | ${g.p90Pct.toFixed(6)}% | ${g.worstPct.toFixed(6)}% |`).join("\n");
  const section = `# 三交易日服务器只读采样结果\n\n更新于 ${result.generatedAt}。常规合格 **${result.qualifyingPairs}/216**，缺 ${result.missingPairs} 对。状态 WITHHOLD，automaticTradingEligible=false。\n\n服务器已按固定三交易日九窗口汇总；没有下单或切换实盘。失败、断连、超时和错过的窗口不补造；旧 offhours 不计入。\n\n| 窗口 | 状态 | 合格报价 |\n|---|---|---:|\n${rows}\n\n## 往返报价损耗\n\n| ETF | 金额 U | 样本 | 中位数 | P90 | 最差 |\n|---|---:|---:|---:|---:|---:|\n${costs || "| 未取得合格报价 | — | 0 | UNKNOWN | UNKNOWN | UNKNOWN |"}\n\n这是精确买入数量反向报价的输出损耗，不是成交收益或完整手续费。三日九样本每组的 P90 只作本批描述，不代表稳定分布；执行缓冲是风险假设，不是实际扣费。\n\n## Gas 证据\n\n保存了 ${gasEvidence.length} 个窗口的历史订单费用证据。网络 Gas 回执、服务方 tx-history.networkFee、历史美元换算和用户最终承担的费用不是同一事实；原始来源与哈希见 final-result.json 和各槽目录。即使某字段为零，也不能证明用户免收或费用未内含报价。用户实际额外扣费及报价内含仍为 UNKNOWN，不把整笔网络费重复加给用户，不为测费用下单。\n\n## 研究结论\n\n216 对完整覆盖也只代表报价采样完成。当前不签发全成本验证或实盘资格；费用未知、缺样本、执行可用性和独立人工复核仍需明确跟进。原 210 组长历史回测不重算、不改参数、不删负面样本，原有不支持切换单仓海龟的结论保留。以下为冻结的初始研究报告，时间与数据状态按原文理解。\n\n`;
  const document = section + baseline;
  await atomic(resolve(directory, "report.md"), document);
  let current = null;
  try { current = await readFile(manifest.reportPath, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (current === null || sha(current) === manifest.reportBaselineHash || sha(current) === sha(document)) {
    await atomic(manifest.reportPath, document); result.publication = { status: "UPDATED", reportPath: manifest.reportPath, sha256: sha(document) };
  } else result.publication = { status: "CONFLICT_PRESERVED", reportPath: manifest.reportPath, currentHash: sha(current), resultPath: resolve(directory, "report.md") };
  await atomic(finalPath, JSON.stringify(result, null, 2));
  return result;
}

export function nativeTimerUnits() {
  const units = {}, timers = ["open", "mid", "close", "final"].map(p => prefix + p + ".timer");
  for (const phase of ["open", "mid", "close", "final"]) {
    const name = prefix + phase, final = phase === "final";
    const calendars = final ? [rfqFinalAt().replace("T", " ").replace(".000Z", " UTC")] : RFQ_SCHEDULE.filter(s => s.phase === phase).map(s => s.at.replace("T", " ").replace(".000Z", " UTC"));
    units[name + ".timer"] = `[Unit]\nDescription=Finite read-only ETF RFQ ${phase}\n[Timer]\n${calendars.map(t => "OnCalendar=" + t).join("\n")}\nPersistent=${final}\nAccuracySec=1s\nRandomizedDelaySec=0\nUnit=${name}.service\n[Install]\nWantedBy=timers.target\n`;
    units[name + ".service"] = `[Unit]\nDescription=Finite read-only ETF RFQ ${phase}\nAfter=network-online.target time-sync.target\nWants=network-online.target\n${final ? "StartLimitIntervalSec=3600\nStartLimitBurst=3\n" : ""}[Service]\nType=oneshot\nUser=root\nWorkingDirectory=${root}/release-v3\nExecStart=/usr/bin/node ${root}/release-v3/scripts/server-turtle-rfq.mjs ${phase}\n${final ? "ExecStartPost=/usr/bin/systemctl disable --now " + timers.join(" ") + "\nRestart=on-failure\nRestartSec=300\n" : "Restart=no\n"}TimeoutStartSec=${RFQ_SERVICE_TIMEOUT_MS / 60_000}min\nNice=15\nCPUWeight=10\nIOWeight=10\nMemoryHigh=220M\nMemoryMax=320M\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=${state} /var/lib/binance-agentic-stock-bot/.baw /opt/binance-agentic-stock-bot/docs\n`;
  }
  return units;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const releaseDirectory = resolve(import.meta.dirname, ".."), manifest = await verifyNativeRelease(releaseDirectory);
  const locked = process.argv[2] === "--locked", phase = process.argv[locked ? 3 : 2];
  if (!["open", "mid", "close", "final", "--status"].includes(phase)) throw Error("Invalid finite research phase");
  if (phase !== "final" && phase !== "--status" && !dueRfqSlot(Date.now(), phase)) {
    console.log(JSON.stringify({ status: "OUTSIDE_WINDOW_NO_WALLET_CALL", phase }));
  } else if (!locked) {
    await mkdir(manifest.stateDirectory, { recursive: true, mode: 0o700 });
    try { process.stdout.write(execFileSync("/usr/bin/flock", ["--nonblock", "--conflict-exit-code", "75", resolve(manifest.stateDirectory, "kernel.lock"), process.execPath, process.argv[1], "--locked", phase], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: RFQ_SLOT_TIMEOUT_MS })); }
    catch (e) { if (e.status === 75) { console.log(JSON.stringify({ status: "RESEARCH_KERNEL_LOCK_BUSY" })); process.exitCode = 75; } else throw Error("Server research command failed; inspect its scoped journal and evidence"); }
  } else {
    const result = phase === "final" ? await finalizeNativeReport({ manifest, releaseDirectory }) : phase === "--status" ? await summarizeScheduledRfq(manifest.stateDirectory) : await runNativeSlot({ manifest, phase });
    console.log(JSON.stringify({ status: result.status, qualifyingPairs: result.qualifyingPairs ?? result.totalQualifyingPairs, requiredPairs: 216, publication: result.publication, automaticTradingEligible: false }));
  }
}
