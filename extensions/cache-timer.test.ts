import assert from "node:assert/strict";
import test from "node:test";
import { cacheDisplay, cacheWindowMs } from "./cache-timer.ts";

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
  assert.deepEqual(cacheDisplay(0, windowMs, 0), { text: "cache 5:00", tone: "dim" });
  assert.deepEqual(cacheDisplay(0, windowMs, 3.5 * MINUTE_MS), { text: "cache 1:30", tone: "warning" });
  assert.deepEqual(cacheDisplay(0, windowMs, windowMs - 1_000), { text: "cache 0:01", tone: "warning" });
  assert.deepEqual(cacheDisplay(0, windowMs, windowMs), { text: "cache expired", tone: "error" });
});
