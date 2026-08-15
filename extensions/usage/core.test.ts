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
  quotaPercentTone,
  selectCursorQuota,
  selectOpenAiQuota,
  selectQuota,
  styleQuotaStatus,
  type UsageEntry,
} from "./core.ts";

const fixture = parseUsageReport(
  readFileSync(new URL("./fixtures/usage.json", import.meta.url), "utf8"),
);

function entry(provider: string): UsageEntry {
  const result = fixture.find((candidate) => candidate.provider === provider);
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

test("parses the supported CodexBar usage shape strictly", () => {
  assert.deepEqual(
    fixture.map(({ provider }) => provider),
    ["codex", "cursor"],
  );
  assert.throws(() => parseUsageReport('{"entries":[]}'), /invalid/);
  assert.throws(
    () =>
      parseUsageReport(
        '[{"provider":"codex","source":"oauth","usage":{"primary":null,"secondary":{"usedPercent":101,"windowMinutes":10080},"tertiary":null}}]',
      ),
    /usedPercent/,
  );
});

const now = new Date("2026-08-11T10:00:00Z");

test("uses the useful OpenAI weekly window and accents only percent left", () => {
  const quota = selectOpenAiQuota(entry("codex"), now);
  assert.ok(quota);
  assert.equal(quota.usedPercent, 18);
  assert.equal(formatQuotaStatus(quota), "7d:82% ↺4d22h7m");

  const parts: Array<[string, string]> = [];
  const styled = styleQuotaStatus(quota, (tone, text) => {
    parts.push([tone, text]);
    return `<${tone}>${text}</${tone}>`;
  });
  assert.deepEqual(parts, [
    ["dim", "7d:"],
    ["accent", "82%"],
    ["dim", " ↺4d22h7m"],
  ]);
  assert.equal(
    styled,
    "<dim>7d:</dim><accent>82%</accent><dim> ↺4d22h7m</dim>",
  );
});

test("changes quota percent tone at warning and error thresholds", () => {
  assert.equal(quotaPercentTone(100), "accent");
  assert.equal(quotaPercentTone(26), "accent");
  assert.equal(quotaPercentTone(25), "warning");
  assert.equal(quotaPercentTone(11), "warning");
  assert.equal(quotaPercentTone(10), "error");
  assert.equal(quotaPercentTone(0), "error");
});

test("selects the active Cursor pool without combining pools", () => {
  const composer = selectCursorQuota(entry("cursor"), "composer-2.5:fast", now);
  assert.ok(composer);
  assert.equal(composer.pool, "auto");
  assert.equal(formatQuotaStatus(composer), "auto:80% ↺9d4h");

  const gpt = selectCursorQuota(entry("cursor"), "gpt-5.6-sol@1m:slow", now);
  assert.ok(gpt);
  assert.equal(gpt.pool, "api");
  assert.equal(gpt.usedPercent, 55);
  assert.equal(formatQuotaStatus(gpt), "api:45% ↺9d4h");
});

test("falls back to Cursor total when the active pool is absent", () => {
  const cursor = entry("cursor");
  assert.ok(cursor.usage?.primary);
  const total = selectCursorQuota(
    { ...cursor, usage: { primary: cursor.usage.primary, secondary: null, tertiary: null } },
    "auto",
    now,
  );
  assert.ok(total);
  assert.equal(total.pool, "total");
  assert.equal(formatQuotaStatus(total), "total:99% ↺9d4h");
});

test("recognizes an unavailable auth entry", () => {
  const report = parseUsageReport(
    readFileSync(new URL("./fixtures/cursor-unavailable.json", import.meta.url), "utf8"),
  );
  const selected = selectQuota(report, "cursor", "gpt-5.6-sol", now);
  assert.equal(selected.quota, undefined);
  assert.ok(selected.entry?.error && isAuthenticationError(selected.entry.error.message));
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
  assert.deepEqual(normalizeCursorModelId("grok-4-6:fast"), {
    base: "grok-4.6",
    fast: true,
  });
});

test("uses current Cursor rates for newly listed and repriced models", () => {
  const usage = {
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
  };
  const expected = new Map([
    ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
    ["gemini-3.7-flash", { input: 0.75, output: 3.5, cacheRead: 0.075, cacheWrite: 0 }],
    ["glm-5.2", { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }],
    ["grok-4.5:fast", { input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }],
    ["grok-4.6:fast", { input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }],
    ["kimi-k2.7-code", { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 }],
  ]);

  for (const [model, rates] of expected) {
    const cost = estimateCursorCost(model, usage);
    assert.ok(cost, model);
    assert.deepEqual(
      {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead,
        cacheWrite: cost.cacheWrite,
      },
      rates,
      model,
    );
  }
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
