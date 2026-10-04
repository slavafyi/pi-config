import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Candidate, Evaluator, Recommendation, TaskContext } from "./types.ts";
import { evaluateWithDeadline } from "./evaluate.ts";

export function isContinuation(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?,;:…]+$/u, "").trim();
  return /^(ok|okay|yes|yep|sure|thanks|thank you|continue|go ahead|proceed|да|ага|угу|ок|окей|хорошо|спасибо|продолжай|продолжи|дальше|давай|вот[- ]вот|ну типа|хах)$/u.test(normalized);
}

export async function recommend(options: {
  task: TaskContext;
  candidates: readonly Candidate[];
  evaluator: Evaluator;
  evaluatorModel: { provider: string; model: string };
  current: { provider: string; model: string; thinkingLevel: ModelThinkingLevel };
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<Recommendation> {
  const result = await evaluateWithDeadline(
    options.evaluator, options.task, options.candidates, options.timeoutMs, options.signal,
  );
  return {
    version: 1,
    ...result.decision,
    current: options.current,
    evaluator: options.evaluatorModel,
    usage: result.usage,
  };
}
