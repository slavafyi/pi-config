import { randomUUID } from "node:crypto";

import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const REQUEST_EVENT = "prompt-template:subagent:request";
const UPDATE_EVENT = "prompt-template:subagent:update";
const RESPONSE_EVENT = "prompt-template:subagent:response";
const CANCEL_EVENT = "prompt-template:subagent:cancel";
const STATUS_KEY = "subagents-once";
const HIDDEN_TOOLS = new Set(["subagent", "subagent_wait", "oracle", "reviewer"]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const GATE_PROMPT = `
--- SUBAGENTS ONCE ---
Delegation is optional. Evaluate all three gates silently before calling oracle or reviewer. If any gate fails, continue locally without announcing the gate decision.
{{CONTEXT_USAGE}}
Gate 1 — Necessity: delegate only when the work cannot be handled reliably in the parent's current context or requires a genuinely isolated, context-heavy investigation.
Gate 2 — Independent value: the child must provide a distinct challenge or review function, not repeat the parent's work or supply reassurance by vote.
Gate 3 — Handoff readiness: give the child a narrow task with relevant evidence, files or artifacts, preserved constraints, expected output, and an explicit advisory/non-writing boundary.

Use oracle before implementation to challenge direction, assumptions, contradictions, or decision drift. Use reviewer after a concrete artifact exists to inspect it independently. Honor an explicit role requested by the user; otherwise choose either role or neither. At most one child call total is allowed in this parent run.

The child is advisory. The parent remains the only writer, final decision-maker, and integrator. Leave model and thinking unset unless the user requested an override or a specific override is justified.
--- END SUBAGENTS ONCE ---`;

export type Role = "oracle" | "reviewer";
export type OnceState = { armed: boolean; callUsed: boolean };
type Thinking = (typeof THINKING_LEVELS)[number];

type DelegationIdentity = {
  version: 2;
  requestId: string;
  ownerRunId: string;
  nodeId: string;
};

type DelegationRequest = DelegationIdentity & {
  agent: Role;
  task: string;
  context: "fork" | "fresh";
  cwd: string;
  model?: string;
  thinking?: Thinking;
  result: { kind: "text" };
};

type DelegationUpdate = DelegationIdentity & {
  runId?: string;
  currentTool?: string;
  recentOutput?: string;
  model?: string;
  toolCount?: number;
  durationMs?: number;
};

type DelegationUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
};

type DelegationResponse = DelegationIdentity & {
  status: string;
  error?: string;
  runId?: string;
  agent?: string;
  model?: string;
  thinking?: string;
  result?: { kind: "text"; text: string } | { kind: "structured"; value: unknown };
  usage?: DelegationUsage;
};

type DelegationDetails = {
  role: Role;
  status?: string;
  runId?: string;
  model?: string;
  thinking?: string;
  turns?: number;
  toolCalls?: number;
  durationMs?: number;
  currentTool?: string;
};

const TOOL_PARAMETERS = Type.Object({
  task: Type.String({
    description: "Narrow advisory task, evidence, constraints, and expected output",
  }),
  model: Type.Optional(Type.String({ description: "Exact provider/model-id override" })),
  thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
});

export function resetState(state: OnceState): void {
  state.armed = false;
  state.callUsed = false;
}

export function consumeCall(state: OnceState): string | undefined {
  if (!state.armed) return "Subagents are not armed. Run /subagents-once first.";
  if (state.callUsed) return "Only one oracle or reviewer call is allowed per armed parent run.";
  state.callUsed = true;
  return undefined;
}

export function validateModelOverride(
  model: string | undefined,
  find: (provider: string, modelId: string) => unknown,
): string | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (model !== model.trim() || slash <= 0 || slash === model.length - 1) {
    throw new Error(`Model override must use the exact provider/model-id form: ${model}`);
  }
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  if (!find(provider, modelId)) throw new Error(`Unknown model override: ${model}`);
  return model;
}

