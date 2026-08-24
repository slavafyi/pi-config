import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

function jwtSubject(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const subject = (payload as { sub?: unknown }).sub;
    return typeof subject === "string" && subject ? subject : undefined;
  } catch {
    return undefined;
  }
}

export function accountFingerprint(provider: string, identity: string): string {
  return createHash("sha256").update(provider).update("\0").update(identity).digest("hex");
}

export function codexAccountFingerprint(accountId: string): string {
  return accountFingerprint("codex", accountId);
}

export function cursorAccountFingerprint(token: string): string {
  return accountFingerprint("cursor", jwtSubject(token) ?? token);
}
