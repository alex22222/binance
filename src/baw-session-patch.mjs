const vulnerableCookieWrite =
  'T&&(M.session("Session ID extracted, pending commit"),this.sessionManager.setPendingSessionId(T[1]))';
const durableCookieWrite =
  'T&&(M.session("Session ID extracted"),(this.sessionManager.pendingSessionId||e.endsWith("/agent-wallet/login")?this.sessionManager.setPendingSessionId(T[1]):await this.sessionManager.setSessionId(T[1])))';

export function sessionRotationAction({ endpoint, hasPendingSession }) {
  return hasPendingSession || endpoint.endsWith("/agent-wallet/login")
    ? "PENDING"
    : "PERSIST";
}

export function patchBawSessionPersistence(source) {
  const vulnerableCount = source.split(vulnerableCookieWrite).length - 1;
  const durableCount = source.split(durableCookieWrite).length - 1;
  if (vulnerableCount === 0 && durableCount === 1) {
    return { source, changed: false };
  }
  if (vulnerableCount !== 1 || durableCount !== 0) {
    throw new Error("unsupported BAW CLI build: session-cookie write path did not match");
  }
  return {
    source: source.replace(vulnerableCookieWrite, durableCookieWrite),
    changed: true
  };
}
