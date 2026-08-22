import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readUsageCache, writeUsageCache, type UsageCache } from "./cache.ts";
import {
  isAuthenticationError,
  parseCodexRateLimitHeaders,
  parseCodexUsagePayload,
  parseCursorUsagePayload,
  patchCursorMessageCost,
  selectQuota,
  styleQuotaStatus,
  type QuotaStatus,
  type UsageReport,
} from "./core.ts";
import { resolveCursorAccessToken } from "./credentials.ts";
import { FOOTER_INVALIDATE_EVENT } from "../footer/events.ts";

const STATUS_ID = "usage";
const TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SPINNER_DELAY_MS = 150;
const SPINNER_INTERVAL_MS = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const USAGE_PROVIDERS: Record<string, string> = {
  "openai-codex": "codex",
  cursor: "cursor",
};
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CURSOR_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
type UsageDisplay =
  | { type: "quota"; quota: QuotaStatus }
  | { type: "unavailable"; provider: string }
  | { type: "spinner"; frame: string };

function codexAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid token");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const claim = payload["https://api.openai.com/auth"];
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) throw new Error("missing claim");
    const accountId = (claim as { chatgpt_account_id?: unknown }).chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) throw new Error("missing account id");
    return accountId;
  } catch {
    throw new Error("OpenAI authentication is unavailable");
  }
}

async function fetchUsageJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function fetchCodexUsage(ctx: ExtensionContext): Promise<UsageReport> {
  const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
  const token = resolved?.auth.apiKey;
  if (!token) throw new Error("OpenAI authentication is unavailable");
  if (resolved.auth.baseUrl && new URL(resolved.auth.baseUrl).origin !== "https://chatgpt.com") {
    throw new Error("OpenAI Codex usage does not support proxy credentials");
  }
  const result = await fetchUsageJson(CODEX_USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": codexAccountId(token),
      "User-Agent": "pi-usage",
    },
  });
  if (result.status === 401 || result.status === 403) {
    throw new Error("OpenAI authentication is unavailable");
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`OpenAI usage returned HTTP ${result.status}`);
  }
  return parseCodexUsagePayload(result.text);
}

async function fetchCursorUsage(pi: ExtensionAPI): Promise<UsageReport> {
  const resolveToken = () =>
    resolveCursorAccessToken({
      exec: async (command, args) => pi.exec(command, args, { timeout: 3_000 }),
    });
  let token = await resolveToken();
  if (!token) throw new Error("Cursor authentication is unavailable");
  let result = await fetchUsageJson(CURSOR_USAGE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Connect-Protocol-Version": "1",
      "Content-Type": "application/json",
      "User-Agent": "pi-usage",
    },
    body: "{}",
  });
  if (result.status === 401 || result.status === 403) {
    token = await resolveToken();
    if (!token) throw new Error("Cursor authentication is unavailable");
    result = await fetchUsageJson(CURSOR_USAGE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Connect-Protocol-Version": "1",
        "Content-Type": "application/json",
        "User-Agent": "pi-usage",
      },
      body: "{}",
    });
  }
  if (result.status === 401 || result.status === 403) {
    throw new Error("Cursor authentication is unavailable");
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Cursor usage returned HTTP ${result.status}`);
  }
  return parseCursorUsagePayload(result.text);
}

export default async function usage(pi: ExtensionAPI) {
  const cachePath = join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    "usage-cache.json",
  );
  let activeCtx: ExtensionContext | undefined;
  let generation = 0;
  let display: UsageDisplay | undefined;
  let displayKey: string | undefined;
  let renderedStatus: string | undefined;
  let hasRenderedStatus = false;
  let spinnerDelay: ReturnType<typeof setTimeout> | undefined;
  let spinnerInterval: ReturnType<typeof setInterval> | undefined;
  const stored = await readUsageCache(cachePath);
  const cache = new Map<string, { report: UsageReport; fetchedAt: number }>(Object.entries(stored));
  const inFlight = new Map<string, Promise<UsageReport>>();
  const lastQuota = new Map<string, QuotaStatus>();
  let cacheWrite = Promise.resolve();

  function quotaKey(provider: string, modelId: string): string {
    return provider === "cursor" ? `cursor:${modelId}` : provider;
  }

  function persistCache() {
    const snapshot: UsageCache = Object.fromEntries(cache);
    cacheWrite = cacheWrite
      .catch(() => undefined)
      .then(() => writeUsageCache(cachePath, snapshot));
  }

  function saveReport(provider: string, report: UsageReport) {
    cache.set(provider, { report, fetchedAt: Date.now() });
    persistCache();
  }

  async function loadReport(provider: string, ctx: ExtensionContext): Promise<UsageReport> {
    const cached = cache.get(provider);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.report;
    const pending = inFlight.get(provider);
    if (pending) return pending;
    const request = (provider === "codex" ? fetchCodexUsage(ctx) : fetchCursorUsage(pi))
      .then((report) => {
        saveReport(provider, report);
        return report;
      })
      .finally(() => {
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

  function cachedQuota(provider: string, modelId: string): QuotaStatus | undefined {
    const source = USAGE_PROVIDERS[provider];
    const report = source ? cache.get(source)?.report : undefined;
    return report ? selectQuota(report, provider, modelId).quota : undefined;
  }

  async function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const requestGeneration = ++generation;
    const provider = ctx.model?.provider;
    const modelId = ctx.model?.id ?? "";
    const usageProvider = provider ? USAGE_PROVIDERS[provider] : undefined;
    if (!provider || !usageProvider) {
      stopSpinner();
      setDisplay(ctx, undefined, undefined);
      return;
    }

    const key = quotaKey(provider, modelId);
    if (displayKey !== key) {
      stopSpinner();
      const stale = lastQuota.get(key) ?? cachedQuota(provider, modelId);
      if (stale) showQuota(ctx, key, stale);
      else {
        setDisplay(ctx, key, undefined);
        scheduleSpinner(ctx, key, requestGeneration);
      }
    } else if (!display) {
      scheduleSpinner(ctx, key, requestGeneration);
    }

    try {
      const report = await loadReport(usageProvider, ctx);
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
      const stale = lastQuota.get(key) ?? cachedQuota(provider, modelId);
      if (stale) showQuota(ctx, key, stale);
      else showUnavailable(ctx, key, provider);
    } catch {
      if (!isCurrentRequest(ctx, key, requestGeneration)) return;
      const stale = lastQuota.get(key) ?? cachedQuota(provider, modelId);
      if (stale) showQuota(ctx, key, stale);
      else showUnavailable(ctx, key, provider);
    }
  }

  const unsubscribeInvalidate = pi.events.on(FOOTER_INVALIDATE_EVENT, () => {
    if (activeCtx) publishStatus(activeCtx);
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== "openai-codex") return;
    const report = parseCodexRateLimitHeaders(event.headers);
    if (!report) return;
    saveReport("codex", report);
    const selected = selectQuota(report, "openai-codex", ctx.model.id);
    if (!selected.quota || activeCtx !== ctx) return;
    const key = quotaKey("openai-codex", ctx.model.id);
    lastQuota.set(key, selected.quota);
    showQuota(ctx, key, selected.quota);
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

  pi.on("session_shutdown", async (_event, ctx) => {
    generation += 1;
    stopSpinner();
    display = undefined;
    displayKey = undefined;
    activeCtx = undefined;
    unsubscribeInvalidate();
    publishStatus(ctx);
    renderedStatus = undefined;
    hasRenderedStatus = false;
    await cacheWrite.catch(() => undefined);
  });
}
