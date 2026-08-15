const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

export const KNOWN_STATUS_IDS = new Set([
  "usage",
  "cache-timer",
  "mcp",
  "subagents",
  "plan-mode",
]);

export interface WidthTools {
  visibleWidth(text: string): number;
  truncateToWidth(text: string, width: number, ellipsis?: string): string;
}

export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total?: number };
}

export interface SessionEntryLike {
  type: string;
  message?: { role?: string; usage?: UsageLike };
  usage?: UsageLike;
}

export interface ContextLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface FooterMetrics {
  quota?: string;
  cacheTimer?: string;
  cacheHitPercent?: number;
  context?: ContextLike;
  cost: number;
}

export interface KnownStatuses {
  usage?: string;
  cacheTimer?: string;
  mcp?: string;
  agents?: string;
  plan?: string;
  mcpError: boolean;
  agentsActive: boolean;
  planActive: boolean;
}

export interface ClassifiedStatuses {
  known: ReadonlyMap<string, string>;
  unknown: string[];
}

export type FooterRole =
  | "project"
  | "model"
  | "mcp"
  | "mcp-error"
  | "agents"
  | "plan"
  | "quota"
  | "warning"
  | "error"
  | "cache"
  | "context"
  | "cost"
  | "separator";

export interface FooterConfig {
  showUnknownStatuses: boolean;
}

export interface FooterLayoutInput {
  project?: string;
  branch?: string | null;
  inGit: boolean;
  inTmux: boolean;
  model?: string;
  thinking?: string;
  statuses: KnownStatuses;
  metrics: FooterMetrics;
  unknown: string[];
  showUnknownStatuses?: boolean;
  style?: (text: string, role: FooterRole) => string;
}

export function parseFooterConfig(value: unknown): FooterConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { showUnknownStatuses: false };
  }
  return {
    showUnknownStatuses:
      (value as { showUnknownStatuses?: unknown }).showUnknownStatuses === true,
  };
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function sanitizeStatus(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(CONTROL_PATTERN, "")
    .replace(/ +/g, " ")
    .trim();
}

function plainStatus(text: string): string {
  return stripAnsi(sanitizeStatus(text));
}

export function classifyStatuses(statuses: ReadonlyMap<string, string>): ClassifiedStatuses {
  const known = new Map<string, string>();
  const unknown: string[] = [];
  for (const [id, text] of statuses) {
    if (KNOWN_STATUS_IDS.has(id)) known.set(id, text);
    else {
      const clean = sanitizeStatus(text);
      if (clean) unknown.push(clean);
    }
  }
  return { known, unknown };
}

export function normalizeUsage(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const clean = plainStatus(text);
  const match = clean.match(/(?:^|\s)([^\s:]+):\s*(\d+(?:\.\d+)?)%\s*(?:left)?(?:\s*\(?↺\s*(?:in\s*)?([^\s)]+)\)?)?/i);
  if (!match) return clean || undefined;
  return `${match[1]}:${match[2]}%${match[3] ? ` ↺${match[3]}` : ""}`;
}

export function normalizeCacheTimer(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const clean = plainStatus(text).replace(/^cache\s*:?[ ]*/i, "");
  if (/^expired$/i.test(clean)) return "expired";
  const match = clean.match(/\b\d+:\d{2}\b/);
  return match?.[0] ?? (clean || undefined);
}

export function normalizeMcp(text: string | undefined): { text?: string; error: boolean } {
  if (!text) return { error: false };
  const clean = plainStatus(text);
  const error = /error|failed|needs.auth|unavailable|disconnected/i.test(clean);
  const ratio = clean.match(/(\d+)\s*\/\s*(\d+)/);
  if (ratio && !error) return { text: `MCP:${ratio[1]}/${ratio[2]}`, error: false };
  return { text: clean.replace(/^🔌\s*/, "").replace(/^MCP\s*:?\s*/i, "MCP:"), error };
}

