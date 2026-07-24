import assert from "node:assert/strict";
import test from "node:test";
import {
  patchBawSessionPersistence,
  sessionRotationAction
} from "../src/baw-session-patch.mjs";

test("keeps an unconfirmed sign-in session pending but persists established session rotations", () => {
  assert.equal(sessionRotationAction({
    endpoint: "/bapi/defi/v1/public/wallet-direct/agent-wallet/login",
    hasPendingSession: false
  }), "PENDING");
  assert.equal(sessionRotationAction({
    endpoint: "/bapi/defi/v1/public/wallet-direct/agent-wallet/login/confirm",
    hasPendingSession: true
  }), "PENDING");
  assert.equal(sessionRotationAction({
    endpoint: "/bapi/defi/v1/public/wallet-direct/agent-wallet/login/query",
    hasPendingSession: false
  }), "PERSIST");
});

test("patches the vulnerable BAW response-cookie write and is idempotent", () => {
  const vulnerableClientIdRecovery =
    'if(this.fileData.clientId){let e=this.decryptClientId(this.fileData.clientId);if(e)return this.decryptedClientId=e,this.decryptedClientId}this.decryptedClientId=hn(),this.clientIdRegenerated=!0';
  const vulnerable = [
    vulnerableClientIdRecovery,
    "before;",
    'T&&(M.session("Session ID extracted, pending commit"),this.sessionManager.setPendingSessionId(T[1]))',
    ";after"
  ].join("");
  const first = patchBawSessionPersistence(vulnerable);
  assert.equal(first.changed, true);
  assert.match(first.source, /pendingSessionId\|\|e\.endsWith/);
  assert.match(first.source, /await this\.sessionManager\.setSessionId/);
  assert.match(first.source, /BINANCE_INSTANCE_ID mismatch: refusing to clear the existing wallet session/);

  const second = patchBawSessionPersistence(first.source);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});

test("refuses to modify an unknown CLI build", () => {
  assert.throws(() => patchBawSessionPersistence("unknown build"), /unsupported BAW CLI build/);
});
