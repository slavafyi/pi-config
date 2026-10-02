import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatQuotaStatus,
  isAuthenticationError,
  parseCodexRateLimitHeaders,
  parseCodexUsagePayload,
  parseUsageReport,
  quotaPercentTone,
  selectOpenAiQuota,
  selectOpenAiQuotas,
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

test("parses the normalized usage shape strictly", () => {
  assert.deepEqual(
    fixture.map(({ provider }) => provider),
    ["codex"],
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

test("normalizes direct Codex usage and response headers", () => {
  const payload = parseCodexUsagePayload(JSON.stringify({
    rate_limit: {
      primary_window: {
        used_percent: 12,
        limit_window_seconds: 18_000,
        reset_at: 1_786_500_000,
      },
      secondary_window: {
        used_percent: 34,
        limit_window_seconds: 604_800,
        reset_at: 1_786_800_000,
      },
    },
  }));
  assert.equal(payload[0]?.usage?.primary?.windowMinutes, 300);
  assert.equal(payload[0]?.usage?.secondary?.usedPercent, 34);

  const headers = parseCodexRateLimitHeaders({
    "x-codex-primary-used-percent": "12",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1786500000",
    "x-codex-secondary-used-percent": "34",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "1786800000",
  });
  assert.deepEqual(headers?.[0]?.usage, payload[0]?.usage);
});

test("classifies Codex windows by duration instead of wire position", () => {
  const reordered = parseCodexUsagePayload(JSON.stringify({
    rate_limit: {
      primary_window: { used_percent: 70, limit_window_seconds: 604_800 },
      secondary_window: { used_percent: 20, limit_window_seconds: 18_000 },
    },
  }));
  assert.equal(reordered[0]?.usage?.primary?.usedPercent, 20);
  assert.equal(reordered[0]?.usage?.secondary?.usedPercent, 70);

  const reorderedHeaders = parseCodexRateLimitHeaders({
    "x-codex-primary-used-percent": "70",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-secondary-used-percent": "20",
    "x-codex-secondary-window-minutes": "300",
  });
  assert.equal(reorderedHeaders?.[0]?.usage?.primary?.usedPercent, 20);
  assert.equal(reorderedHeaders?.[0]?.usage?.secondary?.usedPercent, 70);

  const weeklyOnly = parseCodexUsagePayload(JSON.stringify({
    rate_limit: {
      primary_window: { used_percent: 42, limit_window_seconds: 604_800 },
      secondary_window: null,
    },
  }));
  assert.equal(weeklyOnly[0]?.usage?.primary, null);
  assert.equal(weeklyOnly[0]?.usage?.secondary?.usedPercent, 42);

  assert.throws(
    () => parseCodexUsagePayload(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 604_800 },
        secondary_window: { used_percent: 20, limit_window_seconds: 604_800 },
      },
    })),
    /duplicate Codex 7d window/,
  );
});

test("falls back to Codex wire position for unknown window durations", () => {
  const report = parseCodexUsagePayload(JSON.stringify({
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 3_600 },
      secondary_window: { used_percent: 20, limit_window_seconds: 17_999 },
    },
  }));
  assert.equal(report[0]?.usage?.primary?.windowMinutes, 60);
  assert.equal(report[0]?.usage?.secondary?.windowMinutes, 300);
});

test("uses Codex reset_after_seconds when reset_at is absent", () => {
  const report = parseCodexUsagePayload(JSON.stringify({
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 18_000,
        reset_after_seconds: 90,
      },
    },
  }), new Date("2026-08-11T10:00:00Z"));
  assert.equal(report[0]?.usage?.primary?.resetsAt, "2026-08-11T10:01:30.000Z");

  assert.throws(
    () => parseCodexUsagePayload(JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 18_000,
          reset_after_seconds: -1,
        },
      },
    })),
    /reset_after_seconds/,
  );
});

const now = new Date("2026-08-11T10:00:00Z");

test("selects and formats OpenAI quota windows", () => {
  const quotas = selectOpenAiQuotas(entry("codex"), now);
  assert.deepEqual(quotas.map(formatQuotaStatus), [
    "5h:96% ↺3h",
    "7d:82% ↺4d22h7m",
  ]);

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

test("recognizes an unavailable auth entry", () => {
  const report = parseUsageReport(JSON.stringify([{
    provider: "codex",
    source: "oauth",
    error: { code: 401, message: "OpenAI authentication is unavailable" },
  }]));
  const selected = selectQuota(report, now);
  assert.equal(selected.quota, undefined);
  assert.ok(selected.entry?.error && isAuthenticationError(selected.entry.error.message));
});
