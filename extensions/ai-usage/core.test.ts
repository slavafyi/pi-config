import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  estimateCursorCost,
  formatQuotaStatus,
  isAuthenticationError,
  normalizeCursorModelId,
  parseUsageReport,
  patchCursorMessageCost,
  selectCursorQuota,
  selectOpenAiQuota,
  selectQuota,
  type UsageEntry,
} from "./core.ts";

const fixture = parseUsageReport(
  readFileSync(new URL("./fixtures/usage.json", import.meta.url), "utf8"),
);

function entry(id: string): UsageEntry {
  const result = fixture.entries.find((candidate) => candidate.id === id);
  assert.ok(result);
  return result;
}

function message(provider = "cursor") {
  return {
    role: "assistant" as const,
    provider,
    model: "gpt-5.6-sol@1m:fast",
    usage: {
      input: 1_000,
      output: 100,
      cacheRead: 2_000,
      cacheWrite: 300,
      totalTokens: 3_400,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("parses the supported ai-usagebar report shape strictly", () => {
  assert.deepEqual(
    fixture.entries.map(({ id }) => id),
    ["openai", "cursor"],
  );
  assert.throws(() => parseUsageReport('{"entries":[{"id":"openai"}]}'), /invalid/);
  assert.throws(
    () =>
      parseUsageReport(
        '{"entries":[{"id":"x","name":"x","plan":null,"error":null,"metrics":[],"sections":[{"type":"new"}]}]}',
      ),
    /section.type/,
  );
});

test("uses the useful OpenAI weekly window and reports percent left", () => {
  const quota = selectOpenAiQuota(entry("openai"));
  assert.ok(quota);
  assert.equal(quota.usedPercent, 18);
  assert.equal(formatQuotaStatus(quota), "7d:82% left (↺in 4d22h7m)");
});

test("selects one relevant Cursor pool without combining pools", () => {
  const composer = selectCursorQuota(entry("cursor"), "composer-2.5:fast");
  assert.ok(composer);
  assert.equal(composer.pool, "Cursor Models");
  assert.equal(formatQuotaStatus(composer), "cycle:80% left (↺in 9d4h)");

  const gpt = selectCursorQuota(entry("cursor"), "gpt-5.6-sol@1m:slow");
  assert.ok(gpt);
  assert.equal(gpt.pool, "Other Models");
  assert.equal(gpt.usedPercent, 55);
  assert.equal(formatQuotaStatus(gpt), "cycle:45% left (↺in 9d4h)");
});

test("recognizes an unavailable auth entry", () => {
  const report = parseUsageReport(
    readFileSync(new URL("./fixtures/cursor-unavailable.json", import.meta.url), "utf8"),
  );
  const selected = selectQuota(report, "cursor", "gpt-5.6-sol");
  assert.equal(selected.quota, undefined);
  assert.ok(selected.entry?.error && isAuthenticationError(selected.entry.error));
});

test("normalizes context and fast/slow model selectors", () => {
  assert.deepEqual(normalizeCursorModelId("cursor/gpt-5-6-sol@1m:fast"), {
    base: "gpt-5.6-sol",
    fast: true,
  });
  assert.deepEqual(normalizeCursorModelId("composer-2-5@200k:slow"), {
    base: "composer-2.5",
    fast: false,
  });
});

test("uses explicit Fast rates and emits a complete cost breakdown", () => {
  const cost = estimateCursorCost("gpt-5.6-sol@1m:fast", message().usage);
  assert.ok(cost);
  assert.equal(cost.input, 0.01);
  assert.equal(cost.output, 0.006);
  assert.equal(cost.cacheRead, 0.002);
  assert.equal(cost.cacheWrite, 0.00375);
  assert.ok(Math.abs(cost.total - 0.02175) < 1e-12);
});

test("patches only new zero-cost Cursor messages once", () => {
  const original = message();
  const patched = patchCursorMessageCost(original);
  assert.notEqual(patched, original);
  assert.ok(Math.abs(patched.usage.cost.total - 0.02175) < 1e-12);
  assert.equal(patchCursorMessageCost(patched), patched);
  const openai = message("openai-codex");
  assert.equal(patchCursorMessageCost(openai), openai);
});

test("uses documented long-context rates only with a token signal", () => {
  const cost = estimateCursorCost("gpt-5.6-sol@1m:slow", {
    input: 10_000,
    output: 1_000,
    cacheRead: 270_000,
    cacheWrite: 0,
  });
  assert.ok(cost);
  assert.equal(cost.input, 0.1);
  assert.equal(cost.cacheRead, 0.27);
  assert.equal(cost.output, 0.045);
});
