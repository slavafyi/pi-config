export type OnceState = {
  phase: "disabled" | "armed" | "active";
  pendingUserPrompt: boolean;
};

export type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export function createState(): OnceState {
  return { phase: "disabled", pendingUserPrompt: false };
}

export function arm(state: OnceState): boolean {
  if (state.phase !== "disabled") return false;
  state.phase = "armed";
  return true;
}

export function noteUserPrompt(state: OnceState, source: string): boolean {
  if (state.phase !== "armed" || source === "extension") return false;
  state.pendingUserPrompt = true;
  return true;
}

export function startParentRun(state: OnceState): boolean {
  if (state.phase !== "armed" || !state.pendingUserPrompt) return false;
  state.phase = "active";
  state.pendingUserPrompt = false;
  return true;
}

export function settleParentRun(state: OnceState): boolean {
  if (state.phase !== "active") return false;
  reset(state);
  return true;
}

export function reset(state: OnceState): void {
  state.phase = "disabled";
  state.pendingUserPrompt = false;
}

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
