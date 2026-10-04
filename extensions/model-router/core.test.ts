import assert from "node:assert/strict";
import test from "node:test";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isContinuation, recommend } from "./advisor.ts";
import { parseRouterConfig } from "./config.ts";
import { buildTaskContext } from "./context.ts";
import { differsFromCurrent, formatRecommendation, readRecommendation, validateDecision } from "./core.ts";
import { evaluateWithDeadline } from "./evaluate.ts";
import { buildJevRequest, createJevEvaluator } from "./jev.ts";
import { collectCandidates, DEFAULT_PROFILES } from "./profiles.ts";
import type { Candidate, EvaluationResult, Recommendation } from "./types.ts";

const candidate: Candidate = { ...DEFAULT_PROFILES[1]!, thinkingLevels: ["low", "medium", "high"] };
const task = { prompt: "Implement a scoped feature with tests", history: [] };
const decision = { provider: "openai-codex", model: "gpt-6.1-sol", thinkingLevel: "medium" as const, explanation: "Substantive engineering." };
const current = { provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "high" as const };
const evaluatorModel = { provider: "typesafe", model: "jev-latest" };
const recommendation: Recommendation = { version: 1, ...decision, current, evaluator: evaluatorModel };
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function choiceResult(choice = "route_1", reason = "engineering") {
  return {
    api: "typesafe-system-one", provider: "typesafe", model: "jev-1.13.0", stopReason: "stop", timestamp: 1,
    answers: {
      route: { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } },
      reason: { type: "choice", choice: reason, confidence: 1, probabilities: { [reason]: 1 } },
    },
    usage: { input: 123, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 135, cost: zeroCost },
  } as const;
}

function evaluatorFor(result: unknown, capture?: (context: unknown, options: unknown) => void) {
  return createJevEvaluator({
    findOfType: () => ({ id: "jev-latest" }),
    classify: async (_model: unknown, context: unknown, options: unknown) => {
      capture?.(context, options);
      return result;
    },
  } as any, "typesafe", "jev-latest");
}

test("configuration is opt-in and rejects invalid evaluator, timing, or profiles", () => {
  assert.equal(parseRouterConfig(undefined), undefined);
  assert.equal(parseRouterConfig({}), undefined);
  const parsed = parseRouterConfig({ enabled: true });
  assert.ok(parsed);
  assert.equal(parsed.timeoutMs, 2000);
  assert.deepEqual(parsed.evaluator, { type: "jev", provider: "typesafe", model: "jev-latest" });
  assert.deepEqual(parsed.profiles.map((profile) => profile.model), ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]);
  for (const patch of [
    { enabled: "yes" }, { timeoutMs: 0 }, { timeoutMs: 10_001 }, { timeoutMs: 1.5 },
    { evaluator: { type: "unknown", provider: "typesafe", model: "jev-latest" } },
    { evaluator: { type: "jev", provider: "typesafe\n", model: "jev-latest" } },
    { profiles: [] }, { profiles: [{ ...candidate, provider: "openai" }] },
    { profiles: [candidate, candidate] }, { profiles: [{ ...candidate, role: "" }] },
  ]) assert.equal(parseRouterConfig({ enabled: true, ...patch }), undefined);
  const custom = parseRouterConfig({ enabled: false, profiles: [candidate], timeoutMs: 500, evaluator: { type: "jev", provider: "opencode", model: "jev-1.13-free" } });
  assert.ok(custom && !custom.enabled && custom.profiles.length === 1);
});

