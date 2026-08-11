import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isAuthenticationError,
  parseUsageReport,
  patchCursorMessageCost,
  preferredCursorPool,
  selectQuota,
  type QuotaStatus,
  type UsageReport,
} from "./core.js";

const STATUS_ID = "ai-usage-status";
const TTL_MS = 30_000;
const CLI_TIMEOUT_MS = 25_000;
const SUPPORTED_PROVIDERS = new Set(["openai-codex", "cursor"]);

export default function aiUsageStatus(pi: ExtensionAPI) {
  let active = false;
  let cached: { report: UsageReport; fetchedAt: number } | undefined;
  let inFlight: Promise<UsageReport> | undefined;
  const lastQuota = new Map<string, QuotaStatus>();

  function quotaKey(provider: string, modelId: string): string {
    return provider === "cursor" ? `cursor:${preferredCursorPool(modelId)}` : provider;
  }

  async function loadReport(): Promise<UsageReport> {
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.report;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const result = await pi.exec("mise", ["exec", "--", "ai-usagebar", "usage", "--json"], {
        timeout: CLI_TIMEOUT_MS,
      });
      if (result.killed || !result.stdout.trim()) {
        throw new Error(result.killed ? "ai-usagebar timed out" : "ai-usagebar returned no JSON");
      }
      const report = parseUsageReport(result.stdout);
      cached = { report, fetchedAt: Date.now() };
      return report;
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  function styledQuotaStatus(ctx: ExtensionContext, quota: QuotaStatus): string {
    const theme = ctx.ui.theme;
    return (
      theme.fg("dim", `${quota.window}:`) +
      theme.fg("accent", `${quota.leftPercent}% left`) +
      (quota.reset ? theme.fg("dim", ` (↺${quota.reset})`) : "")
    );
  }

  function showUnavailable(ctx: ExtensionContext, provider: string) {
    const text = provider === "cursor" ? "Cursor: unavailable" : "OpenAI: unavailable";
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", text));
  }

  async function refresh(ctx: ExtensionContext) {
    const provider = ctx.model?.provider;
    const modelId = ctx.model?.id ?? "";
    if (!provider || !SUPPORTED_PROVIDERS.has(provider)) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const key = quotaKey(provider, modelId);
    try {
      const report = await loadReport();
      if (!active || ctx.model?.provider !== provider) return;
      const selected = selectQuota(report, provider, ctx.model?.id ?? modelId);
      if (selected.quota) {
        lastQuota.set(quotaKey(provider, ctx.model?.id ?? modelId), selected.quota);
        ctx.ui.setStatus(STATUS_ID, styledQuotaStatus(ctx, selected.quota));
        return;
      }
      if (selected.entry?.error && isAuthenticationError(selected.entry.error)) {
        showUnavailable(ctx, provider);
        return;
      }
      const stale = lastQuota.get(key);
      if (stale) ctx.ui.setStatus(STATUS_ID, styledQuotaStatus(ctx, stale));
      else showUnavailable(ctx, provider);
    } catch {
      if (!active || ctx.model?.provider !== provider) return;
      const stale = lastQuota.get(key);
      if (stale) ctx.ui.setStatus(STATUS_ID, styledQuotaStatus(ctx, stale));
      else showUnavailable(ctx, provider);
    }
  }

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || event.message.provider !== "cursor") return;
    const message = patchCursorMessageCost(event.message);
    return message === event.message ? undefined : { message };
  });

  pi.on("session_start", (_event, ctx) => {
    active = true;
    void refresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    if (!ctx.model || !SUPPORTED_PROVIDERS.has(ctx.model.provider)) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    void refresh(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    active = false;
    ctx.ui.setStatus(STATUS_ID, undefined);
  });
}
