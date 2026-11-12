import { realpath } from "node:fs/promises";
import { basename } from "node:path";

const HASH = /^[a-f0-9]{64}$/;

export async function dashboardHealth({
  uiRoot = process.env.PERSONAL_ASSETS_CODE_ROOT || "",
  identityText = null,
  readIdentity = null,
  resolvePath = realpath
} = {}) {
  let uiRelease = null;
  if (uiRoot) {
    try { uiRelease = basename(await resolvePath(uiRoot)); } catch { uiRelease = null; }
  }
  let tradingIdentity = null;
  try {
    const text = identityText ?? (readIdentity ? await readIdentity() : null);
    const parsed = text ? JSON.parse(text) : null;
    if (parsed && HASH.test(parsed.liveCodeHash)) tradingIdentity = parsed.liveCodeHash;
  } catch { tradingIdentity = null; }
  return { status: "ok", uiRelease, tradingIdentity };
}
