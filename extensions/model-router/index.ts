import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
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
}
const WIDGET_KEY = "model-router";

export default function modelRouter(pi: ExtensionAPI) {
  let config: RouterConfig | undefined;
  let enabled = false;
  let last: Recommendation | undefined;
  let lastCheckFailed = false;
  let generation = 0;
  let pending: AbortController | undefined;

  function cancel() {
    generation += 1;
    pending?.abort();
    pending = undefined;
  }

  function showRecommendation(ctx: ExtensionContext, recommendation: Recommendation | undefined) {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (!recommendation) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(WIDGET_KEY, () => ({
      render(width) {
        if (width <= 2) return [" ".repeat(Math.max(0, width))];
        const theme = ctx.ui.theme;
        const line = theme.fg("muted", "Suggested: ") +
          theme.fg("accent", `${recommendation.model} / ${recommendation.thinkingLevel}`);
        return [` ${truncateToWidth(line, width - 2)} `];
      },
      invalidate() {},
    }), { placement: "aboveEditor" });
  }

  function restore(ctx: ExtensionContext) {
    cancel();
    last = undefined;
    lastCheckFailed = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const data = entry.data as RecommendationEntry | undefined;
      const recommendation = readRecommendation(data?.recommendation);
      if (recommendation) last = recommendation;
    }
    showRecommendation(ctx, enabled ? last : undefined);
  }

  async function check(prompt: string, ctx: ExtensionContext, hasImages = false, manual = false) {
    cancel();
    const current = ctx.model;
    if (!current || !config) {
      if (manual && ctx.hasUI) ctx.ui.notify("Configure extensions.model-router and select a model first.", "warning");
      return;
    }
    const settings = config;
    showRecommendation(ctx, undefined);
    const requestGeneration = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const controller = new AbortController();
    pending = controller;
    const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
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
      pi.appendEntry<RecommendationEntry>(ENTRY_TYPE, { recommendation });
      showRecommendation(ctx, recommendation);
      if ((manual || differsFromCurrent(recommendation)) && ctx.hasUI && ctx.mode !== "tui") ctx.ui.notify(formatRecommendation(recommendation), "info");
    } catch {
      if (signal.aborted || requestGeneration !== generation || sessionId !== ctx.sessionManager.getSessionId()) return;
      lastCheckFailed = true;
      if (ctx.hasUI) ctx.ui.notify("Model recommendation unavailable. Continuing without changing model or thinking.", "warning");
    } finally {
      if (pending === controller) pending = undefined;
    }
  }

  pi.on("input", async (event, ctx) => {
    cancel();
    if (!enabled || !ctx.hasUI || event.source === "extension" ||
      !event.text.trim() || event.text.trimStart().startsWith("/") || isContinuation(event.text)) return;
    await check(event.text, ctx, Boolean(event.images?.length));
  });

  pi.registerCommand("router", {
    description: "Model advisor: status, on, off, or check <task> (never switches models)",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "off") {
        cancel();
        enabled = false;
        showRecommendation(ctx, undefined);
        ctx.ui.notify("Model advisor off for this session.", "info");
      } else if (command === "on") {
        if (!config) {
          ctx.ui.notify("Add a valid extensions.model-router section to user-settings.json and /reload first.", "warning");
          return;
        }
        enabled = true;
        showRecommendation(ctx, lastCheckFailed ? undefined : last);
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
  pi.on("model_select", () => cancel());
  pi.on("session_shutdown", (_event, ctx) => {
    cancel();
    last = undefined;
    showRecommendation(ctx, undefined);
  });
}
