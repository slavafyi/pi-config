export interface UsageWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: string;
}

export interface UsageEntry {
  provider: string;
  source: string;
  cursorModels?: string[];
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
  pool?: string;
}

interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface NormalizedModel {
  base: string;
  fast: boolean;
}

interface CostedMessage {
  role: "assistant";
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: TokenRates & { total: number };
  };
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
  if (value.cursorModels !== undefined) {
    if (!Array.isArray(value.cursorModels) || value.cursorModels.some((model) => typeof model !== "string")) {
      throw new Error("invalid entry.cursorModels");
    }
    entry.cursorModels = value.cursorModels;
  }
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

function directWindow(value: unknown, field: string): UsageWindow | null {
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
  const resetsAt = resetAt === undefined
    ? undefined
    : new Date(resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1_000).toISOString();
  return {
    usedPercent,
    windowMinutes: Math.ceil(windowSeconds / 60),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

export function parseCodexUsagePayload(text: string): UsageReport {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !isRecord(value.rate_limit)) {
    throw new Error("invalid Codex usage payload");
  }
  const entry: UsageEntry = {
    provider: "codex",
    source: "oauth",
    usage: {
      primary: directWindow(value.rate_limit.primary_window, "rate_limit.primary_window"),
      secondary: directWindow(value.rate_limit.secondary_window, "rate_limit.secondary_window"),
      tertiary: null,
    },
  };
  if (!entry.usage?.primary && !entry.usage?.secondary) {
    throw new Error("Codex usage payload has no windows");
  }
  return [entry];
}

function cursorPercent(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = readFiniteNumber(value, field);
  if (number < 0) throw new Error(`invalid ${field}`);
  return Math.min(100, number);
}

export function parseCursorUsagePayload(text: string): UsageReport {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !isRecord(value.planUsage)) {
    throw new Error("invalid Cursor usage payload");
  }
  const start = readFiniteNumber(value.billingCycleStart, "billingCycleStart");
  const end = readFiniteNumber(value.billingCycleEnd, "billingCycleEnd");
  const startMs = start < 1_000_000_000_000 ? start * 1_000 : start;
  const endMs = end < 1_000_000_000_000 ? end * 1_000 : end;
  const windowMinutes = Math.ceil((endMs - startMs) / 60_000);
  if (windowMinutes <= 0) throw new Error("invalid Cursor billing cycle");
  const resetsAt = new Date(endMs).toISOString();
  const window = (usedPercent: number | undefined): UsageWindow | null =>
    usedPercent === undefined ? null : { usedPercent, windowMinutes, resetsAt };
  const total = cursorPercent(value.planUsage.totalPercentUsed, "planUsage.totalPercentUsed");
  const cursor = cursorPercent(value.planUsage.autoPercentUsed, "planUsage.autoPercentUsed");
  const other = cursorPercent(value.planUsage.apiPercentUsed, "planUsage.apiPercentUsed");
  if (total === undefined && cursor === undefined && other === undefined) {
    throw new Error("Cursor usage payload has no percentages");
  }
  const cursorModels = Array.isArray(value.autoBucketModels)
    ? value.autoBucketModels.filter((model): model is string => typeof model === "string")
    : [];
  return [{
    provider: "cursor",
    source: "cursor-agent",
    ...(cursorModels.length ? { cursorModels } : {}),
    usage: {
      primary: window(total),
      secondary: window(cursor),
      tertiary: window(other),
    },
  }];
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
  return [{
    provider: "codex",
    source: "response-headers",
    usage: { primary, secondary, tertiary: null },
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

function quota(value: UsageWindow, window: string, now: Date, pool?: string): QuotaStatus {
  const reset = formatReset(value.resetsAt, now);
  return {
    window,
    usedPercent: value.usedPercent,
    leftPercent: Math.max(0, Math.round(100 - value.usedPercent)),
    ...(reset ? { reset } : {}),
    ...(pool ? { pool } : {}),
  };
}

export function selectOpenAiQuota(entry: UsageEntry, now = new Date()): QuotaStatus | undefined {
  const value = entry.usage?.secondary ?? entry.usage?.primary;
  return value ? quota(value, windowLabel(value.windowMinutes), now) : undefined;
}

export function normalizeCursorModelId(modelId: string): NormalizedModel {
  let base = modelId.toLowerCase().replace(/^cursor\//, "");
  let fast = false;
  if (base.endsWith(":fast")) {
    fast = true;
    base = base.slice(0, -5);
  } else if (base.endsWith(":slow")) {
    base = base.slice(0, -5);
  } else if (base.endsWith("-fast")) {
    fast = true;
    base = base.slice(0, -5);
  }
  base = base.replace(/@[a-z0-9.]+$/i, "");
  base = MODEL_ALIASES[base] ?? base;
  return { base, fast };
}

export type CursorPool = "Cursor" | "Other" | "Total";

export function preferredCursorPool(
  modelId: string,
  cursorModels?: readonly string[],
): CursorPool {
  const { base } = normalizeCursorModelId(modelId);
  if (base === "auto" || base === "auto-smart" || base === "default") return "Total";
  if (cursorModels) {
    const normalized = new Set(cursorModels.map((model) => normalizeCursorModelId(model).base));
    return normalized.has(base) ? "Cursor" : "Other";
  }
  if (base.startsWith("composer-") || base === "grok-4.5" || base === "grok-4.6") {
    return "Cursor";
  }
  return "Other";
}

export function selectCursorQuota(
  entry: UsageEntry,
  modelId: string,
  now = new Date(),
): QuotaStatus | undefined {
  const preferredPool = preferredCursorPool(modelId, entry.cursorModels);
  const candidates: Array<[UsageWindow | null | undefined, string]> =
    preferredPool === "Cursor"
      ? [
          [entry.usage?.secondary, "cursor"],
          [entry.usage?.primary, "total"],
          [entry.usage?.tertiary, "other"],
        ]
      : preferredPool === "Other"
        ? [
            [entry.usage?.tertiary, "other"],
            [entry.usage?.primary, "total"],
            [entry.usage?.secondary, "cursor"],
          ]
        : [
            [entry.usage?.primary, "total"],
            [entry.usage?.secondary, "cursor"],
            [entry.usage?.tertiary, "other"],
          ];
  const selected = candidates.find(([value]) => value);
  if (!selected?.[0]) return undefined;
  return quota(selected[0], selected[1], now, selected[1]);
}

export function selectQuota(
  report: UsageReport,
  provider: string,
  modelId: string,
  now = new Date(),
): { entry?: UsageEntry; quota?: QuotaStatus } {
  const id = provider === "openai-codex" ? "codex" : provider;
  const entry = report.find((candidate) => candidate.provider === id);
  if (!entry || entry.error) return { entry };
  return {
    entry,
    quota:
      provider === "openai-codex"
        ? selectOpenAiQuota(entry, now)
        : provider === "cursor"
          ? selectCursorQuota(entry, modelId, now)
          : undefined,
  };
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

const MODEL_ALIASES: Record<string, string> = {
  fable: "claude-fable-5",
  "fable-5": "claude-fable-5",
  "opus-4.5": "claude-opus-4-5",
  "opus-4.6": "claude-opus-4-6",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.8": "claude-opus-4-8",
  "opus-5": "claude-opus-5",
  "sonnet-5": "claude-sonnet-5",
  "composer-2-5": "composer-2.5",
  "grok-4-5": "grok-4.5",
  "grok-4-6": "grok-4.6",
  "gpt-5-6-luna": "gpt-5.6-luna",
  "gpt-5-6-sol": "gpt-5.6-sol",
  "gpt-5-6-terra": "gpt-5.6-terra",
};

// USD per million tokens. Sources: https://cursor.com/docs/models-and-pricing
// and https://cursor.com/docs/models/. Older fallback models use the MIT-licensed
// https://github.com/can1357/oh-my-pi catalog.
const STANDARD_RATES: Record<string, TokenRates> = {
  "claude-fable-5": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  "claude-opus-4-5": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-6": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-7": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-8": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-5": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-sonnet-4": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4-5": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4-6": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  "composer-2.5": { input: 0.5, cacheWrite: 0, cacheRead: 0.2, output: 2.5 },
  "gemini-2.5-flash": { input: 0.3, cacheWrite: 0, cacheRead: 0.03, output: 2.5 },
  "gemini-3-flash": { input: 0.5, cacheWrite: 0, cacheRead: 0.05, output: 3 },
  "gemini-3.1-pro": { input: 2, cacheWrite: 0.375, cacheRead: 0.2, output: 12 },
  "gemini-3.5-flash": { input: 1.5, cacheWrite: 0.083333, cacheRead: 0.15, output: 9 },
  "gemini-3.6-flash": { input: 1.5, cacheWrite: 0.083333, cacheRead: 0.15, output: 7.5 },
  "gemini-3.7-flash": { input: 0.75, cacheWrite: 0, cacheRead: 0.075, output: 3.5 },
  "glm-5.2": { input: 1.4, cacheWrite: 0, cacheRead: 0.26, output: 4.4 },
  "gpt-5-mini": { input: 0.25, cacheWrite: 0, cacheRead: 0.025, output: 2 },
  "gpt-5.1": { input: 1.25, cacheWrite: 0, cacheRead: 0.125, output: 10 },
  "gpt-5.2": { input: 1.75, cacheWrite: 0, cacheRead: 0.175, output: 14 },
  "gpt-5.3-codex": { input: 1.75, cacheWrite: 0, cacheRead: 0.175, output: 14 },
  "gpt-5.4": { input: 2.5, cacheWrite: 0, cacheRead: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cacheWrite: 0, cacheRead: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cacheWrite: 0, cacheRead: 0.02, output: 1.25 },
  "gpt-5.5": { input: 5, cacheWrite: 0, cacheRead: 0.5, output: 30 },
  "gpt-5.6-luna": { input: 0.2, cacheWrite: 0.25, cacheRead: 0.02, output: 1.2 },
  // Cursor promotional pricing through November 21, 2026.
  "gpt-5.6-sol": { input: 4, cacheWrite: 5, cacheRead: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 12 },
  "grok-4.5": { input: 2, cacheWrite: 0, cacheRead: 0.5, output: 6 },
  "grok-4.6": { input: 2, cacheWrite: 0, cacheRead: 0.5, output: 6 },
  "kimi-k2.7-code": { input: 0.95, cacheWrite: 0, cacheRead: 0.19, output: 4 },
  "kimi-k3": { input: 3, cacheWrite: 0, cacheRead: 0.3, output: 15 },
};

const FAST_RATES: Record<string, TokenRates> = {
  "claude-opus-4-7": { input: 30, cacheWrite: 37.5, cacheRead: 3, output: 150 },
  "claude-opus-4-8": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  "claude-opus-5": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  "composer-2.5": { input: 3, cacheWrite: 0, cacheRead: 0.5, output: 15 },
  "gpt-5.4": { input: 5, cacheWrite: 0, cacheRead: 0.5, output: 30 },
  "gpt-5.5": { input: 12.5, cacheWrite: 0, cacheRead: 1.25, output: 75 },
  "gpt-5.6-luna": { input: 0.4, cacheWrite: 0.5, cacheRead: 0.04, output: 2.4 },
  "gpt-5.6-sol": { input: 8, cacheWrite: 10, cacheRead: 0.8, output: 40 },
  "gpt-5.6-terra": { input: 4, cacheWrite: 5, cacheRead: 0.4, output: 24 },
  "grok-4.5": { input: 4, cacheWrite: 0, cacheRead: 1, output: 18 },
  "grok-4.6": { input: 4, cacheWrite: 0, cacheRead: 1, output: 12 },
};

const LONG_CONTEXT_RATES: Record<string, TokenRates> = {
  "gpt-5.4": { input: 5, cacheWrite: 0, cacheRead: 0.5, output: 22.5 },
  "gpt-5.5": { input: 10, cacheWrite: 0, cacheRead: 1, output: 45 },
  "gpt-5.6-sol": { input: 8, cacheWrite: 10, cacheRead: 0.8, output: 30 },
};

export function estimateCursorCost(
  modelId: string,
  usage: Pick<CostedMessage["usage"], "input" | "output" | "cacheRead" | "cacheWrite">,
): (TokenRates & { total: number }) | undefined {
  const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  if (!counts.every((count) => Number.isFinite(count) && count >= 0)) return undefined;
  const model = normalizeCursorModelId(modelId);
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const rates = model.fast
    ? FAST_RATES[model.base]
    : promptTokens > 272_000
      ? (LONG_CONTEXT_RATES[model.base] ?? STANDARD_RATES[model.base])
      : STANDARD_RATES[model.base];
  if (!rates) return undefined;
  const cost = {
    input: (usage.input * rates.input) / 1_000_000,
    output: (usage.output * rates.output) / 1_000_000,
    cacheRead: (usage.cacheRead * rates.cacheRead) / 1_000_000,
    cacheWrite: (usage.cacheWrite * rates.cacheWrite) / 1_000_000,
  };
  return { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite };
}

export function patchCursorMessageCost<T extends CostedMessage>(message: T): T {
  if (message.provider !== "cursor") return message;
  const current = message.usage.cost;
  if (
    [current.input, current.output, current.cacheRead, current.cacheWrite, current.total].some(
      (value) => value !== 0,
    )
  ) {
    return message;
  }
  const cost = estimateCursorCost(message.model, message.usage);
  return cost ? ({ ...message, usage: { ...message.usage, cost } } as T) : message;
}
