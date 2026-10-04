import type { Evaluation, Candidate, Recommendation } from "./types.ts";

export function validateDecision(decision: Evaluation, candidates: readonly Candidate[]): Evaluation {
  const candidate = candidates.find((item) => item.provider === decision.provider && item.model === decision.model);
  if (!candidate || !candidate.thinkingLevels.includes(decision.thinkingLevel)) {
    throw new Error("Evaluator selected an unavailable model or unsupported thinking level");
  }
  if (!decision.explanation.trim()) throw new Error("Evaluator did not explain its recommendation");
  return decision;
}

export function readRecommendation(value: unknown): Recommendation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const modelPair = (pair: unknown): pair is Record<string, string> => {
    if (typeof pair !== "object" || pair === null) return false;
    const fields = pair as Record<string, unknown>;
    return typeof fields.provider === "string" && typeof fields.model === "string";
  };
  if (item.version !== 1 || !modelPair(item) || !modelPair(item.current) || !modelPair(item.evaluator) ||
    typeof item.thinkingLevel !== "string" || !levels.includes(item.thinkingLevel) ||
    typeof item.current.thinkingLevel !== "string" || !levels.includes(item.current.thinkingLevel) ||
    typeof item.explanation !== "string" || !item.explanation.trim()) return undefined;
  return value as Recommendation;
}

export function differsFromCurrent(recommendation: Recommendation): boolean {
  return recommendation.provider !== recommendation.current.provider ||
    recommendation.model !== recommendation.current.model ||
    recommendation.thinkingLevel !== recommendation.current.thinkingLevel;
}

export function formatRecommendation(recommendation: Recommendation): string {
  return [
    `Model recommendation: ${recommendation.provider}/${recommendation.model} / ${recommendation.thinkingLevel}`,
    recommendation.explanation,
    `Current: ${recommendation.current.provider}/${recommendation.current.model} / ${recommendation.current.thinkingLevel}. No settings changed.`,
  ].join("\n");
}
