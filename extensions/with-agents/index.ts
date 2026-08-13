import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  arm,
  completeBackgroundAgent,
  consumeBackgroundNotification,
  consumeBackgroundResult,
  createState,
  formatContextUsage,
  noteBackgroundAgent,
  noteUserPrompt,
  reset,
  settleParentRun,
  startParentRun,
} from "./policy.ts";

export const ORCHESTRATION_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];
const ORCHESTRATION_TOOL_SET = new Set(ORCHESTRATION_TOOLS);

export const ACTIVE_MARKER = "WITH AGENTS ENABLED FOR THIS PARENT RUN";
export const AGENT_GUARD_PROMPT = `Subagent orchestration tools are authorized only when the latest extension-generated "${ACTIVE_MARKER}" control message belongs to the current parent run. Historical control messages from earlier runs do not authorize orchestration. Without current authorization, work locally and do not call Agent, get_subagent_result, or steer_subagent.`;

export const VALIDATOR_PROMPT = `
--- WITH AGENTS ---
Delegation is optional. Evaluate all three gates silently before every Agent call. If any gate fails, continue locally without announcing the gate decision.
Gate 1 — Necessity and context economy: delegate only when the parent cannot reliably finish the remaining work within its current context budget without filling the main context with a large or noisy investigation, or when isolated independent execution or review is itself required. Use the latest extension-generated parent-context snapshot. Do not use a fixed percentage threshold.

Gate 2 — Independent value: the agent must provide a distinct investigation, challenge, implementation, or review, not duplicate the parent's work or supply reassurance by vote. Parallel sibling calls must be independent and non-overlapping.

Gate 3 — Handoff readiness: give the agent a narrow, self-contained task with relevant evidence, files or artifacts, preserved constraints, and an explicit expected output. Use reviewer only after a concrete artifact exists.

Available roles:
- general: autonomous worker for a narrow, self-contained task.
- oracle: independent second opinion that challenges direction or assumptions.
- reviewer: independent review of a finished artifact; it may use bash to run tests.

Zero, one, or several Agent calls are allowed after the gates pass. Prefer background agents for parallel fan-out; the backend queues at most four background agents concurrently and uses smart join.

Choose model, thinking, run_in_background, inherit_context, and isolation per call. Use isolation: "worktree" only when that call needs filesystem isolation. Scheduling and nested delegation are disabled.

Agent resume works only for an agent ID still held by the current pi-subagents manager. Use get_subagent_result and steer_subagent only for such known agents. Persisted session files are not automatically rediscovered after manager cleanup or a Pi restart.

The parent owns integration and must verify agent-produced changes before reporting completion.
--- END WITH AGENTS ---`;

export default function subagentsOnce(pi: ExtensionAPI) {
  const state = createState();

  pi.on("session_start", () => reset(state));

  pi.registerCommand("with-agents", {
    description: "Enable subagent orchestration for the next user prompt",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /with-agents", "warning");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for the current parent run to finish, then run /with-agents again.",
          "warning",
        );
        return;
      }

      const missing = ORCHESTRATION_TOOLS.filter(
        (name) => !pi.getAllTools().some((tool) => tool.name === name),
      );
      if (missing.length) {
        ctx.ui.notify(`Cannot enable agents: missing ${missing.join(", ")}.`, "error");
        return;
      }
      const inactive = ORCHESTRATION_TOOLS.filter((name) => !pi.getActiveTools().includes(name));
      if (inactive.length) {
        ctx.ui.notify(
          `Cannot enable agents: inactive ${inactive.join(", ")}. Enable them with /tools first.`,
          "error",
        );
        return;
      }
      if (!arm(state)) {
        ctx.ui.notify("Agents are already enabled or active.", "info");
        return;
      }

      ctx.ui.notify("Agents enabled for the next prompt.", "info");
    },
  });

  pi.on("input", (event) => {
    noteUserPrompt(state, event.source);
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "Agent") {
      const details = event.details as { status?: string; agentId?: string } | undefined;
      if (details?.status === "background" && details.agentId) {
        noteBackgroundAgent(state, details.agentId);
      }
    } else if (event.toolName === "get_subagent_result") {
      const input = event.input as { agent_id?: string };
      if (input.agent_id) consumeBackgroundResult(state, input.agent_id);
    }
  });

  for (const eventName of ["subagents:completed", "subagents:failed"]) {
    pi.events.on(eventName, (data) => {
      const id = (data as { id?: string }).id;
      if (id) completeBackgroundAgent(state, id);
    });
  }

  pi.on("message_start", (event) => {
    if (event.message.role !== "custom" || event.message.customType !== "subagent-notification") {
      return;
    }
    const details = event.message.details as
      | { id?: string; others?: Array<{ id?: string }> }
      | undefined;
    const ids = [details?.id, ...(details?.others?.map(({ id }) => id) ?? [])].filter(
      (id): id is string => Boolean(id),
    );
    consumeBackgroundNotification(state, ids);
  });

  pi.on("before_agent_start", (event) => {
    const activated = startParentRun(state);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${AGENT_GUARD_PROMPT}`,
      message: activated
        ? {
            customType: "with-agents-policy",
            content: `${ACTIVE_MARKER}\n\n${VALIDATOR_PROMPT}`,
            display: false,
          }
        : undefined,
    };
  });

  pi.on("context", (event, ctx) => {
    if (state.phase !== "active") return;
    const usage = formatContextUsage(ctx.getContextUsage());
    if (!usage) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: "with-agents-context-usage",
          content: usage,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("tool_call", (event) => {
    if (ORCHESTRATION_TOOL_SET.has(event.toolName) && state.phase !== "active") {
      return { block: true, reason: "Run /with-agents before using subagent tools." };
    }
  });

  pi.on("agent_settled", () => {
    settleParentRun(state);
  });
}
