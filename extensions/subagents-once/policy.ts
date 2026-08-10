export type OnceState = {
  phase: "disabled" | "armed" | "active";
  pendingUserPrompt: boolean;
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