export function buildGatePrompt(contextUsage?: {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}): string {
  const usage = contextUsage
    ? `Parent context usage: ${contextUsage.tokens === null ? "unknown" : contextUsage.tokens.toLocaleString("en-US")}/${contextUsage.contextWindow.toLocaleString("en-US")} tokens (${contextUsage.percent === null ? "unknown" : `${contextUsage.percent.toFixed(1)}%`}).\n`
    : "";
  return GATE_PROMPT.replace("{{CONTEXT_USAGE}}\n", usage);
}

function matchesIdentity(
  value: unknown,
  identity: DelegationIdentity,
): value is DelegationUpdate | DelegationResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<DelegationIdentity>;
  return (
    candidate.version === identity.version &&
    candidate.requestId === identity.requestId &&
    candidate.ownerRunId === identity.ownerRunId &&
    candidate.nodeId === identity.nodeId
  );
}

function toUsage(usage: DelegationUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage.cost,
    },
  };
}

function compactProgress(role: Role, update: DelegationUpdate): string {
  const parts = [`${role} running`];
  if (update.currentTool) parts.push(`tool: ${update.currentTool}`);
  if (update.recentOutput)
    parts.push(update.recentOutput.replace(/\s+/g, " ").trim().slice(0, 300));
  return parts.join(" · ");
}

