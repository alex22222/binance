// 手动端到端页面交互测试：在真实仪表盘页面注入一个仿真“待确认订单”卡
// （含审计复选框 + 勾选前禁用按钮的真实逻辑），验证 watcher 的
// 勾选→点击→验证 全链路。仿真卡不参与后端，仪表盘下次轮询渲染会自动清除。
import { buildAttemptJs, VERIFY_JS, parseSignal } from "./watcher.mjs";

const WEBBRIDGE = "http://127.0.0.1:10086/command";
const SESSION = "feishu-order-watch";

async function wb(action, args = {}) {
  const res = await fetch(WEBBRIDGE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, args, session: SESSION }),
  }).then(r => r.json());
  const data = res.data ?? res;
  if (res.ok === false || data.success === false) throw new Error(action + " failed: " + JSON.stringify(res));
  return data;
}
const evaluate = async code => (await wb("evaluate", { code })).value;

const ADDRESS = "0x992879cd8ce0c312d98648875b5a8d6d042cbf34";

// 仿真卡：完全复刻 live-dashboard-html.mjs 的真实交互逻辑
// （change 监听解锁按钮；click 后写“已提交，等待复核”并禁用按钮）
const INJECT_JS = `(() => {
  document.querySelector("#watch-test-card")?.remove();
  const panel = document.createElement("div");
  panel.className = "approval";
  panel.id = "watch-test-card";
  panel.innerHTML =
    '<div class="approval-head"><div><div class="approval-title green">BUY · CRCL</div>' +
    '<div class="contract">${ADDRESS}</div></div>' +
    '<span class="badge gold">待确认</span></div>' +
    '<label class="approval-check"><input type="checkbox"><span>审计数据不可用：测试</span></label>' +
    '<div class="approval-actions"><button type="button" class="approval-button approve">确认买入</button>' +
    '<button type="button" class="approval-button reject">拒绝本次交易</button></div>' +
    '<div class="approval-result"></div>';
  const btn = panel.querySelector(".approve");
  const check = panel.querySelector("input[type=checkbox]");
  const update = () => { btn.disabled = !check.checked; };
  update();
  check.addEventListener("change", update);
  btn.addEventListener("click", () => {
    btn.disabled = true;
    panel.querySelector(".approval-result").textContent = "已提交，等待复核";
  });
  document.getElementById("approval").replaceChildren(panel);
  return { injected: true };
})()`;

const signal = parseSignal({
  msg_type: "text",
  body: { content: JSON.stringify({ text:
    `[Agentic Stock Bot] BUY SUBMITTED SHADOW\nCRCL ${ADDRESS}\n投入: 50 USDT\n审计: OFFICIAL_RWA_UNSUPPORTED_ACKNOWLEDGED\n订单: shadow-1784906550491` }) },
  message_id: "om_test", create_time: "1",
});

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "PASS" : "FAIL") + " " + name + (extra ? " | " + extra : ""));
  if (!cond) failures += 1;
};

check("parseSignal 解析", signal?.side === "BUY" && signal.symbol === "CRCL" && signal.address === ADDRESS && signal.order === "shadow-1784906550491", JSON.stringify(signal));

await wb("find_tab", { url: "http://127.0.0.1:4173/" }).catch(() => wb("navigate", { url: "http://127.0.0.1:4173/", newTab: true }));

// 场景0：线上页面暴露全局 refresh()（强制刷新机制的前提）
const r0 = await evaluate("typeof refresh");
check("页面全局 refresh() 可用", r0 === "function", String(r0));

// 场景1：信号不匹配（错误标的）→ 不得点击
await evaluate(INJECT_JS);
const r1 = await evaluate(buildAttemptJs({ ...signal, symbol: "TSLA" }, true, false));
check("标的不匹配拒绝点击", r1.status === "mismatch", JSON.stringify(r1));