export function normalizeAgents(text: string | undefined): {
  text?: string;
  active: boolean;
} {
  if (!text) return { active: false };
  const clean = plainStatus(text);
  const running = Number(clean.match(/(\d+)\s+running\s+agents?/i)?.[1] ?? 0);
  const queued = Number(clean.match(/(\d+)\s+queued/i)?.[1] ?? 0);
  if (running || queued) {
    return {
      text: `agents:${running}${queued ? `+${queued}q` : ""}`,
      active: true,
    };
  }
  return { text: clean || undefined, active: Boolean(clean) };
}

export function normalizePlan(text: string | undefined): {
  text?: string;
  active: boolean;
} {
  if (!text) return { active: false };
  const clean = plainStatus(text);
  if (/plan/i.test(clean) && /⏸/.test(clean)) return { text: "⏸ plan", active: true };
  return { text: clean || undefined, active: Boolean(clean) };
}

export function normalizeKnownStatuses(known: ReadonlyMap<string, string>): KnownStatuses {
  const mcp = normalizeMcp(known.get("mcp"));
  const agents = normalizeAgents(known.get("subagents"));
  const plan = normalizePlan(known.get("plan-mode"));
  return {
    usage: normalizeUsage(known.get("usage")),
    cacheTimer: normalizeCacheTimer(known.get("cache-timer")),
    mcp: mcp.text,
    agents: agents.text,
    plan: plan.text,
    mcpError: mcp.error,
    agentsActive: agents.active,
    planActive: plan.active,
  };
}

export function projectName(gitTopLevel: string | undefined, cwd: string): string {
  const path = gitTopLevel?.trim() || cwd;
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || path;
}

export function projectLabel(options: {
  project?: string;
  branch?: string | null;
  inGit: boolean;
  inTmux: boolean;
}): string | undefined {
  const { project, branch, inGit, inTmux } = options;
  if (inTmux) return inGit ? `git:${branch || "detached"}` : undefined;
  if (inGit) return `${project || "git"}:${branch || "detached"}`;
  return project;
}

export function subscribeToBranchChanges(
  footerData: { onBranchChange(callback: () => void): () => void },
  requestRender: () => void,
): () => void {
  return footerData.onBranchChange(requestRender);
}

function validUsage(value: unknown): value is UsageLike {
  if (!value || typeof value !== "object") return false;
  const usage = value as UsageLike;
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(
    (count) => typeof count === "number" && Number.isFinite(count),
  );
}

export function calculateSessionStats(entries: readonly SessionEntryLike[]): {
  cost: number;
  cacheHitPercent?: number;
} {
  let cost = 0;
  let cacheHitPercent: number | undefined;
  for (const entry of entries) {
    let usage: UsageLike | undefined;
    if (entry.type === "message" && validUsage(entry.message?.usage)) {
      usage = entry.message.usage;
      if (entry.message?.role === "assistant") {
        const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
        cacheHitPercent = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
      }
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && validUsage(entry.usage)) {
      usage = entry.usage;
    }
    const total = usage?.cost?.total;
    if (typeof total === "number" && Number.isFinite(total)) cost += total;
  }
  return { cost, ...(cacheHitPercent === undefined ? {} : { cacheHitPercent }) };
}

export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function compactModel(model: string): string {
  const clean = model.replace(/^(?:gpt|claude|gemini|composer|grok|kimi)-/i, "");
  const version = clean.match(/\d+(?:[.-]\d+)+/)?.[0]?.replaceAll("-", ".");
  return version ?? clean.slice(0, 6);
}

function thinkingInitial(thinking: string | undefined): string | undefined {
  if (!thinking || thinking === "off") return undefined;
  return thinking[0];
}

interface VariantState {
  percentDigits: number;
  costDigits: number;
  agentStyle: 0 | 1 | 2;
  mcpCompact: boolean;
  planCompact: boolean;
  thinkingCompact: boolean;
  cacheStyle: 0 | 1 | 2;
  contextStyle: 0 | 1 | 2;
  branchOnly: boolean;
  modelCompact: boolean;
  hideHealthyMcp: boolean;
  hideCacheTimer: boolean;
  hideCost: boolean;
}

