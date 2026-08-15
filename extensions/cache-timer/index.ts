import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { FOOTER_INVALIDATE_EVENT } from "../footer/events.ts";

const STATUS_ID = "cache-timer";
const MINUTE_MS = 60_000;
const WARNING_RATIO = 0.3;

export type CacheTone = "dim" | "warning" | "error";

export interface CacheDisplay {
  text: string;
  tone: CacheTone;
}

export function cacheWindowMs(provider: string, model: string): number | undefined {
  const id = model.toLowerCase();

  if (provider === "openai-codex" && id.includes("gpt-5.6")) return 5 * MINUTE_MS;
  if ((provider === "openai" || provider === "cursor") && id.includes("gpt-5.6")) return 30 * MINUTE_MS;
  if (provider === "anthropic" || (provider === "cursor" && id.includes("claude"))) return 5 * MINUTE_MS;

  return undefined;
}

export function cacheDisplay(lastRequestAt: number, windowMs: number, now = Date.now()): CacheDisplay {
  const remainingMs = lastRequestAt + windowMs - now;
  if (remainingMs <= 0) return { text: "expired", tone: "error" };

  const totalSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return {
    text: `${minutes}:${seconds.toString().padStart(2, "0")}`,
    tone: remainingMs <= windowMs * WARNING_RATIO ? "warning" : "dim",
  };
}

type AgentMessage = TurnEndEvent["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function isSuccessful(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error";
}

interface CacheAnchor {
  provider: string;
  model: string;
  timestamp: number;
  windowMs: number;
}

export default function cacheTimer(pi: ExtensionAPI) {
  let interval: ReturnType<typeof setInterval> | undefined;
  let confirmed: CacheAnchor | undefined;
  let visible: CacheAnchor | undefined;
  let activeCtx: ExtensionContext | undefined;
  let renderedStatus: string | undefined;
  let hasRenderedStatus = false;

  function stopInterval() {
    if (interval) clearInterval(interval);
    interval = undefined;
  }

  function publishStatus(ctx: ExtensionContext, next: string | undefined) {
    if (hasRenderedStatus && next === renderedStatus) return;
    hasRenderedStatus = true;
    renderedStatus = next;
    ctx.ui.setStatus(STATUS_ID, next);
  }

  function hide(ctx: ExtensionContext) {
    stopInterval();
    visible = undefined;
    publishStatus(ctx, undefined);
  }

  function reset(ctx: ExtensionContext) {
    confirmed = undefined;
    hide(ctx);
  }

  function anchor(provider: string, model: string, timestamp: number): CacheAnchor | undefined {
    const windowMs = cacheWindowMs(provider, model);
    return windowMs ? { provider, model, timestamp, windowMs } : undefined;
  }

  function isCurrent(ctx: ExtensionContext, value: CacheAnchor): boolean {
    return ctx.model?.provider === value.provider && ctx.model.id === value.model;
  }

  function update(ctx: ExtensionContext, value: CacheAnchor) {
    if (!isCurrent(ctx, value)) {
      hide(ctx);
      return;
    }
    const display = cacheDisplay(value.timestamp, value.windowMs);
    publishStatus(ctx, ctx.ui.theme.fg(display.tone, display.text));
    if (display.tone === "error") stopInterval();
  }

  function show(ctx: ExtensionContext, value: CacheAnchor) {
    stopInterval();
    if (!isCurrent(ctx, value)) {
      hide(ctx);
      return;
    }
    visible = value;
    update(ctx, value);
    if (value.timestamp + value.windowMs > Date.now()) {
      interval = setInterval(() => update(ctx, value), 1_000);
    }
  }

  const unsubscribeInvalidate = pi.events.on(FOOTER_INVALIDATE_EVENT, () => {
    if (activeCtx && visible) update(activeCtx, visible);
  });

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    renderedStatus = undefined;
    hasRenderedStatus = false;
    reset(ctx);
  });
  pi.on("model_select", (_event, ctx) => reset(ctx));
  pi.on("turn_start", (event, ctx) => {
    if (!ctx.model) return reset(ctx);
    const pending = anchor(ctx.model.provider, ctx.model.id, event.timestamp);
    if (pending) show(ctx, pending);
    else reset(ctx);
  });
  pi.on("turn_end", (event, ctx) => {
    if (isSuccessful(event.message)) {
      const completed = anchor(event.message.provider, event.message.model, event.message.timestamp);
      if (completed && isCurrent(ctx, completed)) {
        confirmed = completed;
        show(ctx, completed);
        return;
      }
    }
    if (confirmed && isCurrent(ctx, confirmed)) show(ctx, confirmed);
    else hide(ctx);
  });
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_compact", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    activeCtx = undefined;
    unsubscribeInvalidate();
    reset(ctx);
    renderedStatus = undefined;
    hasRenderedStatus = false;
  });
}
