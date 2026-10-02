import { createHash } from "node:crypto";

export function accountFingerprint(provider: string, identity: string): string {
  return createHash("sha256").update(provider).update("\0").update(identity).digest("hex");
}

export function codexAccountFingerprint(accountId: string): string {
  return accountFingerprint("codex", accountId);
}
