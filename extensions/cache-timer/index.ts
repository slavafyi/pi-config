import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "1-cache-timer";
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
  if (remainingMs <= 0) return { text: "cache expired", tone: "error" };

  const totalSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return {
    text: `cache ${minutes}:${seconds.toString().padStart(2, "0")}`,
    tone: remainingMs <= windowMs * WARNING_RATIO ? "warning" : "dim",
  };
}

type AgentMessage = TurnEndEvent["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function isSuccessful(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error";
}

export default function cacheTimer(pi: ExtensionAPI) {
  let interval: ReturnType<typeof setInterval> | undefined;

  function clear(ctx: ExtensionContext) {
    if (interval) clearInterval(interval);
    interval = undefined;
    ctx.ui.setStatus(STATUS_ID, undefined);
  }

  function start(ctx: ExtensionContext, message: AgentMessage) {
    clear(ctx);
    if (!ctx.model || !isSuccessful(message)) return;
    if (message.provider !== ctx.model.provider || message.model !== ctx.model.id) return;

    const windowMs = cacheWindowMs(message.provider, message.model);
    if (!windowMs) return;

    const update = () => {
      const display = cacheDisplay(message.timestamp, windowMs);
      ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg(display.tone, display.text));
      if (display.tone === "error" && interval) {
        clearInterval(interval);
        interval = undefined;
      }
    };

    update();
    if (message.timestamp + windowMs > Date.now()) interval = setInterval(update, 1_000);
  }

  function restore(ctx: ExtensionContext) {
    clear(ctx);
    if (!ctx.model || !cacheWindowMs(ctx.model.provider, ctx.model.id)) return;

    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
      start(ctx, entry.message);
      return;
    }
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => clear(ctx));
  pi.on("turn_end", (event, ctx) => start(ctx, event.message));
  pi.on("session_tree", (event, ctx) => (event.summaryEntry ? clear(ctx) : restore(ctx)));
  pi.on("session_compact", (_event, ctx) => clear(ctx));
  pi.on("session_shutdown", (_event, ctx) => clear(ctx));
}
