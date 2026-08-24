import assert from "node:assert/strict";
import test from "node:test";
import {
  accountFingerprint,
  codexAccountFingerprint,
  cursorAccountFingerprint,
} from "./identity.ts";

function token(subject: string, suffix: string): string {
  return [
    "header",
    Buffer.from(JSON.stringify({ sub: subject, nonce: suffix })).toString("base64url"),
    suffix,
  ].join(".");
}

test("creates provider-scoped account fingerprints", () => {
  const identity = "account-123";
  assert.equal(codexAccountFingerprint(identity), accountFingerprint("codex", identity));
  assert.notEqual(accountFingerprint("codex", identity), accountFingerprint("cursor", identity));
  assert.doesNotMatch(codexAccountFingerprint(identity), /account-123/);
});

test("keeps Cursor identity stable across JWT rotation", () => {
  assert.equal(
    cursorAccountFingerprint(token("user-123", "first")),
    cursorAccountFingerprint(token("user-123", "second")),
  );
  assert.notEqual(
    cursorAccountFingerprint(token("user-123", "first")),
    cursorAccountFingerprint(token("user-456", "first")),
  );
});

test("falls back to the opaque Cursor token without storing it", () => {
  const fingerprint = cursorAccountFingerprint("opaque-secret-token");
  assert.equal(fingerprint.length, 64);
  assert.doesNotMatch(fingerprint, /secret/);
  assert.notEqual(fingerprint, cursorAccountFingerprint("rotated-token"));
});
