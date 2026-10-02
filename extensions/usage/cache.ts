import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { parseUsageReport, type UsageReport } from "./core.ts";

const CACHE_VERSION = 2;
export const MAX_STALE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 45_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 50;

export interface CachedUsageReport {
  report: UsageReport;
  fetchedAt: number;
  accountKey: string;
}

export type UsageCache = Record<string, CachedUsageReport>;

export interface CacheLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

export function parseUsageCache(text: string): UsageCache {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const root = value as { version?: unknown; reports?: unknown };
  if (root.version !== CACHE_VERSION || !root.reports || typeof root.reports !== "object") {
    return {};
  }
  const result: UsageCache = {};
  for (const [provider, cached] of Object.entries(root.reports)) {
    if (provider !== "codex" || !cached || typeof cached !== "object" || Array.isArray(cached)) continue;
    const entry = cached as { report?: unknown; fetchedAt?: unknown; accountKey?: unknown };
    if (
      typeof entry.fetchedAt !== "number" ||
      !Number.isFinite(entry.fetchedAt) ||
      typeof entry.accountKey !== "string" ||
      !entry.accountKey
    ) {
      continue;
    }
    try {
      const report = parseUsageReport(JSON.stringify(entry.report))
        .filter((entry) => entry.provider === "codex");
      if (!report.length) continue;
      result[provider] = {
        report,
        fetchedAt: entry.fetchedAt,
        accountKey: entry.accountKey,
      };
    } catch {
      continue;
    }
  }
  return result;
}

export async function readUsageCache(path: string): Promise<UsageCache> {
  try {
    return parseUsageCache(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

export function mergeUsageCaches(...values: UsageCache[]): UsageCache {
  const result: UsageCache = {};
  for (const value of values) {
    for (const [provider, candidate] of Object.entries(value)) {
      const current = result[provider];
      if (!current || candidate.fetchedAt >= current.fetchedAt) result[provider] = candidate;
    }
  }
  return result;
}

export function cachedUsageExpiresAt(
  cached: CachedUsageReport,
  maxStaleMs = MAX_STALE_MS,
): number | undefined {
  const staleAt = cached.fetchedAt + maxStaleMs;
  return Number.isNaN(staleAt) ? undefined : staleAt;
}

export function isCachedUsageUsable(
  cached: CachedUsageReport | undefined,
  accountKey: string,
  now = Date.now(),
  maxStaleMs = MAX_STALE_MS,
): cached is CachedUsageReport {
  if (!cached || cached.accountKey !== accountKey) return false;
  const age = now - cached.fetchedAt;
  if (!Number.isFinite(age) || age < 0) return false;
  const expiresAt = cachedUsageExpiresAt(cached, maxStaleMs);
  return expiresAt !== undefined && now < expiresAt;
}

export function isCachedUsageFresh(
  cached: CachedUsageReport,
  now: number,
  ttlMs: number,
): boolean {
  const age = now - cached.fetchedAt;
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

export async function writeUsageCache(path: string, reports: UsageCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: CACHE_VERSION, reports }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function withUsageCacheLock<T>(
  cachePath: string,
  callback: () => Promise<T>,
  options: CacheLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Math.max(options.staleMs ?? DEFAULT_LOCK_STALE_MS, 2_000);
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  await mkdir(dirname(cachePath), { recursive: true });
  const release = await lockfile.lock(cachePath, {
    realpath: false,
    stale: staleMs,
    update: Math.max(1_000, Math.floor(staleMs / 3)),
    retries: {
      retries: Math.ceil(timeoutMs / retryMs),
      factor: 1,
      minTimeout: retryMs,
      maxTimeout: retryMs,
      randomize: true,
    },
  });
  try {
    return await callback();
  } finally {
    await release();
  }
}
