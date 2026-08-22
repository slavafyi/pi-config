import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseUsageReport, type UsageReport } from "./core.ts";

const CACHE_VERSION = 1;

export interface CachedUsageReport {
  report: UsageReport;
  fetchedAt: number;
}

export type UsageCache = Record<string, CachedUsageReport>;

export function parseUsageCache(text: string): UsageCache {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const root = value as { version?: unknown; reports?: unknown };
  if (root.version !== CACHE_VERSION || !root.reports || typeof root.reports !== "object") {
    return {};
  }
  const result: UsageCache = {};
  for (const [provider, cached] of Object.entries(root.reports)) {
    if (!cached || typeof cached !== "object" || Array.isArray(cached)) continue;
    const entry = cached as { report?: unknown; fetchedAt?: unknown };
    if (typeof entry.fetchedAt !== "number" || !Number.isFinite(entry.fetchedAt)) continue;
    try {
      result[provider] = {
        report: parseUsageReport(JSON.stringify(entry.report)),
        fetchedAt: entry.fetchedAt,
      };
    } catch {
      // Ignore one malformed provider without discarding other cached reports.
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

export async function writeUsageCache(path: string, reports: UsageCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ version: CACHE_VERSION, reports }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporary, path);
}
