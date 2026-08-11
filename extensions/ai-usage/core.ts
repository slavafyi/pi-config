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

export function preferredCursorPool(modelId: string): "Auto" | "API" {
  const { base } = normalizeCursorModelId(modelId);
  return base === "auto" || base === "default" || base.startsWith("composer-") ? "Auto" : "API";
}

export function selectCursorQuota(
  entry: UsageEntry,
  modelId: string,
  now = new Date(),
): QuotaStatus | undefined {
  const preferredPool = preferredCursorPool(modelId);
  const preferred = preferredPool === "Auto" ? entry.usage?.secondary : entry.usage?.tertiary;
  const other = preferredPool === "Auto" ? entry.usage?.tertiary : entry.usage?.secondary;
  const value = preferred ?? entry.usage?.primary ?? other;
  const label = preferred
    ? preferredPool.toLowerCase()
    : entry.usage?.primary
      ? "total"
      : preferredPool === "Auto"
        ? "api"
        : "auto";
  return value ? quota(value, label, now, label) : undefined;
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

export function formatQuotaStatus(value: QuotaStatus): string {
  return `${value.window}:${value.leftPercent}% left${value.reset ? ` (↺${value.reset})` : ""}`;
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
  "gpt-5-6-luna": "gpt-5.6-luna",
  "gpt-5-6-sol": "gpt-5.6-sol",
  "gpt-5-6-terra": "gpt-5.6-terra",
};

// USD per million tokens. Current models come from Cursor's Models & Pricing
// pages; older fallback models use the MIT-licensed oh-my-pi catalog.
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
  "claude-sonnet-5": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "composer-2.5": { input: 0.5, cacheWrite: 0, cacheRead: 0.2, output: 2.5 },
  "gemini-2.5-flash": { input: 0.3, cacheWrite: 0, cacheRead: 0.03, output: 2.5 },
  "gemini-3-flash": { input: 0.5, cacheWrite: 0, cacheRead: 0.05, output: 3 },
  "gemini-3.1-pro": { input: 2, cacheWrite: 0.375, cacheRead: 0.2, output: 12 },
  "gemini-3.5-flash": { input: 1.5, cacheWrite: 0.083333, cacheRead: 0.15, output: 9 },
  "gemini-3.6-flash": { input: 1.5, cacheWrite: 0.083333, cacheRead: 0.15, output: 7.5 },
  "gpt-5-mini": { input: 0.25, cacheWrite: 0, cacheRead: 0.025, output: 2 },
  "gpt-5.1": { input: 1.25, cacheWrite: 0, cacheRead: 0.125, output: 10 },
  "gpt-5.2": { input: 1.75, cacheWrite: 0, cacheRead: 0.175, output: 14 },
  "gpt-5.3-codex": { input: 1.75, cacheWrite: 0, cacheRead: 0.175, output: 14 },
  "gpt-5.4": { input: 2.5, cacheWrite: 0, cacheRead: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cacheWrite: 0, cacheRead: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cacheWrite: 0, cacheRead: 0.02, output: 1.25 },
  "gpt-5.5": { input: 5, cacheWrite: 0, cacheRead: 0.5, output: 30 },
  "gpt-5.6-luna": { input: 0.2, cacheWrite: 0.25, cacheRead: 0.02, output: 1.2 },
  "gpt-5.6-sol": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 30 },
  "gpt-5.6-terra": { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 12 },
  "grok-4.5": { input: 2, cacheWrite: 0, cacheRead: 0.5, output: 6 },
  "kimi-k3": { input: 3, cacheWrite: 0, cacheRead: 0.3, output: 15 },
};

const FAST_RATES: Record<string, TokenRates> = {
  "claude-opus-4-8": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  "claude-opus-5": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  "composer-2.5": { input: 3, cacheWrite: 0, cacheRead: 0.5, output: 15 },
  "gpt-5.5": { input: 12.5, cacheWrite: 0, cacheRead: 1.25, output: 75 },
  "gpt-5.6-luna": { input: 0.4, cacheWrite: 0.5, cacheRead: 0.04, output: 2.4 },
  "gpt-5.6-sol": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 60 },
  "gpt-5.6-terra": { input: 4, cacheWrite: 5, cacheRead: 0.4, output: 24 },
  "grok-4.5": { input: 4, cacheWrite: 0, cacheRead: 1, output: 18 },
};

const LONG_CONTEXT_RATES: Record<string, TokenRates> = {
  "gpt-5.5": { input: 10, cacheWrite: 0, cacheRead: 1, output: 45 },
  "gpt-5.6-sol": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 45 },
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
