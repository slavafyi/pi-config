export interface UsageMetric {
  label: string;
  percent: number;
  value: string;
  detail: string;
}

export type UsageSection =
  | ({ type: "metric" } & UsageMetric)
  | { type: "text"; label: string; value: string }
  | { type: "block"; label: string; body: string[] }
  | { type: "spacer" };

export interface UsageEntry {
  id: string;
  name: string;
  plan: string | null;
  error: string | null;
  metrics: UsageMetric[];
  sections: UsageSection[];
}

export interface UsageReport {
  entries: UsageEntry[];
}

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

function readMetric(value: unknown): UsageMetric {
  if (!isRecord(value)) throw new Error("invalid metric");
  const percent = value.percent;
  if (!Number.isInteger(percent) || (percent as number) < 0 || (percent as number) > 65_535) {
    throw new Error("invalid metric.percent");
  }
  return {
    label: readString(value.label, "metric.label"),
    percent: percent as number,
    value: readString(value.value, "metric.value"),
    detail: readString(value.detail, "metric.detail"),
  };
}

function readSection(value: unknown): UsageSection {
  if (!isRecord(value)) throw new Error("invalid section");
  switch (value.type) {
    case "metric":
      return { type: "metric", ...readMetric(value) };
    case "text":
      return {
        type: "text",
        label: readString(value.label, "section.label"),
        value: readString(value.value, "section.value"),
      };
    case "block":
      if (!Array.isArray(value.body) || !value.body.every((line) => typeof line === "string")) {
        throw new Error("invalid section.body");
      }
      return {
        type: "block",
        label: readString(value.label, "section.label"),
        body: value.body,
      };
    case "spacer":
      return { type: "spacer" };
    default:
      throw new Error("invalid section.type");
  }
}

function readEntry(value: unknown): UsageEntry {
  if (!isRecord(value)) throw new Error("invalid entry");
  if (!Array.isArray(value.metrics) || !Array.isArray(value.sections)) {
    throw new Error("invalid entry collections");
  }
  if (value.plan !== null && typeof value.plan !== "string") throw new Error("invalid entry.plan");
  if (value.error !== null && typeof value.error !== "string")
    throw new Error("invalid entry.error");
  return {
    id: readString(value.id, "entry.id"),
    name: readString(value.name, "entry.name"),
    plan: value.plan,
    error: value.error,
    metrics: value.metrics.map(readMetric),
    sections: value.sections.map(readSection),
  };
}

export function parseUsageReport(text: string): UsageReport {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.entries)) throw new Error("invalid usage report");
  const entries = value.entries.map(readEntry);
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("duplicate usage entry id");
  }
  return { entries };
}

function normalizeReset(value: string): string | undefined {
  const reset = value
    .trim()
    .replace(/^resets\s+/i, "")
    .replace(/(\d[dhms])\s+(?=\d+[dhms]\b)/g, "$1");
  return reset && reset !== "—" ? reset : undefined;
}

function resetFromMetric(metric: UsageMetric): string | undefined {
  const match = /\bresets\s+(.+)$/i.exec(metric.detail);
  return match?.[1] ? normalizeReset(match[1].split(" · ", 1)[0] ?? "") : undefined;
}

function resetFromSections(entry: UsageEntry): string | undefined {
  const section = entry.sections.find(
    (item): item is Extract<UsageSection, { type: "text" }> =>
      item.type === "text" && item.label.toLowerCase() === "resets",
  );
  return section ? normalizeReset(section.value) : undefined;
}

function quota(metric: UsageMetric, window: string, reset?: string, pool?: string): QuotaStatus {
  return {
    window,
    usedPercent: metric.percent,
    leftPercent: Math.max(0, 100 - metric.percent),
    ...(reset ? { reset } : {}),
    ...(pool ? { pool } : {}),
  };
}

export function selectOpenAiQuota(entry: UsageEntry): QuotaStatus | undefined {
  const weekly = entry.metrics.find((metric) => /codex weekly|\b7d\b/i.test(metric.label));
  if (weekly) return quota(weekly, "7d", resetFromMetric(weekly));
  const session = entry.metrics.find((metric) => /codex 5h|\b5h\b/i.test(metric.label));
  if (session) return quota(session, "5h", resetFromMetric(session));
  const first = entry.metrics[0];
  return first ? quota(first, first.label, resetFromMetric(first)) : undefined;
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

export function preferredCursorPool(modelId: string): "Cursor Models" | "Other Models" {
  const { base } = normalizeCursorModelId(modelId);
  return base === "default" || base.startsWith("composer-") || base === "grok-4.5"
    ? "Cursor Models"
    : "Other Models";
}

export function selectCursorQuota(entry: UsageEntry, modelId: string): QuotaStatus | undefined {
  const preferred = preferredCursorPool(modelId);
  const metric =
    entry.metrics.find((item) => item.label === preferred) ??
    entry.metrics.find((item) => item.label === "Cursor Models") ??
    entry.metrics[0];
  return metric ? quota(metric, "cycle", resetFromSections(entry), metric.label) : undefined;
}

export function selectQuota(
  report: UsageReport,
  provider: string,
  modelId: string,
): { entry?: UsageEntry; quota?: QuotaStatus } {
  const id = provider === "openai-codex" ? "openai" : provider;
  const entry = report.entries.find((candidate) => candidate.id === id);
  if (!entry || entry.error) return { entry };
  return {
    entry,
    quota:
      provider === "openai-codex"
        ? selectOpenAiQuota(entry)
        : provider === "cursor"
          ? selectCursorQuota(entry, modelId)
          : undefined,
  };
}

export function formatQuotaStatus(value: QuotaStatus): string {
  return `${value.window}:${value.leftPercent}% left${value.reset ? ` (↺${value.reset})` : ""}`;
}

export function isAuthenticationError(message: string): boolean {
  return /auth|credential|login|sign[ -]?in|token|database not found/i.test(message);
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
