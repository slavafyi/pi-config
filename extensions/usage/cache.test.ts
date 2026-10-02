import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cachedUsageExpiresAt,
  isCachedUsageFresh,
  isCachedUsageUsable,
  mergeUsageCaches,
  parseUsageCache,
  withUsageCacheLock,
  type CachedUsageReport,
} from "./cache.ts";
import type { UsageReport } from "./core.ts";

const codexReport: UsageReport = [{
  provider: "codex",
  source: "oauth",
  usage: {
    primary: { usedPercent: 10, windowMinutes: 300 },
    secondary: { usedPercent: 20, windowMinutes: 10_080 },
    tertiary: null,
  },
}];

function cached(
  report: UsageReport,
  fetchedAt = 1_000,
  accountKey = "account-key",
): CachedUsageReport {
  return { report, fetchedAt, accountKey };
}

test("parses only Codex persistent usage reports", () => {
  const valid = cached(codexReport, 123);
  const cache = parseUsageCache(JSON.stringify({
    version: 2,
    reports: {
      codex: valid,
      unsupported: cached([{ ...codexReport[0]!, provider: "unsupported" }]),
      missingAccount: { report: codexReport, fetchedAt: 456 },
      broken: { report: { nope: true }, fetchedAt: 789, accountKey: "other" },
    },
  }));
  assert.deepEqual(cache, { codex: valid });
});

test("invalidates the previous cache version", () => {
  assert.deepEqual(parseUsageCache(JSON.stringify({
    version: 1,
    reports: { codex: { report: codexReport, fetchedAt: 123 } },
  })), {});
});

test("accepts only matching, bounded cache entries", () => {
  const value = cached(codexReport, 1_000, "one");
  assert.equal(isCachedUsageUsable(value, "one", 1_999, 1_000), true);
  assert.equal(isCachedUsageFresh(value, 1_500, 1_000), true);
  assert.equal(isCachedUsageUsable(value, "two", 1_999, 1_000), false);
  assert.equal(isCachedUsageUsable(value, "one", 2_000, 1_000), false);
  assert.equal(isCachedUsageUsable(value, "one", 999, 1_000), false);
  assert.equal(cachedUsageExpiresAt(value, 1_000), 2_000);
});

test("discards non-Codex entries inside a persisted report", () => {
  const valid = cached(codexReport);
  const unsupported = { ...codexReport[0]!, provider: "unsupported" };
  assert.deepEqual(parseUsageCache(JSON.stringify({
    version: 2,
    reports: { codex: cached([...codexReport, unsupported]) },
  })), { codex: valid });
  assert.deepEqual(parseUsageCache(JSON.stringify({
    version: 2,
    reports: { codex: cached([unsupported]) },
  })), {});
});

test("merges provider caches without losing the newest entry", () => {
  const oldCodex = cached(codexReport, 1, "codex");
  const newCodex = cached(codexReport, 3, "codex");
  assert.deepEqual(
    mergeUsageCaches({ codex: oldCodex }, { codex: newCodex }, { codex: oldCodex }),
    { codex: newCodex },
  );
});

test("serializes concurrent cache lock owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-lock-"));
  const path = join(directory, "usage-cache.json");
  const order: string[] = [];
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  try {
    const first = withUsageCacheLock(path, async () => {
      order.push("first:start");
      markStarted();
      await gate;
      order.push("first:end");
    }, { retryMs: 5 });
    await started;
    const second = withUsageCacheLock(path, async () => {
      order.push("second");
    }, { retryMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "first:end", "second"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers an abandoned cache lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-stale-lock-"));
  const path = join(directory, "usage-cache.json");
  const lockPath = `${path}.lock`;
  try {
    await mkdir(lockPath);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    let called = false;
    await withUsageCacheLock(path, async () => {
      called = true;
    }, { staleMs: 10, retryMs: 1 });
    assert.equal(called, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("releases the cache lock when its callback throws", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-error-lock-"));
  const path = join(directory, "usage-cache.json");
  try {
    await assert.rejects(
      withUsageCacheLock(path, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    let reacquired = false;
    await withUsageCacheLock(path, async () => {
      reacquired = true;
    });
    assert.equal(reacquired, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
