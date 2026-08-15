import assert from "node:assert/strict";
import test from "node:test";
import cacheTimer, { cacheDisplay, cacheWindowMs } from "./index.ts";

const MINUTE_MS = 60_000;

test("uses documented windows and the conservative Codex heuristic", () => {
  assert.equal(cacheWindowMs("openai", "gpt-5.6"), 30 * MINUTE_MS);
  assert.equal(cacheWindowMs("openai-codex", "gpt-5.6-sol"), 5 * MINUTE_MS);
  assert.equal(cacheWindowMs("cursor", "gpt-5.6-sol@1m:fast"), 30 * MINUTE_MS);
  assert.equal(cacheWindowMs("anthropic", "claude-opus-4-8"), 5 * MINUTE_MS);
  assert.equal(cacheWindowMs("cursor", "claude-opus-4-8@1m"), 5 * MINUTE_MS);
});

test("hides models without a known useful window", () => {
  for (const model of ["auto", "composer-2.5", "grok-4.5", "kimi-k2.5", "glm-5"]) {
    assert.equal(cacheWindowMs("cursor", model), undefined);
  }
});

test("dims, warns, and expires at the configured thresholds", () => {
  const windowMs = 5 * MINUTE_MS;
  assert.deepEqual(cacheDisplay(0, windowMs, 0), { text: "5:00", tone: "dim" });
  assert.deepEqual(cacheDisplay(0, windowMs, 3.5 * MINUTE_MS), { text: "1:30", tone: "warning" });
  assert.deepEqual(cacheDisplay(0, windowMs, windowMs - 1_000), { text: "0:01", tone: "warning" });
  assert.deepEqual(cacheDisplay(0, windowMs, windowMs), { text: "expired", tone: "error" });
});

test("does not restore persisted cache state and keeps the last runtime success after an error", () => {
  let now = 1_800_000_000_000;
  const originalNow = Date.now;
  Date.now = () => now;

  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const statuses: Array<string | undefined> = [];
  const statusIds: string[] = [];
  let themeName = "light";
  let unsubscribed = false;
  const previous = {
    role: "assistant",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    stopReason: "stop",
    timestamp: now - MINUTE_MS,
  };
  const ctx = {
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    sessionManager: { getBranch: () => [{ type: "message", message: previous }] },
    ui: {
      setStatus: (id: string, value: string | undefined) => {
        statusIds.push(id);
        statuses.push(value);
      },
      theme: { fg: (tone: string, text: string) => `${themeName}:${tone}:${text}` },
    },
  };

  try {
    cacheTimer({
      on: (event: string, handler: (event: any, ctx: any) => void) => handlers.set(event, handler),
      events: {
        on: (event: string, handler: (data: unknown) => void) => {
          eventHandlers.set(event, handler);
          return () => {
            unsubscribed = true;
            eventHandlers.delete(event);
          };
        },
      },
    } as any);
    handlers.get("session_start")?.({}, ctx);
    assert.equal(statuses.at(-1), undefined);

    handlers.get("turn_start")?.({ timestamp: now }, ctx);
    assert.equal(statuses.at(-1), "light:dim:5:00");

    themeName = "dark";
    const beforeInvalidate = statuses.length;
    eventHandlers.get("footer:invalidate")?.(undefined);
    assert.equal(statuses.at(-1), "dark:dim:5:00");
    eventHandlers.get("footer:invalidate")?.(undefined);
    assert.equal(statuses.length, beforeInvalidate + 1);

    handlers.get("turn_end")?.({ message: { ...previous, timestamp: now } }, ctx);

    now += MINUTE_MS;
    handlers.get("turn_start")?.({ timestamp: now }, ctx);
    handlers.get("turn_end")?.({ message: { ...previous, stopReason: "error", timestamp: now } }, ctx);
    assert.equal(statuses.at(-1), "dark:dim:4:00");

    handlers.get("session_shutdown")?.({}, ctx);
    assert.equal(unsubscribed, true);
    assert.ok(statusIds.length > 0);
    assert.ok(statusIds.every((id) => id === "cache-timer"));
  } finally {
    Date.now = originalNow;
  }
});