function formatPercent(value: number, digits: number): string {
  const formatted = value.toFixed(digits).replace(/\.0$/, "");
  return `${formatted}%`;
}

function formatAgent(text: string, style: VariantState["agentStyle"]): string {
  if (style === 0) return text;
  const value = text.replace(/^agents:/, "");
  return style === 1 ? `A:${value}` : `A${value}`;
}

interface FooterPart {
  text: string;
  role: FooterRole;
}

function roleForPercent(value: number | null | undefined): FooterRole {
  if (value === null || value === undefined) return "context";
  if (value > 90) return "error";
  if (value > 70) return "warning";
  return "context";
}

function roleForQuota(text: string): FooterRole {
  const percent = Number.parseFloat(text.match(/(\d+(?:\.\d+)?)%/)?.[1] ?? "100");
  if (percent <= 10) return "error";
  if (percent <= 25) return "warning";
  return "quota";
}

function renderParts(
  parts: FooterPart[],
  separator: string,
  input: FooterLayoutInput,
): string {
  const style = input.style ?? ((text: string) => text);
  return parts.map(({ text, role }) => style(text, role)).join(style(separator, "separator"));
}

function buildBlocks(input: FooterLayoutInput, state: VariantState): { left: string; right: string } {
  const left: FooterPart[] = [];
  let label = projectLabel(input);
  if (state.branchOnly && input.inGit) label = input.branch || "detached";
  if (label) left.push({ text: label, role: "project" });

  const initial = thinkingInitial(input.thinking);
  if (input.model) {
    let text = input.model;
    if (state.modelCompact) {
      text = `${compactModel(input.model)}${initial ? `/${initial}` : ""}`;
    } else if (input.thinking && input.thinking !== "off") {
      text = `${input.model} • ${state.thinkingCompact ? initial : input.thinking}`;
    }
    left.push({ text, role: "model" });
  }

  const statuses = input.statuses;
  if (statuses.mcp && !(state.hideHealthyMcp && !statuses.mcpError)) {
    left.push({
      text: state.mcpCompact && !statuses.mcpError
        ? statuses.mcp.replace(/^MCP:/, "M:")
        : statuses.mcp,
      role: statuses.mcpError ? "mcp-error" : "mcp",
    });
  }
  if (statuses.agents) {
    left.push({ text: formatAgent(statuses.agents, state.agentStyle), role: "agents" });
  }
  if (statuses.plan) {
    left.push({
      text: state.planCompact && statuses.plan === "⏸ plan" ? "⏸" : statuses.plan,
      role: "plan",
    });
  }

  const right: FooterPart[] = [];
  if (input.metrics.quota) {
    const text = input.metrics.quota.replace(/(\d+(?:\.\d+)?)%/, (value) =>
      formatPercent(Number.parseFloat(value), state.percentDigits),
    );
    right.push({ text, role: roleForQuota(text) });
  }

  const timer = input.metrics.cacheTimer;
  const hit = input.metrics.cacheHitPercent;
  if (!state.hideCacheTimer && (timer || hit !== undefined)) {
    let text: string | undefined;
    if (state.cacheStyle === 0) {
      const hitText = hit === undefined ? "" : formatPercent(hit, state.percentDigits);
      text = `cache:${hitText}${timer ? `${hitText ? " " : ""}↺${timer}` : ""}`;
    } else if (state.cacheStyle === 1) {
      text = `C:${hit === undefined ? "" : formatPercent(hit, 0)}${timer ? `/${timer}` : ""}`;
    } else if (timer) {
      text = `↺${timer}`;
    }
    if (text) right.push({ text, role: timer === "expired" ? "error" : "cache" });
  }

  const context = input.metrics.context;
  if (context) {
    const percent = context.percent === null ? "?" : formatPercent(context.percent, state.percentDigits);
    let text = percent;
    if (state.contextStyle === 0) text = `ctx:${percent}/${formatTokens(context.contextWindow)}`;
    else if (state.contextStyle === 1) text = `ctx:${percent}`;
    right.push({ text, role: roleForPercent(context.percent) });
  }
  if (!state.hideCost && input.metrics.cost > 0) {
    right.push({ text: `$${input.metrics.cost.toFixed(state.costDigits)}`, role: "cost" });
  }
  return {
    left: renderParts(left, "  ", input),
    right: renderParts(right, " • ", input),
  };
}

