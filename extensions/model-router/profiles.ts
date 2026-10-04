import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Candidate, ModelProfile } from "./types.ts";

export const EFFORT: Readonly<Record<ModelThinkingLevel, string>> = {
  off: "No reasoning needed; a direct extraction or transformation with unambiguous instructions.",
  minimal: "A very small reasoning budget is sufficient for a straightforward task.",
  low: "A well-scoped task with a known approach and few decisions.",
  medium: "Substantive technical work needing planning and checks.",
  high: "Difficult multi-step analysis or implementation with meaningful tradeoffs.",
  xhigh: "Demanding analysis, conflicting evidence, or exacting requirements justifies extra depth.",
  max: "The hardest unresolved problems, where maximum depth matters more than latency or usage. Not a routine default.",
};

export function describeChoice(profile: ModelProfile, thinkingLevel: ModelThinkingLevel): string {
  return `Model profile: ${profile.role}\nEffort profile: ${EFFORT[thinkingLevel]}`;
}

export const DEFAULT_PROFILES: readonly ModelProfile[] = [
  {
    provider: "openai-codex",
    model: "gpt-6-luna",
    role: "Efficient execution of focused tasks with clear constraints and an observable success condition.",
    useWhen: "Small local edits, extraction, transformations, structured summaries, and known-approach implementation. Higher effort can handle constrained multi-step work without changing model.",
    avoidWhen: "Open-ended architectural judgment, unresolved subtle failures, conflicting requirements, or unusually high consequences of an incorrect decision.",
  },
  {
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    role: "Default model for substantive engineering, including complex work where cost matters.",
    useWhen: "Feature implementation, debugging, refactoring, planning, and reviews within an understood system. Higher effort for conflicting evidence, difficult decisions, or polished results. Complexity alone does not require Astra.",
    avoidWhen: "A focused low-risk task fits Luna, or the task demonstrably requires the strongest available judgment beyond Sol, such as unresolved systemic failures or novel high-stakes decisions.",
  },
  {
    provider: "openai-codex",
    model: "gpt-6-astra",
    role: "Selective escalation for the most demanding judgment; not the default for every plan or review.",
    useWhen: "Novel architecture with consequential tradeoffs, demanding cross-system analysis, unresolved failures after substantive attempts, or exacting high-stakes requirements. Explain the need for escalation rather than choosing it just because a task has several files or steps.",
    avoidWhen: "Routine implementation, ordinary planning/review, or a task Sol can handle by increasing effort. Do not treat the word architecture alone as evidence that Astra is needed.",
  },
];

export function collectCandidates(
  profiles: readonly ModelProfile[],
  registry: Pick<ModelRegistry, "getAvailable">,
  hasImages = false,
): Candidate[] {
  const available = registry.getAvailable();
  return profiles.flatMap((profile) => {
    const model = available.find((item) => item.provider === profile.provider && item.id === profile.model);
    if (!model || (hasImages && !model.input.includes("image"))) return [];
    const supported = getSupportedThinkingLevels(model);
    const thinkingLevels = supported.filter((level) =>
      level !== "minimal" || !supported.includes("low") || model.thinkingLevelMap?.minimal !== "low",
    );
    return thinkingLevels.length ? [{ ...profile, thinkingLevels }] : [];
  });
}
