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

const STATUS_ID = "usage-status";
const TTL_MS = 30_000;
const CLI_TIMEOUT_MS = 25_000;
const CODEXBAR_PROVIDERS: Record<string, string> = {
  "openai-codex": "codex",
  cursor: "cursor",
};

export default function usage(pi: ExtensionAPI) {
  let active = false;
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
          "auto",
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
    if (!ctx.hasUI) return;
    const provider = ctx.model?.provider;
    const modelId = ctx.model?.id ?? "";
    const codexBarProvider = provider ? CODEXBAR_PROVIDERS[provider] : undefined;
    if (!provider || !codexBarProvider) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const key = quotaKey(provider, modelId);
    try {
      const report = await loadReport(codexBarProvider);
      if (!active || ctx.model?.provider !== provider) return;
      const selected = selectQuota(report, provider, ctx.model?.id ?? modelId);
      if (selected.quota) {
        lastQuota.set(quotaKey(provider, ctx.model?.id ?? modelId), selected.quota);
        ctx.ui.setStatus(STATUS_ID, styledQuotaStatus(ctx, selected.quota));
        return;
      }
      if (selected.entry?.error && isAuthenticationError(selected.entry.error.message)) {
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
    if (!ctx.model || !CODEXBAR_PROVIDERS[ctx.model.provider]) {
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
