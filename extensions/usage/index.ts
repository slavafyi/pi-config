import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isAuthenticationError,
  parseUsageReport,
  patchCursorMessageCost,
  preferredCursorPool,
  selectQuota,
  styleQuotaStatus,
  type QuotaStatus,
  type UsageReport,
} from "./core.ts";
import { FOOTER_INVALIDATE_EVENT } from "../footer/events.ts";

// The custom footer places known statuses in fixed slots.
const STATUS_ID = "usage";
const TTL_MS = 30_000;
const CLI_TIMEOUT_MS = 25_000;
const SPINNER_DELAY_MS = 150;
const SPINNER_INTERVAL_MS = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CODEXBAR_PROVIDERS: Record<string, string> = {
  "openai-codex": "codex",
  cursor: "cursor",
};

type UsageDisplay =
  | { type: "quota"; quota: QuotaStatus }
  | { type: "unavailable"; provider: string }
  | { type: "spinner"; frame: string };

export default function usage(pi: ExtensionAPI) {
  let activeCtx: ExtensionContext | undefined;
  let generation = 0;
  let display: UsageDisplay | undefined;
  let displayKey: string | undefined;
  let renderedStatus: string | undefined;
  let hasRenderedStatus = false;
  let spinnerDelay: ReturnType<typeof setTimeout> | undefined;
  let spinnerInterval: ReturnType<typeof setInterval> | undefined;
  const cache = new Map<string, { report: UsageReport; fetchedAt: number }>();
  const inFlight = new Map<string, Promise<UsageReport>>();
  const lastQuota = new Map<string, QuotaStatus>();

  function quotaKey(provider: string, modelId: string): string {
    return provider === "cursor" ? `cursor:${preferredCursorPool(modelId)}` : provider;
  }

  async function loadReport(provider: string): Promise<UsageReport> {
    const cached = cache.get(provider);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.report;
    const pending = inFlight.get(provider);
    if (pending) return pending;
    const request = (async () => {
      const result = await pi.exec(
        "codexbar",
        [
          "usage",
          "--provider",
          provider,
          "--source",
          provider === "codex" ? "oauth" : "auto",
          "--format",
          "json",
          "--json-only",
          "--web-timeout",
          "20",
          "--log-level",
          "error",
        ],
        { timeout: CLI_TIMEOUT_MS },
      );
      if (result.killed || !result.stdout.trim()) {
        throw new Error(result.killed ? "CodexBar timed out" : "CodexBar returned no JSON");
      }
      const report = parseUsageReport(result.stdout);
      cache.set(provider, { report, fetchedAt: Date.now() });
      return report;
    })().finally(() => {
      inFlight.delete(provider);
    });
    inFlight.set(provider, request);
    return request;
  }

  function stopSpinner() {
    if (spinnerDelay) clearTimeout(spinnerDelay);
    if (spinnerInterval) clearInterval(spinnerInterval);
    spinnerDelay = undefined;
    spinnerInterval = undefined;
  }

  function renderDisplay(ctx: ExtensionContext): string | undefined {
    if (!display) return undefined;
    if (display.type === "quota") {
      return styleQuotaStatus(display.quota, (tone, text) => ctx.ui.theme.fg(tone, text));
    }
    if (display.type === "unavailable") {
      const text = display.provider === "cursor" ? "Cursor: unavailable" : "OpenAI: unavailable";
      return ctx.ui.theme.fg("dim", text);
    }
    return ctx.ui.theme.fg("dim", display.frame);
  }

  function publishStatus(ctx: ExtensionContext) {
    const next = renderDisplay(ctx);
    if (hasRenderedStatus && next === renderedStatus) return;
    hasRenderedStatus = true;
    renderedStatus = next;
    ctx.ui.setStatus(STATUS_ID, next);
  }

  function setDisplay(ctx: ExtensionContext, key: string | undefined, next: UsageDisplay | undefined) {
    displayKey = key;
    display = next;
    publishStatus(ctx);
  }

  function isCurrentRequest(ctx: ExtensionContext, key: string, requestGeneration: number): boolean {
    const provider = ctx.model?.provider;
    return (
      activeCtx === ctx &&
      generation === requestGeneration &&
      Boolean(provider) &&
      quotaKey(provider!, ctx.model?.id ?? "") === key
    );
  }

  function scheduleSpinner(ctx: ExtensionContext, key: string, requestGeneration: number) {
    stopSpinner();
    displayKey = key;
    let frame = 0;
    spinnerDelay = setTimeout(() => {
      spinnerDelay = undefined;
      if (!isCurrentRequest(ctx, key, requestGeneration) || display) return;
      const update = () => {
        const currentCtx = activeCtx;
        if (!currentCtx || displayKey !== key) return;
        setDisplay(currentCtx, key, {
          type: "spinner",
          frame: SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!,
        });
        frame += 1;
      };
      update();
      spinnerInterval = setInterval(update, SPINNER_INTERVAL_MS);
    }, SPINNER_DELAY_MS);
  }

  function showQuota(ctx: ExtensionContext, key: string, quota: QuotaStatus) {
    stopSpinner();
    setDisplay(ctx, key, { type: "quota", quota });
  }

  function showUnavailable(ctx: ExtensionContext, key: string, provider: string) {
    stopSpinner();
    setDisplay(ctx, key, { type: "unavailable", provider });
  }

  async function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const requestGeneration = ++generation;
    const provider = ctx.model?.provider;
    const modelId = ctx.model?.id ?? "";
    const codexBarProvider = provider ? CODEXBAR_PROVIDERS[provider] : undefined;
    if (!provider || !codexBarProvider) {
      stopSpinner();
      setDisplay(ctx, undefined, undefined);
      return;
    }

    const key = quotaKey(provider, modelId);
    if (displayKey !== key) {
      stopSpinner();
      const stale = lastQuota.get(key);
      if (stale) showQuota(ctx, key, stale);
      else {
        setDisplay(ctx, key, undefined);
        scheduleSpinner(ctx, key, requestGeneration);
      }
    } else if (!display) {
      scheduleSpinner(ctx, key, requestGeneration);
    }

    try {
      const report = await loadReport(codexBarProvider);
      if (!isCurrentRequest(ctx, key, requestGeneration)) return;
      const selected = selectQuota(report, provider, ctx.model?.id ?? modelId);
      if (selected.quota) {
        const currentKey = quotaKey(provider, ctx.model?.id ?? modelId);
        lastQuota.set(currentKey, selected.quota);
        showQuota(ctx, currentKey, selected.quota);
        return;
      }
      if (selected.entry?.error && isAuthenticationError(selected.entry.error.message)) {
        showUnavailable(ctx, key, provider);
        return;
      }
      const stale = lastQuota.get(key);
      if (stale) showQuota(ctx, key, stale);
      else showUnavailable(ctx, key, provider);
    } catch {
      if (!isCurrentRequest(ctx, key, requestGeneration)) return;
      const stale = lastQuota.get(key);
      if (stale) showQuota(ctx, key, stale);
      else showUnavailable(ctx, key, provider);
    }
  }

  const unsubscribeInvalidate = pi.events.on(FOOTER_INVALIDATE_EVENT, () => {
    if (activeCtx) publishStatus(activeCtx);
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || event.message.provider !== "cursor") return;
    const message = patchCursorMessageCost(event.message);
    return message === event.message ? undefined : { message };
  });

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    generation += 1;
    display = undefined;
    displayKey = undefined;
    renderedStatus = undefined;
    hasRenderedStatus = false;
    void refresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    activeCtx = ctx;
    void refresh(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    activeCtx = ctx;
    void refresh(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    generation += 1;
    stopSpinner();
    display = undefined;
    displayKey = undefined;
    activeCtx = undefined;
    unsubscribeInvalidate();
    publishStatus(ctx);
    renderedStatus = undefined;
    hasRenderedStatus = false;
  });
}