test("candidates come only from available catalog models and supported effort levels", () => {
  const sol = {
    provider: "openai-codex", id: "gpt-6.1-sol", input: ["text", "image"], reasoning: true,
    thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: "max" },
  } as Model<Api>;
  const result = collectCandidates(DEFAULT_PROFILES, { getAvailable: () => [sol] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.model, "gpt-6.1-sol");
  assert.deepEqual(result[0]?.thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(collectCandidates(DEFAULT_PROFILES, { getAvailable: () => [{ ...sol, input: ["text"] }] }, true), []);
  assert.deepEqual(collectCandidates(DEFAULT_PROFILES, { getAvailable: () => [] }), []);
});

test("context sends bounded user/assistant text, never system, tools, reasoning, or images", () => {
  const messages = [
    { role: "system", content: "SYSTEM_SECRET" },
    { role: "user", content: [{ type: "text", text: "user context" }, { type: "image", data: "IMAGE_SECRET" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "REASONING_SECRET" }, { type: "toolCall", arguments: { secret: "ARG_SECRET" } }, { type: "text", text: "assistant context" }] },
    { role: "toolResult", content: [{ type: "text", text: "TOOL_SECRET" }] },
    { role: "custom", content: "CUSTOM_SECRET" },
  ] as AgentMessage[];
  const context = buildTaskContext("new task", messages);
  assert.deepEqual(context, { prompt: "new task", history: [{ role: "user", text: "user context" }, { role: "assistant", text: "assistant context" }] });
  assert.doesNotMatch(JSON.stringify(context), /SECRET/);
  const long = buildTaskContext("a".repeat(10_000) + "TAIL", Array.from({ length: 8 }, () => ({ role: "user", content: "b".repeat(3000), timestamp: 1 })));
  assert.equal(long.prompt.length, 8000);
  assert.ok(long.prompt.endsWith("TAIL"));
  assert.equal(long.history.length, 4);
  assert.ok(long.history.every((item) => item.text.length === 1600));
});

test("short acknowledgements are skipped, but short real tasks are not", () => {
  for (const text of ["окей!", "Да.", "continue", "Go ahead!", "спасибо", "продолжай…", "вот вот", "вот-вот!", "ну типа", "хах"]) assert.ok(isContinuation(text), text);
  for (const text of ["fix typo", "давай исправим", "review", "почему?", "yes, but use Astra", "вот что надо исправить", "ну типа реализуй функцию"]) assert.equal(isContinuation(text), false, text);
});

test("validation rejects unknown models, unsupported thinking, and empty explanations", () => {
  assert.deepEqual(validateDecision(decision, [candidate]), decision);
  for (const patch of [{ model: "invented" }, { provider: "unknown" }, { thinkingLevel: "off" }, { explanation: " " }]) {
    assert.throws(() => validateDecision({ ...decision, ...patch } as any, [candidate]));
  }
});

test("Jev choices contain only valid model/effort pairs and bounded requests", () => {
  const { context, routes } = buildJevRequest(task, [candidate]);
  assert.equal(routes.size, 3);
  assert.deepEqual([...routes.values()].map((route) => route.thinkingLevel), ["low", "medium", "high"]);
  assert.ok(context.questions.route?.type === "choice");
  assert.match(context.questions.route.instructions, /Complexity|complex engineering/);
  assert.throws(() => buildJevRequest(task, []), /No available/);
  assert.throws(() => buildJevRequest({ prompt: "🙂".repeat(20_000), history: [] }, [candidate]), /budget/);
});

test("Jev adapter uses Pi classification, cancellation, usage, and deterministic explanation", async () => {
  const signal = new AbortController().signal;
  let seenOptions: any;
  const evaluator = evaluatorFor(choiceResult(), (_context, options) => { seenOptions = options; });
  const result = await evaluator.evaluate(task, [candidate], signal);
  assert.equal(result.decision.model, "gpt-6.1-sol");
  assert.equal(result.decision.thinkingLevel, "medium");
  assert.match(result.decision.explanation, /Model profile: Default model for substantive engineering/);
  assert.match(result.decision.explanation, /Effort profile: Substantive technical work/);
  assert.equal(result.usage?.totalTokens, 135);
  assert.equal(seenOptions.signal, signal);
});

test("Jev uses one choice and binds its description to the selected model and effort", async () => {
  const luna: Candidate = { ...DEFAULT_PROFILES[0]!, thinkingLevels: ["off", "low"] };
  let request: any;
  const evaluator = evaluatorFor(choiceResult("route_0", "engineering"), (context) => { request = context; });
  const result = await evaluator.evaluate(task, [luna], new AbortController().signal);
  assert.deepEqual(Object.keys(request.questions), ["route"]);
  assert.equal(result.decision.model, "gpt-6-luna");
  assert.equal(result.decision.thinkingLevel, "off");
  assert.match(result.decision.explanation, /Model profile: Efficient execution/);
  assert.match(result.decision.explanation, /Effort profile: No reasoning needed/);
  assert.doesNotMatch(result.decision.explanation, /Substantive engineering/);
});

test("effort descriptions do not refer to a different model", async () => {
  const astra: Candidate = { ...DEFAULT_PROFILES[2]!, thinkingLevels: ["medium"] };
  const result = await evaluatorFor(choiceResult("route_0")).evaluate(task, [astra], new AbortController().signal);
  assert.equal(result.decision.model, "gpt-6-astra");
  assert.match(result.decision.explanation, /Effort profile: Substantive technical work/);
  assert.doesNotMatch(result.decision.explanation, /\bSol\b/);
});

test("Jev rejects failed, malformed, and unknown answers instead of guessing", async () => {
  for (const result of [
    { ...choiceResult(), stopReason: "error", errorMessage: "SECRET_ERROR" },
    { ...choiceResult(), answers: {} }, choiceResult("unknown"),
  ]) {
    await assert.rejects(evaluatorFor(result).evaluate(task, [candidate], new AbortController().signal));
  }
  const missing = createJevEvaluator({ findOfType: () => undefined } as any, "typesafe", "jev-latest");
  await assert.rejects(missing.evaluate(task, [candidate], new AbortController().signal), /unavailable/);
});

test("deadline bounds an evaluator even if it ignores cancellation", async () => {
  let observedSignal: AbortSignal | undefined;
  const evaluator = { evaluate: (_task: unknown, _candidates: unknown, signal: AbortSignal) => {
    observedSignal = signal;
    return new Promise<EvaluationResult>(() => {});
  } };
  await assert.rejects(evaluateWithDeadline(evaluator, task, [candidate], 15, new AbortController().signal), /timed out/);
  assert.ok(observedSignal?.aborted);
});

test("caller cancellation ends the evaluation and its wait", async () => {
  const controller = new AbortController();
  const evaluator = { evaluate: () => new Promise<EvaluationResult>(() => {}) };
  const pending = evaluateWithDeadline(evaluator, task, [candidate], 5000, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("generic advisor can use a non-Jev evaluator without changing its contract", async () => {
  const result = await recommend({
    task, candidates: [candidate], current, evaluatorModel, timeoutMs: 100,
    signal: new AbortController().signal,
    evaluator: { evaluate: async () => ({ decision }) },
  });
  assert.deepEqual(result, { ...recommendation, usage: undefined });
});

test("recommendations detect differences in either model or thinking and render comparison", () => {
  assert.ok(differsFromCurrent(recommendation));
  const sameModel = { ...recommendation, current: { ...decision, thinkingLevel: "high" as const } };
  assert.ok(differsFromCurrent(sameModel));
  assert.equal(differsFromCurrent({ ...recommendation, current: decision }), false);
  assert.match(formatRecommendation(recommendation), /No settings changed/);
  assert.match(formatRecommendation(recommendation), /gpt-6.1-sol \/ medium/);
  assert.equal(readRecommendation(undefined), undefined);
  assert.equal(readRecommendation({ version: 1 }), undefined);
  assert.equal(readRecommendation({ ...recommendation, current: {} }), undefined);
  assert.deepEqual(readRecommendation(recommendation), recommendation);
});
