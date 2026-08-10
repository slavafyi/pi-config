import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  arm,
  createState,
  noteUserPrompt,
  reset,
  settleParentRun,
  startParentRun,
} from "./policy.js";

const ORCHESTRATION_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];
const ORCHESTRATION_TOOL_SET = new Set(ORCHESTRATION_TOOLS);

export const VALIDATOR_PROMPT = `
--- SUBAGENTS ONCE ---
Delegation is optional. Do not call Agent for work the parent can complete reliably within one context window.

Available roles:
- general: autonomous worker for a narrow, self-contained task.
- oracle: independent second opinion that challenges direction or assumptions.
- reviewer: independent review of a finished artifact; it may use bash to run tests.

Give every agent a self-contained prompt with relevant evidence, constraints, file paths, and expected output. Zero, one, or several Agent calls are allowed. Parallel sibling calls must be independent; do not delegate duplicate work or repeat a delegated investigation in the parent. Prefer background agents for parallel fan-out; the backend queues at most four background agents concurrently and uses smart join.

Choose model, thinking, run_in_background, inherit_context, and isolation per call. Use isolation: "worktree" only when that call needs filesystem isolation. Scheduling and nested delegation are disabled.

Agent resume works only for an agent ID still held by the current pi-subagents manager. Use get_subagent_result and steer_subagent only for such known agents. Persisted session files are not automatically rediscovered after manager cleanup or a Pi restart.

The parent owns integration and must verify agent-produced changes before reporting completion.
--- END SUBAGENTS ONCE ---`;

export default function subagentsOnce(pi: ExtensionAPI) {
  const state = createState();

  const hideTools = () => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => !ORCHESTRATION_TOOL_SET.has(name)));
  };
  const showTools = () => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ORCHESTRATION_TOOLS])]);
  };

  pi.on("session_start", () => {
    reset(state);
    hideTools();
  });

  pi.registerCommand("subagents-once", {
    description: "Enable subagent orchestration for the next user prompt",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /subagents-once", "warning");
        return;
      }

      const missing = ORCHESTRATION_TOOLS.filter(
        (name) => !pi.getAllTools().some((tool) => tool.name === name),
      );
      if (missing.length) {
        ctx.ui.notify(`Cannot arm subagents: missing ${missing.join(", ")}.`, "error");
        return;
      }
      if (!arm(state)) {
        ctx.ui.notify("Subagents are already armed or active.", "info");
        return;
      }

      ctx.ui.notify("Subagents armed for the next prompt.", "info");
    },
  });

  pi.on("input", (event) => {
    if (noteUserPrompt(state, event.source)) showTools();
  });

  pi.on("before_agent_start", (event) => {
    if (!startParentRun(state)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${VALIDATOR_PROMPT}` };
  });

  pi.on("tool_call", (event) => {
    if (ORCHESTRATION_TOOL_SET.has(event.toolName) && state.phase !== "active") {
      return { block: true, reason: "Run /subagents-once before using subagent tools." };
    }
  });

  pi.on("agent_settled", () => {
    if (settleParentRun(state)) hideTools();
  });
}
