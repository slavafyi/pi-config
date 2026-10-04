import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";

export interface ModelProfile {
  provider: string;
  model: string;
  role: string;
  useWhen: string;
  avoidWhen: string;
}

export interface Candidate extends ModelProfile {
  thinkingLevels: ModelThinkingLevel[];
}

export interface TaskContext {
  prompt: string;
  history: { role: "user" | "assistant"; text: string }[];
}

export interface Evaluation {
  provider: string;
  model: string;
  thinkingLevel: ModelThinkingLevel;
  explanation: string;
}

export interface EvaluationResult {
  decision: Evaluation;
  usage?: Usage;
}

export interface Evaluator {
  evaluate(task: TaskContext, candidates: readonly Candidate[], signal: AbortSignal): Promise<EvaluationResult>;
}

export interface Recommendation extends Evaluation {
  version: 1;
  current: { provider: string; model: string; thinkingLevel: ModelThinkingLevel };
  evaluator: { provider: string; model: string };
  usage?: Usage;
}
