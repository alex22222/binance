// Which job the bot cycle runs first. Pending orders and approvals block new scans.
export function cycleWorkItem(state) {
  if (state?.pendingOrder) return "pending-order";
  if (state?.approvalRequest) return "approval";
  return "positions-then-entry";
}
