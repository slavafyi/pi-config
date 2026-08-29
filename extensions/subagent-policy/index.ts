import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export const SUBAGENT_POLICY_PROMPT = `
--- SUBAGENT POLICY ---
Delegation is optional. Evaluate all three gates silently before every Agent call. Calling Agent certifies that all three gates passed. If any gate fails, continue locally without announcing the decision.

Gate 1 — Necessity and context economy: delegate only when the parent cannot reliably finish the remaining work within its current context budget without filling the main context with a large or noisy investigation, or when isolated independent execution or review is itself required. Use the latest extension-generated parent-context snapshot. Do not use a fixed percentage threshold.

Gate 2 — Independent value: the agent must provide a distinct investigation, challenge, implementation, or review, not duplicate the parent's work or supply reassurance by vote. Parallel sibling calls must be independent and non-overlapping. Never repeat work assigned to an agent in the parent.

Gate 3 — Handoff readiness: give the agent a narrow, self-contained task with relevant evidence, files or artifacts, preserved constraints, and an explicit expected output. Use reviewer only after a concrete finished artifact exists.

Available roles:
- general: autonomous worker for a narrow, self-contained task.
- oracle: independent second opinion that challenges direction or assumptions.
- reviewer: independent review of a finished artifact; it may use bash to run tests.

Use foreground agents when their result is required for the current deliverable or the parent's next decision. Multiple independent foreground Agent calls may be sent in one message so they execute in parallel; wait for all required results before synthesis.

Use background agents only for long-running or genuinely independent work whose result is not required before the parent can correctly continue. After delegating a scope in the background, do not research, implement, plan, review, or otherwise produce the same deliverable in the parent. If no independent parent work remains, stop and wait for completion instead of inventing more work. Do not finalize while a required background result remains uncollected.

Any change after a reviewer examines an artifact invalidates that verdict. Re-review the final artifact or perform equivalent parent verification before finalizing.

Parallel writers must use separate git worktrees. Worktree isolation is optional for read-only agents and a sole writer.
--- END SUBAGENT POLICY ---`;

export function formatContextUsage(usage: ContextUsage | undefined): string | undefined {
  if (!usage) return undefined;
  if (usage.tokens === null) {
    return `Parent context: usage temporarily unknown after compaction; context window ${usage.contextWindow.toLocaleString("en-US")} tokens.`;
  }

  const remaining = Math.max(0, usage.contextWindow - usage.tokens);
  const usedPercent = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
  const remainingPercent = Math.max(0, 100 - usedPercent);
  return `Parent context: ${usage.tokens.toLocaleString("en-US")}/${usage.contextWindow.toLocaleString("en-US")} tokens used (${usedPercent.toFixed(1)}%); ${remaining.toLocaleString("en-US")} tokens remain (${remainingPercent.toFixed(1)}%).`;
}

export default function subagentPolicy(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${SUBAGENT_POLICY_PROMPT}`,
  }));

  pi.on("context", (event, ctx) => {
    const usage = formatContextUsage(ctx.getContextUsage());
    if (!usage) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: "subagent-policy-context-usage",
          content: usage,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
}
