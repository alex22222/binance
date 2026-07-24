const vulnerableCookieWrite =
  'T&&(M.session("Session ID extracted, pending commit"),this.sessionManager.setPendingSessionId(T[1]))';
const durableCookieWrite =
  'T&&(M.session("Session ID extracted"),(this.sessionManager.pendingSessionId||e.endsWith("/agent-wallet/login")?this.sessionManager.setPendingSessionId(T[1]):await this.sessionManager.setSessionId(T[1])))';
const vulnerableClientIdRecovery =
  'if(this.fileData.clientId){let e=this.decryptClientId(this.fileData.clientId);if(e)return this.decryptedClientId=e,this.decryptedClientId}this.decryptedClientId=hn(),this.clientIdRegenerated=!0';
const guardedClientIdRecovery =
  'if(this.fileData.clientId){let e=this.decryptClientId(this.fileData.clientId);if(e)return this.decryptedClientId=e,this.decryptedClientId;throw new Error("BINANCE_INSTANCE_ID mismatch: refusing to clear the existing wallet session")}this.decryptedClientId=hn(),this.clientIdRegenerated=!0';

export function sessionRotationAction({ endpoint, hasPendingSession }) {
  return hasPendingSession || endpoint.endsWith("/agent-wallet/login")
    ? "PENDING"
    : "PERSIST";
}

export function patchBawSessionPersistence(source) {
  const vulnerableCount = source.split(vulnerableCookieWrite).length - 1;
  const durableCount = source.split(durableCookieWrite).length - 1;
  const vulnerableIdentityCount = source.split(vulnerableClientIdRecovery).length - 1;
  const guardedIdentityCount = source.split(guardedClientIdRecovery).length - 1;
  if (
    !((vulnerableCount === 1 && durableCount === 0) || (vulnerableCount === 0 && durableCount === 1)) ||
    !(
      (vulnerableIdentityCount === 1 && guardedIdentityCount === 0) ||
      (vulnerableIdentityCount === 0 && guardedIdentityCount === 1)
    )
  ) {
    throw new Error("unsupported BAW CLI build: session-cookie write path did not match");
  }
  const sessionPatched = vulnerableCount === 0;
  const identityPatched = vulnerableIdentityCount === 0;
  if (sessionPatched && identityPatched) return { source, changed: false };

  let patched = source;
  if (!sessionPatched) patched = patched.replace(vulnerableCookieWrite, durableCookieWrite);
  if (!identityPatched) patched = patched.replace(vulnerableClientIdRecovery, guardedClientIdRecovery);
  return {
    source: patched,
    changed: true
  };
}
