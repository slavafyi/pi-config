import type { Candidate, Evaluator, TaskContext } from "./types.ts";
import { validateDecision } from "./core.ts";

export async function evaluateWithDeadline(
  evaluator: Evaluator,
  task: TaskContext,
  candidates: readonly Candidate[],
  timeoutMs: number,
  signal: AbortSignal,
) {
  const deadline = new AbortController();
  const combined = AbortSignal.any([signal, deadline.signal]);
  combined.throwIfAborted();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let onAbort: () => void = () => {};
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Evaluation cancelled or timed out"));
      combined.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([evaluator.evaluate(task, candidates, combined), cancelled]);
    combined.throwIfAborted();
    return { ...result, decision: validateDecision(result.decision, candidates) };
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", onAbort);
  }
}
