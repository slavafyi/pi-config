const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

export const KNOWN_STATUS_IDS = new Set([
  "usage",
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
  quotaStyled?: string;
  cacheHitPercent?: number;
  context?: ContextLike;
  cost: number;
}

export interface KnownStatuses {
  usage?: string;
  usageStyled?: string;
  mcp?: string;
  agents?: string;
  agentsRunning?: number;
  agentsQueued?: number;
  plan?: string;
  planStyled?: string;
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
  | "agent-running"
  | "agent-queued"
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

interface StyledLayout {
  style?: (text: string, role: FooterRole) => string;
}

export interface FooterLayoutInput extends StyledLayout {
  statuses: KnownStatuses;
  metrics: FooterMetrics;
  unknown: string[];
  showUnknownStatuses?: boolean;
}

export interface EditorBorderInput extends StyledLayout {
  project?: string;
  branch?: string | null;
  inGit: boolean;
  inTmux: boolean;
  model?: string;
  thinking?: string;
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
  const matches = clean.matchAll(/(?:^|\s)([^\s:]+):\s*(\d+(?:\.\d+)?)%\s*(?:left)?(?:\s*\(?↺\s*(?:in\s*)?([^\s)]+)\)?)?/gi);
  const quotas = Array.from(matches, (match) =>
    `${match[1]}:${match[2]}%${match[3] ? ` ↺${match[3]}` : ""}`
  );
  return quotas.length ? quotas.join("  ") : clean || undefined;
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
  running?: number;
  queued?: number;
  active: boolean;
} {
  if (!text) return { active: false };
  const clean = plainStatus(text);
  const runningMatch = clean.match(/(?:^|,\s*)(\d+)\s+running(?:\s+agents?)?(?=,|$)/i);
  const queuedMatch = clean.match(/(?:^|,\s*)(\d+)\s+queued(?:\s+agents?)?(?=,|$)/i);
  if (runningMatch || queuedMatch) {
    const running = Number(runningMatch?.[1] ?? 0);
    const queued = Number(queuedMatch?.[1] ?? 0);
    return {
      text: `agents:${running}${queued ? `+${queued}q` : ""}`,
      running,
      queued,
      active: running > 0 || queued > 0,
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
  if (/plan/i.test(clean) && /⏸/.test(clean)) return { text: "⏸︎ plan", active: true };
  return { text: clean || undefined, active: Boolean(clean) };
}

export function normalizeKnownStatuses(known: ReadonlyMap<string, string>): KnownStatuses {
  const usageRaw = known.get("usage");
  const planRaw = known.get("plan-mode");
  const usage = normalizeUsage(usageRaw);
  const mcp = normalizeMcp(known.get("mcp"));
  const agents = normalizeAgents(known.get("subagents"));
  const plan = normalizePlan(planRaw);
  return {
    usage,
    usageStyled: usage && usageRaw ? sanitizeStatus(usageRaw) : undefined,
    mcp: mcp.text,
    agents: agents.text,
    agentsRunning: agents.running,
    agentsQueued: agents.queued,
    plan: plan.text,
    planStyled: plan.text && planRaw ? sanitizeStatus(planRaw) : undefined,
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
  const ref = !branch || branch === "detached" ? "HEAD" : branch;
  if (inTmux) return inGit ? ref : undefined;
  if (inGit) return project ? `${project}:${ref}` : ref;
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

function modelLabel(
  model: string | undefined,
  thinking: string | undefined,
  compactThinking: boolean,
  compactName: boolean,
): string | undefined {
  if (!model) return undefined;
  const level = compactThinking ? thinkingInitial(thinking) : thinking;
  return `${compactName ? compactModel(model) : model}${level && level !== "off" ? `/${level}` : ""}`;
}

export function renderEditorTopBorder(
  input: EditorBorderInput,
  width: number,
  tools: WidthTools,
  border: (text: string) => string,
): string {
  if (width <= 0) return "";
  if (width === 1) return border("─");

  const fullProject = projectLabel(input);
  const branchOnly = input.inGit
    ? projectLabel({ ...input, project: undefined, inTmux: false })
    : fullProject;
  const candidates = [
    { project: fullProject, model: modelLabel(input.model, input.thinking, false, false) },
    { project: fullProject, model: modelLabel(input.model, input.thinking, true, false) },
    { project: branchOnly, model: modelLabel(input.model, input.thinking, true, false) },
    { project: branchOnly, model: modelLabel(input.model, input.thinking, true, true) },
  ];

  const decorate = (text: string, role: FooterRole): string =>
    input.style ? input.style(text, role) : text;
  const render = (project: string, model: string): string => {
    const gap = Math.max(0, width - 2 - tools.visibleWidth(project) - tools.visibleWidth(model));
    return `${border("─")}${decorate(project, "project")}${border("─".repeat(gap))}${decorate(model, "model")}${border("─")}`;
  };

  for (const candidate of candidates) {
    const project = candidate.project ? ` ${candidate.project} ` : "";
    const model = candidate.model ? ` ${candidate.model} ` : "";
    if (2 + tools.visibleWidth(project) + tools.visibleWidth(model) + 1 <= width) {
      return render(project, model);
    }
  }

  let project = branchOnly ? ` ${branchOnly} ` : "";
  let model = modelLabel(input.model, input.thinking, true, true);
  model = model ? ` ${model} ` : "";
  while (2 + tools.visibleWidth(project) + tools.visibleWidth(model) > width && model) {
    model = tools.truncateToWidth(model, tools.visibleWidth(model) - 1, "");
  }
  while (2 + tools.visibleWidth(project) + tools.visibleWidth(model) > width && project) {
    project = tools.truncateToWidth(project, tools.visibleWidth(project) - 1, "");
  }
  return render(project, model);
}

interface VariantState {
  percentDigits: number;
  costDigits: number;
  agentStyle: 0 | 1 | 2;
  mcpCompact: boolean;
  planCompact: boolean;
  cacheStyle: 0 | 1 | 2;
  contextStyle: 0 | 1 | 2;
  hideHealthyMcp: boolean;
  hideCache: boolean;
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

function renderAgentPart(
  statuses: KnownStatuses,
  style: VariantState["agentStyle"],
  input: FooterLayoutInput,
): FooterPart | undefined {
  if (!statuses.agents) return undefined;
  if (statuses.agentsRunning === undefined || statuses.agentsQueued === undefined) {
    return { text: formatAgent(statuses.agents, style), role: "agents" };
  }

  const prefix = style === 0 ? "agents:" : style === 1 ? "A:" : "A";
  const queued = statuses.agentsQueued > 0
    ? styleText(`+${statuses.agentsQueued}q`, "agent-queued", input)
    : "";
  return {
    text:
      styleText(prefix, "separator", input) +
      styleText(String(statuses.agentsRunning), "agent-running", input) +
      queued,
    role: "agents",
    preserveStyle: true,
  };
}

interface FooterPart {
  text: string;
  role: FooterRole;
  preserveStyle?: boolean;
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

function styleText(text: string, role: FooterRole, input: StyledLayout): string {
  return input.style ? input.style(text, role) : text;
}

function preservesText(styled: string | undefined, plain: string): styled is string {
  return styled !== undefined && stripAnsi(styled) === plain;
}

function renderContextPart(
  context: ContextLike,
  contextStyle: number,
  percentDigits: number,
  input: FooterLayoutInput,
): FooterPart {
  const percent = context.percent === null
    ? "?"
    : formatPercent(context.percent, percentDigits);
  const prefix = contextStyle < 2 ? "ctx:" : "";
  const suffix = contextStyle === 0 ? `/${formatTokens(context.contextWindow)}` : "";
  const styledPrefix = prefix ? styleText(prefix, "context", input) : "";
  const styledSuffix = suffix ? styleText(suffix, "context", input) : "";
  return {
    text: `${styledPrefix}${styleText(
      percent,
      roleForPercent(context.percent),
      input,
    )}${styledSuffix}`,
    role: "context",
    preserveStyle: true,
  };
}

function renderParts(
  parts: FooterPart[],
  separator: string,
  input: FooterLayoutInput,
): string {
  return parts
    .map(({ text, role, preserveStyle }) =>
      preserveStyle ? text : styleText(text, role, input),
    )
    .join(styleText(separator, "separator", input));
}

function buildBlocks(input: FooterLayoutInput, state: VariantState): { left: string; right: string } {
  const left: FooterPart[] = [];
  if (input.metrics.quota) {
    const text = input.metrics.quota.replace(/(\d+(?:\.\d+)?)%/g, (value) =>
      formatPercent(Number.parseFloat(value), state.percentDigits),
    );
    const styled = preservesText(input.metrics.quotaStyled, text)
      ? input.metrics.quotaStyled
      : undefined;
    left.push({
      text: styled ?? text,
      role: roleForQuota(text),
      preserveStyle: styled !== undefined,
    });
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
  const agentPart = renderAgentPart(statuses, state.agentStyle, input);
  if (agentPart) left.push(agentPart);
  if (statuses.plan) {
    const text = state.planCompact && statuses.plan === "⏸︎ plan" ? "⏸︎" : statuses.plan;
    const styled = !state.planCompact && preservesText(statuses.planStyled, text)
      ? statuses.planStyled
      : undefined;
    left.push({
      text: styled ?? text,
      role: "plan",
      preserveStyle: styled !== undefined,
    });
  }

  const right: FooterPart[] = [];
  const hit = input.metrics.cacheHitPercent;
  if (!state.hideCache && hit !== undefined) {
    const hitText = formatPercent(hit, state.cacheStyle === 0 ? state.percentDigits : 0);
    const text = state.cacheStyle === 0
      ? `cache:${hitText}`
      : state.cacheStyle === 1
        ? `C:${hitText}`
        : hitText;
    right.push({ text, role: "cache" });
  }

  const context = input.metrics.context;
  if (context) {
    right.push(renderContextPart(context, state.contextStyle, state.percentDigits, input));
  }
  if (!state.hideCost && input.metrics.cost > 0) {
    right.push({ text: `$${input.metrics.cost.toFixed(state.costDigits)}`, role: "cost" });
  }
  return {
    left: renderParts(left, "  ", input),
    right: renderParts(right, "  ", input),
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
  if (input.statuses.agentsActive) {
    const agentPart = renderAgentPart(input.statuses, 0, input);
    if (agentPart) parts.push(agentPart);
  }
  if (input.statuses.mcpError && input.statuses.mcp) {
    parts.push({ text: input.statuses.mcp, role: "mcp-error" });
  }
  if (input.metrics.quota && /(?:^|:)\s*(?:[0-1]?\d(?:\.\d+)?)%/.test(input.metrics.quota)) {
    const styled = preservesText(input.metrics.quotaStyled, input.metrics.quota)
      ? input.metrics.quotaStyled
      : undefined;
    parts.push({
      text: styled ?? input.metrics.quota,
      role: roleForQuota(input.metrics.quota),
      preserveStyle: styled !== undefined,
    });
  }
  if (input.metrics.context && (input.metrics.context.percent ?? 0) >= 80) {
    parts.push(renderContextPart(input.metrics.context, 1, 0, input));
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
    cacheStyle: 0,
    contextStyle: 0,
    hideHealthyMcp: false,
    hideCache: false,
    hideCost: false,
  };

  const attempts: Array<() => void> = [
    () => {},
    () => { state.percentDigits = 0; state.costDigits = 2; },
    () => { state.agentStyle = 1; },
    () => { state.agentStyle = 2; },
    () => { state.mcpCompact = true; },
    () => { state.planCompact = true; },
    () => { state.cacheStyle = 1; },
    () => { state.cacheStyle = 2; },
    () => { state.contextStyle = 1; },
    () => { state.contextStyle = 2; },
    () => { state.hideHealthyMcp = true; },
    () => { state.hideCache = true; },
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
