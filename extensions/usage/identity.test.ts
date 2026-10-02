import assert from "node:assert/strict";
import test from "node:test";
import { accountFingerprint, codexAccountFingerprint } from "./identity.ts";

test("creates provider-scoped account fingerprints", () => {
  const identity = "account-123";
  assert.equal(codexAccountFingerprint(identity), accountFingerprint("codex", identity));
  assert.notEqual(accountFingerprint("codex", identity), accountFingerprint("other", identity));
  assert.doesNotMatch(codexAccountFingerprint(identity), /account-123/);
});
