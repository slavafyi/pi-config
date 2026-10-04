import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadExtensionSettings } from "../shared/user-settings.ts";
import { parseRouterConfig, type RouterConfig } from "./config.ts";
import { isContinuation, recommend } from "./advisor.ts";
import { buildTaskContext } from "./context.ts";
import { differsFromCurrent, formatRecommendation, readRecommendation } from "./core.ts";
import { createJevEvaluator } from "./jev.ts";
import { collectCandidates } from "./profiles.ts";
import type { Recommendation } from "./types.ts";

const ENTRY_TYPE = "model-router-recommendation";
interface RecommendationEntry {
  recommendation: Recommendation;
  display?: boolean;
}
interface AdviceJob {
  prompt: string;
  recommendation?: Recommendation;
  readyToRecord: boolean;
  recorded: boolean;
}

export default function modelRouter(pi: ExtensionAPI) {
  let config: RouterConfig | undefined;
  let enabled = false;
  let last: Recommendation | undefined;
  let lastCheckFailed = false;
  let generation = 0;
  let pending: AbortController | undefined;
  let queuedAdvice: AdviceJob[] = [];
  let deliveredAdvice: AdviceJob | undefined;

  function cancel() {
    generation += 1;
    pending?.abort();
    pending = undefined;
  }

  function clearQueuedAdvice() {
    queuedAdvice = [];
    deliveredAdvice = undefined;
  }

  function recordRecommendation(ctx: ExtensionContext, recommendation: Recommendation, manual = false) {
    last = recommendation;
    const display = manual || differsFromCurrent(recommendation);
    pi.appendEntry<RecommendationEntry>(ENTRY_TYPE, { recommendation, display });
    if (display && ctx.hasUI && ctx.mode !== "tui") ctx.ui.notify(formatRecommendation(recommendation), "info");
  }

  function recordWhenReady(ctx: ExtensionContext, job: AdviceJob) {
    if (!job.readyToRecord || !job.recommendation || job.recorded) return;
    job.recorded = true;
    recordRecommendation(ctx, job.recommendation);
  }

  pi.registerEntryRenderer<RecommendationEntry>(ENTRY_TYPE, (entry, _options, theme) => {
    if (!entry.data?.display) return undefined;
    const recommendation = readRecommendation(entry.data.recommendation);
    if (!recommendation) return undefined;
    return new Text(
      `${theme.fg("accent", `Model recommendation: ${recommendation.model} / ${recommendation.thinkingLevel}`)}\n${theme.fg("muted", recommendation.explanation)}`,
      1, 0,
    );
  });

  function restore(ctx: ExtensionContext) {
    cancel();
    clearQueuedAdvice();
    last = undefined;
    lastCheckFailed = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const data = entry.data as RecommendationEntry | undefined;
      const recommendation = readRecommendation(data?.recommendation);
      if (recommendation) last = recommendation;
    }
  }

  async function check(prompt: string, ctx: ExtensionContext, hasImages = false, manual = false) {
    cancel();
    const current = ctx.model;
    if (!current || !config) {
      if (manual && ctx.hasUI) ctx.ui.notify("Configure extensions.model-router and select a model first.", "warning");
      return;
    }
    const settings = config;
    const requestGeneration = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const controller = new AbortController();
    pending = controller;
    const job: AdviceJob | undefined = manual ? undefined : { prompt, readyToRecord: false, recorded: false };
    if (job) queuedAdvice.push(job);
    const signal = manual && ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
    try {
      const messages = ctx.sessionManager.getBranch().flatMap((entry): AgentMessage[] =>
        entry.type === "message" ? [entry.message] : [],
      );
      const recommendation = await recommend({
        task: buildTaskContext(prompt, messages),
        candidates: collectCandidates(settings.profiles, ctx.modelRegistry, hasImages),
        evaluator: createJevEvaluator(ctx.modelRegistry, settings.evaluator.provider, settings.evaluator.model),
        evaluatorModel: { provider: settings.evaluator.provider, model: settings.evaluator.model },
        current: { provider: current.provider, model: current.id, thinkingLevel: ctx.thinkingLevel ?? "off" },
        timeoutMs: settings.timeoutMs,
        signal,
      });
      if (signal.aborted || requestGeneration !== generation || sessionId !== ctx.sessionManager.getSessionId()) return;
      last = recommendation;
      lastCheckFailed = false;
      if (manual) recordRecommendation(ctx, recommendation, true);
      else if (job) {
        job.recommendation = recommendation;
        recordWhenReady(ctx, job);
      }
    } catch {
      if (signal.aborted || requestGeneration !== generation || sessionId !== ctx.sessionManager.getSessionId()) return;
      lastCheckFailed = true;
      if (ctx.hasUI) ctx.ui.notify("Model recommendation unavailable. Continuing without changing model or thinking.", "warning");
    } finally {
      if (pending === controller) pending = undefined;
      if (job && !job.recommendation) {
        queuedAdvice = queuedAdvice.filter((item) => item !== job);
        if (deliveredAdvice === job) deliveredAdvice = undefined;
      }
    }
  }

  pi.on("input", (event, ctx) => {
    cancel();
    if (!enabled || !ctx.hasUI || event.source === "extension" ||
      !event.text.trim() || event.text.trimStart().startsWith("/") || isContinuation(event.text)) return;
    void check(event.text, ctx, Boolean(event.images?.length));
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user" && event.message.role !== "assistant") return;
    // The previous user message is persisted before the next message starts.
    if (deliveredAdvice) {
      deliveredAdvice.readyToRecord = true;
      recordWhenReady(ctx, deliveredAdvice);
      deliveredAdvice = undefined;
    }
    if (event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content
      .filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const index = queuedAdvice.findIndex((item) => text === item.prompt || text.startsWith(`${item.prompt}\n\n`));
    if (index !== -1) deliveredAdvice = queuedAdvice.splice(index, 1)[0]!;
  });

  pi.registerCommand("router", {
    description: "Model advisor: status, on, off, or check <task> (never switches models)",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "off") {
        cancel();
        enabled = false;
        clearQueuedAdvice();
        ctx.ui.notify("Model advisor off for this session.", "info");
      } else if (command === "on") {
        if (!config) {
          ctx.ui.notify("Add a valid extensions.model-router section to user-settings.json and /reload first.", "warning");
          return;
        }
        enabled = true;
        ctx.ui.notify("Model advisor on for this session. No automatic model or thinking changes.", "info");
      } else if (command.startsWith("check ") && command.slice(6).trim()) {
        await check(command.slice(6).trim(), ctx, false, true);
      } else if (!command || command === "status") {
        const state = config ? `Model advisor: ${enabled ? "on" : "off"}. Evaluator: ${config.evaluator.provider}/${config.evaluator.model}.` : "Model advisor: not configured or invalid configuration.";
        const recommendation = last ? `\n\nLast recommendation:\n${formatRecommendation(last)}` : "\nNo recommendation on this session branch.";
        const usage = last?.usage ? `\nClassifier tokens: ${last.usage.totalTokens} (separate from the generation model).` : "";
        const failure = lastCheckFailed ? "\nThe latest check failed; any recommendation above is from an earlier check." : "";
        ctx.ui.notify(state + recommendation + usage + failure, "info");
      } else {
        ctx.ui.notify("Usage: /router [status|on|off|check <task>]", "warning");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const raw = loadExtensionSettings("model-router");
    config = parseRouterConfig(raw);
    enabled = config?.enabled ?? false;
    restore(ctx);
    if (raw !== undefined && !config && ctx.hasUI) ctx.ui.notify("Invalid extensions.model-router configuration. Advisor disabled.", "warning");
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", () => { cancel(); clearQueuedAdvice(); });
  pi.on("session_shutdown", (_event, ctx) => {
    cancel();
    clearQueuedAdvice();
    last = undefined;
  });
}
