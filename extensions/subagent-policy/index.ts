import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export const SUBAGENT_POLICY_PROMPT = `
--- SUBAGENT POLICY ---
Delegation is optional. Evaluate all three gates silently before every Agent call. Calling Agent certifies that all three gates passed. If any gate fails, continue locally without announcing the decision.

Gate 1 — Necessity and context economy: delegate only when the parent cannot reliably finish within its remaining context without a large or noisy investigation, or when isolated independent execution or review is needed. Use the latest parent-context snapshot; do not use a fixed percentage threshold.

Gate 2 — Independent value: delegate a distinct investigation, challenge, implementation, or review. Do not duplicate parent or sibling work or seek reassurance by vote.

Gate 3 — Handoff readiness: provide a narrow, self-contained task with relevant evidence, files or artifacts, constraints, and expected output. Use reviewer only after a finished artifact exists.

Here backgroundByDefault is false; disregard the Agent tool's generic true default. Always pass run_in_background explicitly: false if the parent must wait for the result, true only for long-running independent work it can continue without.

After background delegation, do not duplicate its scope in the parent. If no independent parent work remains, stop and wait. Do not finalize while a required background result remains uncollected.

Any change after review invalidates the verdict. Re-review the final artifact or perform equivalent parent verification before finalizing.

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