function fitLine(left: string, right: string, width: number, tools: WidthTools): string | undefined {
  const leftWidth = tools.visibleWidth(left);
  const rightWidth = tools.visibleWidth(right);
  if (!left) return rightWidth <= width ? `${" ".repeat(width - rightWidth)}${right}` : undefined;
  if (!right) return leftWidth <= width ? left : undefined;
  if (leftWidth + 1 + rightWidth > width) return undefined;
  return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
}

function priorityFallback(input: FooterLayoutInput): string {
  const parts: FooterPart[] = [];
  if (input.statuses.planActive && input.statuses.plan) {
    parts.push({ text: input.statuses.plan, role: "plan" });
  }
  if (input.statuses.agentsActive && input.statuses.agents) {
    parts.push({ text: input.statuses.agents, role: "agents" });
  }
  if (input.statuses.mcpError && input.statuses.mcp) {
    parts.push({ text: input.statuses.mcp, role: "mcp-error" });
  }
  if (input.metrics.quota && /(?:^|:)\s*(?:[0-1]?\d(?:\.\d+)?)%/.test(input.metrics.quota)) {
    parts.push({ text: input.metrics.quota, role: roleForQuota(input.metrics.quota) });
  }
  if (input.metrics.context && (input.metrics.context.percent ?? 0) >= 80) {
    parts.push({
      text: `ctx:${formatPercent(input.metrics.context.percent!, 0)}`,
      role: roleForPercent(input.metrics.context.percent),
    });
  }
  return renderParts(parts, "  ", input);
}

export function renderFooter(
  input: FooterLayoutInput,
  width: number,
  tools: WidthTools,
): string[] {
  if (width <= 0) return [];
  const state: VariantState = {
    percentDigits: 1,
    costDigits: 3,
    agentStyle: 0,
    mcpCompact: false,
    planCompact: false,
    thinkingCompact: false,
    cacheStyle: 0,
    contextStyle: 0,
    branchOnly: false,
    modelCompact: false,
    hideHealthyMcp: false,
    hideCacheTimer: false,
    hideCost: false,
  };

  const attempts: Array<() => void> = [
    () => {},
    () => { state.percentDigits = 0; state.costDigits = 2; },
    () => { state.agentStyle = 1; },
    () => { state.agentStyle = 2; },
    () => { state.mcpCompact = true; },
    () => { state.planCompact = true; },
    () => { state.thinkingCompact = true; },
    () => { state.cacheStyle = 1; },
    () => { state.cacheStyle = 2; },
    () => { state.contextStyle = 1; },
    () => { state.contextStyle = 2; },
    () => { state.branchOnly = true; },
    () => { state.modelCompact = true; },
    () => { state.hideHealthyMcp = true; },
    () => { state.hideCacheTimer = true; },
    () => { state.hideCost = true; },
  ];

  let first = "";
  for (const apply of attempts) {
    apply();
    const blocks = buildBlocks(input, state);
    const fitted = fitLine(blocks.left, blocks.right, width, tools);
    if (fitted !== undefined) {
      first = fitted;
      break;
    }
    first = `${blocks.left}${blocks.left && blocks.right ? " " : ""}${blocks.right}`;
  }
  if (tools.visibleWidth(first) > width) {
    const priority = priorityFallback(input);
    first = tools.truncateToWidth(priority || first, width, "");
  }

  const lines = [tools.truncateToWidth(first, width, "")];
  const unknown = input.showUnknownStatuses
    ? input.unknown.filter(Boolean).join("  ")
    : "";
  if (unknown) lines.push(tools.truncateToWidth(unknown, width, ""));
  return lines;
}