async function delegate(
  pi: ExtensionAPI,
  role: Role,
  context: "fork" | "fresh",
  toolCallId: string,
  params: { task: string; model?: string; thinking?: Thinking },
  signal: AbortSignal | undefined,
  onUpdate:
    | ((result: {
        content: Array<{ type: "text"; text: string }>;
        details: DelegationDetails;
      }) => void)
    | undefined,
  ctx: ExtensionContext,
) {
  if (!params.task.trim()) throw new Error(`${role} task must contain non-whitespace text.`);
  const model = validateModelOverride(params.model, (provider, modelId) =>
    ctx.modelRegistry.find(provider, modelId),
  );
  const identity: DelegationIdentity = {
    version: 2,
    requestId: randomUUID(),
    ownerRunId: ctx.sessionManager.getSessionId(),
    nodeId: toolCallId,
  };
  const request: DelegationRequest = {
    ...identity,
    agent: role,
    task: params.task,
    context,
    cwd: ctx.cwd,
    ...(model ? { model } : {}),
    ...(params.thinking ? { thinking: params.thinking } : {}),
    result: { kind: "text" },
  };

  let resolveResponse!: (response: DelegationResponse) => void;
  const responsePromise = new Promise<DelegationResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const unsubscribeUpdate = pi.events.on(UPDATE_EVENT, (value) => {
    if (!matchesIdentity(value, identity)) return;
    const update = value as DelegationUpdate;
    onUpdate?.({
      content: [{ type: "text", text: compactProgress(role, update) }],
      details: {
        role,
        runId: update.runId,
        model: update.model,
        toolCalls: update.toolCount,
        durationMs: update.durationMs,
        currentTool: update.currentTool,
      },
    });
  });
  const unsubscribeResponse = pi.events.on(RESPONSE_EVENT, (value) => {
    if (matchesIdentity(value, identity)) resolveResponse(value as DelegationResponse);
  });
  let cancellationSent = false;
  const cancel = () => {
    if (cancellationSent) return;
    cancellationSent = true;
    pi.events.emit(CANCEL_EVENT, identity);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  ctx.ui.setStatus(STATUS_KEY, role === "oracle" ? "◎ oracle" : "◇ reviewer");

  try {
    if (signal?.aborted) cancel();
    pi.events.emit(REQUEST_EVENT, request);
    const response = await responsePromise;
    if (response.status !== "completed") {
      throw new Error(
        response.error ?? `${role} delegation ${response.status.replaceAll("_", " ")}.`,
      );
    }
    const text =
      response.result?.kind === "text" && response.result.text
        ? response.result.text
        : `${role === "oracle" ? "Oracle" : "Reviewer"} returned no text`;
    return {
      content: [{ type: "text" as const, text }],
      details: {
        role,
        status: response.status,
        runId: response.runId,
        model: response.model,
        thinking: response.thinking,
        turns: response.usage?.turns,
        toolCalls: response.usage?.toolCalls,
        durationMs: response.usage?.durationMs,
      } satisfies DelegationDetails,
      usage: toUsage(response.usage),
    };
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    unsubscribeUpdate();
    unsubscribeResponse();
    signal?.removeEventListener("abort", cancel);
  }
}

export function demo(): void {
  const known = (provider: string, modelId: string) =>
    provider === "openai-codex" && modelId === "gpt-5.6-sol";
  if (validateModelOverride("openai-codex/gpt-5.6-sol", known) !== "openai-codex/gpt-5.6-sol")
    throw new Error("model validation failed");
  for (const model of ["gpt-5.6-sol", "openai-codex/", "openai-codex/missing"]) {
    let rejected = false;
    try {
      validateModelOverride(model, known);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`model validation accepted ${model}`);
  }
  const state: OnceState = { armed: true, callUsed: false };
  if (consumeCall(state) !== undefined || !consumeCall(state))
    throw new Error("one-call policy failed");
  resetState(state);
  if (state.armed || state.callUsed || !consumeCall(state)) throw new Error("state reset failed");
  for (const text of ["Gate 1", "Gate 2", "Gate 3", "oracle", "reviewer"]) {
    if (!GATE_PROMPT.includes(text)) throw new Error(`gate prompt is missing ${text}`);
  }
}

if (process.env.PI_SUBAGENTS_ONCE_SELF_TEST === "1") demo();

export default function subagentsOnce(pi: ExtensionAPI) {
  const state: OnceState = { armed: false, callUsed: false };
  let backendAvailable = false;

  const hideDelegationTools = () => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => !HIDDEN_TOOLS.has(name)));
  };
  const reset = (ctx: ExtensionContext) => {
    resetState(state);
    hideDelegationTools();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  pi.registerTool({
    name: "oracle",
    label: "Oracle",
    description:
      "Ask the configured oracle for one advisory second opinion before implementation. The parent remains the only writer.",
    parameters: TOOL_PARAMETERS,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      delegate(pi, "oracle", "fork", toolCallId, params, signal, onUpdate, ctx),
    renderCall(args, theme, context) {
      const task = context.expanded
        ? args.task
        : args.task.replace(/\s+/g, " ").trim().slice(0, 100);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("oracle"))} ${theme.fg("muted", task)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "reviewer",
    label: "Reviewer",
    description:
      "Ask the configured reviewer to inspect a concrete artifact independently. The parent remains the only writer.",
    parameters: TOOL_PARAMETERS,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      delegate(pi, "reviewer", "fresh", toolCallId, params, signal, onUpdate, ctx),
    renderCall(args, theme, context) {
      const task = context.expanded
        ? args.task
        : args.task.replace(/\s+/g, " ").trim().slice(0, 100);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("reviewer"))} ${theme.fg("muted", task)}`,
        0,
        0,
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    backendAvailable = pi.getAllTools().some((tool) => tool.name === "subagent");
    reset(ctx);
  });

  pi.registerCommand("subagents-once", {
    description: "Allow one oracle or reviewer call in the next parent run",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /subagents-once", "warning");
        return;
      }
      if (state.armed) {
        ctx.ui.notify("Oracle and reviewer are already armed for the next parent run.", "info");
        return;
      }
      backendAvailable = pi.getAllTools().some((tool) => tool.name === "subagent");
      if (!backendAvailable) {
        ctx.ui.notify("Cannot arm subagents: the pi-subagents backend is not loaded.", "error");
        return;
      }
      state.armed = true;
      state.callUsed = false;
      pi.setActiveTools([...new Set([...pi.getActiveTools(), "oracle", "reviewer"])]);
      ctx.ui.notify("Oracle and reviewer are available until the next parent run settles.", "info");
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!state.armed) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${buildGatePrompt(ctx.getContextUsage())}` };
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "oracle" && event.toolName !== "reviewer") return;
    const reason = consumeCall(state);
    return reason ? { block: true, reason } : undefined;
  });

  pi.on("agent_settled", (_event, ctx) => reset(ctx));
}
