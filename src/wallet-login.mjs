function publicState(state) {
  if (!state) return { status: "IDLE" };
  const { qrCodeId, ...visible } = state;
  return visible;
}

function officialBinanceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !(url.hostname === "binance.com" || url.hostname.endsWith(".binance.com"))) {
    throw new Error("Wallet login did not return an official Binance HTTPS URL");
  }
  return url.href;
}

export function createWalletLoginManager({ executeBaw, now = () => Date.now() }) {
  let current = null;

  return {
    async start() {
      if (current?.status === "PENDING" && now() < current.expiresAtMs) return publicState(current);
      const result = await executeBaw(["auth", "signin"]);
      if (result.status === "ALREADY_CONNECTED") {
        current = { status: "CONNECTED", connectedAt: new Date(now()).toISOString() };
        return publicState(current);
      }
      const urlForWeb = officialBinanceUrl(result.urlForWeb);
      const expiresAtMs = Number(result.expireAt);
      if (!result.qrCodeId || !/^[a-zA-Z0-9-]{20,100}$/.test(result.qrCodeId)) {
        throw new Error("Wallet login returned an invalid QR code ID");
      }
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) {
        throw new Error("Wallet login returned an expired QR code");
      }
      current = {
        status: "PENDING",
        urlForWeb,
        pairingCode: String(result.pairingCode || ""),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        qrCodeId: result.qrCodeId
      };
      const verificationId = result.qrCodeId;
      void executeBaw(["auth", "verify", "--qrCodeId", verificationId]).then((verification) => {
        if (current?.qrCodeId !== verificationId) return;
        current = verification.status === "SUCCESS"
          ? { status: "CONNECTED", connectedAt: new Date(now()).toISOString() }
          : { status: "FAILED", error: `Wallet verification returned ${verification.status || "unknown"}` };
      }).catch((error) => {
        if (current?.qrCodeId === verificationId) current = { status: "FAILED", error: error.message };
      });
      return publicState(current);
    },
    status() {
      if (current?.status === "PENDING" && now() > current.expiresAtMs) {
        current = { status: "EXPIRED", error: "二维码已过期，请重新生成" };
      }
      return publicState(current);
    }
  };
}
