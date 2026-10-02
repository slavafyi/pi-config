export interface UsageWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: string;
}

export interface UsageEntry {
  provider: string;
  source: string;
  usage?: {
    primary: UsageWindow | null;
    secondary: UsageWindow | null;
    tertiary: UsageWindow | null;
  };
  error?: {
    code: number;
    message: string;
    kind?: string;
  };
}

export type UsageReport = UsageEntry[];

export interface QuotaStatus {
  window: string;
  usedPercent: number;
  leftPercent: number;
  reset?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
  return value;
}

function readWindow(value: unknown, field: string): UsageWindow | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`invalid ${field}`);
  const usedPercent = value.usedPercent;
  const windowMinutes = value.windowMinutes;
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100
  ) {
    throw new Error(`invalid ${field}.usedPercent`);
  }
  if (!Number.isInteger(windowMinutes) || (windowMinutes as number) <= 0) {
    throw new Error(`invalid ${field}.windowMinutes`);
  }
  if (
    value.resetsAt !== undefined &&
    (typeof value.resetsAt !== "string" || !Number.isFinite(Date.parse(value.resetsAt)))
  ) {
    throw new Error(`invalid ${field}.resetsAt`);
  }
  return {
    usedPercent,
    windowMinutes: windowMinutes as number,
    ...(value.resetsAt ? { resetsAt: value.resetsAt } : {}),
  };
}

function readEntry(value: unknown): UsageEntry {
  if (!isRecord(value)) throw new Error("invalid entry");
  const entry: UsageEntry = {
    provider: readString(value.provider, "entry.provider"),
    source: readString(value.source, "entry.source"),
  };
  if (value.usage !== undefined && value.usage !== null) {
    if (!isRecord(value.usage)) throw new Error("invalid entry.usage");
    entry.usage = {
      primary: readWindow(value.usage.primary, "usage.primary"),
      secondary: readWindow(value.usage.secondary, "usage.secondary"),
      tertiary: readWindow(value.usage.tertiary, "usage.tertiary"),
    };
  }
  if (value.error !== undefined && value.error !== null) {
    if (!isRecord(value.error) || !Number.isInteger(value.error.code)) {
      throw new Error("invalid entry.error");
    }
    entry.error = {
      code: value.error.code as number,
      message: readString(value.error.message, "error.message"),
      ...(typeof value.error.kind === "string" ? { kind: value.error.kind } : {}),
    };
  }
  if (!entry.usage && !entry.error) throw new Error("entry has neither usage nor error");
  return entry;
}

export function parseUsageReport(text: string): UsageReport {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("invalid usage report");
  const entries = value.map(readEntry);
  if (new Set(entries.map((entry) => entry.provider)).size !== entries.length) {
    throw new Error("duplicate usage provider");
  }
  return entries;
}

function readFiniteNumber(value: unknown, field: string): number {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`invalid ${field}`);
  return number;
}

type CodexWindowKind = "session" | "weekly";
interface CodexWindow {
  value: UsageWindow;
  kind?: CodexWindowKind;
}

function directWindow(value: unknown, field: string, now: Date): CodexWindow | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error(`invalid ${field}`);
  const usedPercent = readFiniteNumber(value.used_percent, `${field}.used_percent`);
  const windowSeconds = readFiniteNumber(
    value.limit_window_seconds,
    `${field}.limit_window_seconds`,
  );
  if (usedPercent < 0 || usedPercent > 100 || windowSeconds <= 0) {
    throw new Error(`invalid ${field}`);
  }
  const resetAt = value.reset_at === undefined
    ? undefined
    : readFiniteNumber(value.reset_at, `${field}.reset_at`);
  const resetAfterSeconds = value.reset_after_seconds === undefined
    ? undefined
    : readFiniteNumber(value.reset_after_seconds, `${field}.reset_after_seconds`);
  if (resetAfterSeconds !== undefined && resetAfterSeconds < 0) {
    throw new Error(`invalid ${field}.reset_after_seconds`);
  }
  const resetMilliseconds = resetAt !== undefined
    ? (resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1_000)
    : resetAfterSeconds !== undefined
      ? now.getTime() + resetAfterSeconds * 1_000
      : undefined;
  const resetDate = resetMilliseconds === undefined ? undefined : new Date(resetMilliseconds);
  if (resetDate && !Number.isFinite(resetDate.getTime())) {
    throw new Error(`invalid ${field} reset`);
  }
  return {
    value: {
      usedPercent,
      windowMinutes: Math.ceil(windowSeconds / 60),
      ...(resetDate ? { resetsAt: resetDate.toISOString() } : {}),
    },
    ...(windowSeconds === 18_000
      ? { kind: "session" as const }
      : windowSeconds === 604_800
        ? { kind: "weekly" as const }
        : {}),
  };
}

function classifyCodexWindows(
  primary: CodexWindow | null,
  secondary: CodexWindow | null,
): { primary: UsageWindow | null; secondary: UsageWindow | null; tertiary: null } {
  let session: UsageWindow | null = null;
  let weekly: UsageWindow | null = null;
  const insert = (window: CodexWindow | null, fallback: CodexWindowKind) => {
    if (!window) return;
    const kind = window.kind ?? fallback;
    if (kind === "session") {
      if (session) throw new Error("duplicate Codex 5h window");
      session = window.value;
    } else {
      if (weekly) throw new Error("duplicate Codex 7d window");
      weekly = window.value;
    }
  };
  insert(primary, "session");
  insert(secondary, "weekly");
  return { primary: session, secondary: weekly, tertiary: null };
}