// 场景2：地址不匹配 → 不得点击
await evaluate(INJECT_JS);
const r2 = await evaluate(buildAttemptJs({ ...signal, address: "0x0000000000000000000000000000000000000000" }, true, false));
check("地址不匹配拒绝点击", r2.status === "mismatch", JSON.stringify(r2));

// 场景3：完整链路 → 勾选审计框 → 点击确认买入 → 验证已提交
await evaluate(INJECT_JS);
const r3 = await evaluate(buildAttemptJs(signal, true, false));
check("先打勾再点击", r3.status === "clicked" && r3.detail.includes("auditChecked=true"), JSON.stringify(r3));
await new Promise(r => setTimeout(r, 300));
const v3 = await evaluate(VERIFY_JS);
check("提交结果验证", v3.status === "verified", JSON.stringify(v3));

// 场景4：无审计复选框的卡 → 直接点击
await evaluate(`(() => {
  document.querySelector("#watch-test-card")?.remove();
  const panel = document.createElement("div");
  panel.className = "approval"; panel.id = "watch-test-card";
  panel.innerHTML = '<div class="approval-head"><div><div class="approval-title gold">SELL · CRCL</div>' +
    '<div class="contract">${ADDRESS}</div></div><span class="badge gold">待确认</span></div>' +
    '<div class="approval-actions"><button type="button" class="approval-button approve">确认卖出</button></div>' +
    '<div class="approval-result"></div>';
  const btn = panel.querySelector(".approve");
  btn.addEventListener("click", () => { btn.disabled = true; panel.querySelector(".approval-result").textContent = "已提交，等待复核"; });
  document.getElementById("approval").replaceChildren(panel);
  return true;
})()`);
const r4 = await evaluate(buildAttemptJs({ ...signal, side: "SELL" }, true, false));
check("无审计框直接确认卖出", r4.status === "clicked" && r4.detail.includes("auditChecked=null"), JSON.stringify(r4));

// 场景5：无卡片 → not-found
await evaluate(`(() => { document.querySelector("#watch-test-card")?.remove(); return true; })()`);
const r5 = await evaluate(buildAttemptJs(signal, true, false));
check("无卡片返回 not-found", r5.status === "not-found", JSON.stringify(r5));

// 场景6：方向不匹配（SELL 信号 vs BUY 卡）→ 不得点击
await evaluate(INJECT_JS);
const r6 = await evaluate(buildAttemptJs({ ...signal, side: "SELL" }, true, false));
check("方向不匹配拒绝点击", r6.status === "mismatch", JSON.stringify(r6));

// 场景7：已过期卡（按钮禁用、无复选框、badge 已过期）→ disabled 且带回 badge
await evaluate(`(() => {
  document.querySelector("#watch-test-card")?.remove();
  const panel = document.createElement("div");
  panel.className = "approval"; panel.id = "watch-test-card";
  panel.innerHTML = '<div class="approval-head"><div><div class="approval-title green">BUY · CRCL</div>' +
    '<div class="contract">${ADDRESS}</div></div><span class="badge red">已过期</span></div>' +
    '<div class="approval-actions"><button type="button" class="approval-button approve" disabled>确认买入</button></div>' +
    '<div class="approval-result"></div>';
  document.getElementById("approval").replaceChildren(panel);
  return true;
})()`);
const r7 = await evaluate(buildAttemptJs(signal, true, false));
check("过期卡返回 disabled+badge", r7.status === "disabled" && r7.badge === "已过期", JSON.stringify(r7));

// 场景8：后端拒绝（决策未记录）→ submit-error，不可重试
await evaluate(`(() => {
  const panel = document.querySelector("#watch-test-card");
  panel.querySelector(".approval-result").textContent = "决策未记录：approval expired";
  return true;
})()`);
const r8 = await evaluate(VERIFY_JS);
check("后端拒绝识别 submit-error", r8.status === "submit-error", JSON.stringify(r8));

await evaluate(`(() => { document.querySelector("#watch-test-card")?.remove(); return true; })()`);
console.log(failures ? `\n${failures} 个场景失败` : "\n全部场景通过");
process.exit(failures ? 1 : 0);