export function parseCodexUsagePayload(text: string, now = new Date()): UsageReport {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !isRecord(value.rate_limit)) {
    throw new Error("invalid Codex usage payload");
  }
  const usage = classifyCodexWindows(
    directWindow(value.rate_limit.primary_window, "rate_limit.primary_window", now),
    directWindow(value.rate_limit.secondary_window, "rate_limit.secondary_window", now),
  );
  if (!usage.primary && !usage.secondary) {
    throw new Error("Codex usage payload has no windows");
  }
  return [{ provider: "codex", source: "oauth", usage }];
}

function headerNumber(
  headers: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function parseCodexRateLimitHeaders(
  headers: Record<string, string | undefined>,
): UsageReport | undefined {
  const readHeaderWindow = (key: "primary" | "secondary"): UsageWindow | null => {
    const usedPercent = headerNumber(headers, `x-codex-${key}-used-percent`);
    const windowMinutes = headerNumber(headers, `x-codex-${key}-window-minutes`);
    if (usedPercent === undefined || windowMinutes === undefined) return null;
    if (usedPercent < 0 || usedPercent > 100 || windowMinutes <= 0) return null;
    const resetAt = headerNumber(headers, `x-codex-${key}-reset-at`);
    const resetsAt = resetAt === undefined
      ? undefined
      : new Date(resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1_000).toISOString();
    return {
      usedPercent,
      windowMinutes,
      ...(resetsAt ? { resetsAt } : {}),
    };
  };
  const primary = readHeaderWindow("primary");
  const secondary = readHeaderWindow("secondary");
  if (!primary && !secondary) return undefined;
  const classifyHeaderWindow = (window: UsageWindow | null): CodexWindow | null => window && ({
    value: window,
    ...(window.windowMinutes === 300
      ? { kind: "session" as const }
      : window.windowMinutes === 10_080
        ? { kind: "weekly" as const }
        : {}),
  });
  return [{
    provider: "codex",
    source: "response-headers",
    usage: classifyCodexWindows(classifyHeaderWindow(primary), classifyHeaderWindow(secondary)),
  }];
}

function formatReset(resetsAt: string | undefined, now: Date): string | undefined {
  if (!resetsAt) return undefined;
  const milliseconds = Date.parse(resetsAt) - now.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  let minutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(minutes / 1_440);
  minutes %= 1_440;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  return `in ${days ? `${days}d` : ""}${hours ? `${hours}h` : ""}${minutes ? `${minutes}m` : ""}`;
}

function windowLabel(minutes: number): string {
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function quota(value: UsageWindow, window: string, now: Date): QuotaStatus {
  const reset = formatReset(value.resetsAt, now);
  return {
    window,
    usedPercent: value.usedPercent,
    leftPercent: Math.max(0, Math.round(100 - value.usedPercent)),
    ...(reset ? { reset } : {}),
  };
}

export function selectOpenAiQuotas(entry: UsageEntry, now = new Date()): QuotaStatus[] {
  return [entry.usage?.primary, entry.usage?.secondary]
    .filter((value): value is UsageWindow => Boolean(value))
    .map((value) => quota(value, windowLabel(value.windowMinutes), now));
}

export function selectOpenAiQuota(entry: UsageEntry, now = new Date()): QuotaStatus | undefined {
  const value = entry.usage?.secondary ?? entry.usage?.primary;
  return value ? quota(value, windowLabel(value.windowMinutes), now) : undefined;
}

export function selectQuota(
  report: UsageReport,
  now = new Date(),
): { entry?: UsageEntry; quota?: QuotaStatus; quotas?: QuotaStatus[] } {
  const entry = report.find((candidate) => candidate.provider === "codex");
  if (!entry || entry.error) return { entry };
  const quotas = selectOpenAiQuotas(entry, now);
  return { entry, quota: selectOpenAiQuota(entry, now), quotas };
}

export type QuotaTone = "dim" | "accent" | "warning" | "error";

export function quotaPercentTone(leftPercent: number): Exclude<QuotaTone, "dim"> {
  if (leftPercent <= 10) return "error";
  if (leftPercent <= 25) return "warning";
  return "accent";
}

export function styleQuotaStatus(
  value: QuotaStatus,
  style: (tone: QuotaTone, text: string) => string,
): string {
  const reset = value.reset?.replace(/^in\s+/, "");
  return (
    style("dim", `${value.window}:`) +
    style(quotaPercentTone(value.leftPercent), `${value.leftPercent}%`) +
    (reset ? style("dim", ` ↺${reset}`) : "")
  );
}

export function formatQuotaStatus(value: QuotaStatus): string {
  return styleQuotaStatus(value, (_tone, text) => text);
}

export function isAuthenticationError(message: string): boolean {
  return /auth|credential|login|sign[ -]?in|token|cookie|database not found/i.test(message);
}
