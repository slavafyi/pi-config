import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  cachedUsageExpiresAt,
  isCachedUsageFresh,
  isCachedUsageUsable,
  mergeUsageCaches,
  readUsageCache,
  withUsageCacheLock,
  writeUsageCache,
  type CachedUsageReport,
  type UsageCache,
} from "./cache.ts";
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
import { codexAccountFingerprint, cursorAccountFingerprint } from "./identity.ts";
import { FOOTER_INVALIDATE_EVENT } from "../footer/events.ts";

const STATUS_ID = "usage";
const TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SPINNER_DELAY_MS = 150;
const SPINNER_INTERVAL_MS = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const USAGE_PROVIDERS: Record<string, UsageProvider> = {
  "openai-codex": "codex",
  cursor: "cursor",
};
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CURSOR_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

type UsageProvider = "codex" | "cursor";
type UsageDisplay =
  | { type: "quota"; quota: QuotaStatus }
  | { type: "unavailable"; provider: string }
  | { type: "spinner"; frame: string };
type UsageAccess =
  | { provider: "codex"; token: string; accountId: string; accountKey: string }
  | { provider: "cursor"; token: string; accountKey: string };
interface FetchedUsage {
  report: UsageReport;
  accountKey: string;
}

class AccountChangedUsageError extends Error {
  readonly accountKey: string;

  constructor(accountKey: string, cause: unknown) {
    super("usage account changed while refreshing credentials", { cause });
    this.accountKey = accountKey;
  }
}

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

async function resolveCodexAccess(ctx: ExtensionContext): Promise<UsageAccess> {
  const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
  const token = resolved?.auth.apiKey;
  if (!token) throw new Error("OpenAI authentication is unavailable");
  if (resolved.auth.baseUrl && new URL(resolved.auth.baseUrl).origin !== "https://chatgpt.com") {
    throw new Error("OpenAI Codex usage does not support proxy credentials");
  }
  const accountId = codexAccountId(token);
  return {
    provider: "codex",
    token,
    accountId,
    accountKey: codexAccountFingerprint(accountId),
  };
}

async function resolveCursorAccess(pi: ExtensionAPI): Promise<UsageAccess> {
  const token = await resolveCursorAccessToken({
    exec: async (command, args) => pi.exec(command, args, { timeout: 3_000 }),
  });
  if (!token) throw new Error("Cursor authentication is unavailable");
  return { provider: "cursor", token, accountKey: cursorAccountFingerprint(token) };
}

function resolveUsageAccess(
  provider: UsageProvider,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<UsageAccess> {
  return provider === "codex" ? resolveCodexAccess(ctx) : resolveCursorAccess(pi);
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

async function fetchCodexUsage(
  access: Extract<UsageAccess, { provider: "codex" }>,
): Promise<FetchedUsage> {
  const result = await fetchUsageJson(CODEX_USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${access.token}`,
      "ChatGPT-Account-Id": access.accountId,
      "User-Agent": "pi-usage",
    },
  });
  if (result.status === 401 || result.status === 403) {
    throw new Error("OpenAI authentication is unavailable");
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`OpenAI usage returned HTTP ${result.status}`);
  }
  return { report: parseCodexUsagePayload(result.text), accountKey: access.accountKey };
}

function cursorRequest(token: string): Promise<{ status: number; text: string }> {
  return fetchUsageJson(CURSOR_USAGE_URL, {
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

async function fetchCursorUsage(
  pi: ExtensionAPI,
  initialAccess: Extract<UsageAccess, { provider: "cursor" }>,
): Promise<FetchedUsage> {
  let access = initialAccess;
  try {
    let result = await cursorRequest(access.token);
    if (result.status === 401 || result.status === 403) {
      access = await resolveCursorAccess(pi) as Extract<UsageAccess, { provider: "cursor" }>;
      result = await cursorRequest(access.token);
    }
    if (result.status === 401 || result.status === 403) {
      throw new Error("Cursor authentication is unavailable");
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Cursor usage returned HTTP ${result.status}`);
    }
    return { report: parseCursorUsagePayload(result.text), accountKey: access.accountKey };
  } catch (error) {
    if (access.accountKey !== initialAccess.accountKey) {
      throw new AccountChangedUsageError(access.accountKey, error);
    }
    throw error;
  }
}

function fetchProviderUsage(pi: ExtensionAPI, access: UsageAccess): Promise<FetchedUsage> {
  return access.provider === "codex" ? fetchCodexUsage(access) : fetchCursorUsage(pi, access);
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
  let displayAccountKey: string | undefined;
  let renderedStatus: string | undefined;
  let hasRenderedStatus = false;
  let spinnerDelay: ReturnType<typeof setTimeout> | undefined;
  let spinnerInterval: ReturnType<typeof setInterval> | undefined;
  let quotaExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  const stored = await readUsageCache(cachePath);
  const cache = new Map<string, CachedUsageReport>(Object.entries(stored));
  const inFlight = new Map<string, Promise<FetchedUsage>>();
  let cacheWrite = Promise.resolve();
  let pendingCodexAccountKey: string | undefined;

  function quotaKey(provider: string, modelId: string): string {
    return provider === "cursor" ? `cursor:${modelId}` : provider;
  }

  function cacheSnapshot(): UsageCache {
    return Object.fromEntries(cache);
  }

  function replaceCache(next: UsageCache) {
    cache.clear();
    for (const [provider, cached] of Object.entries(next)) cache.set(provider, cached);
  }

  function saveReport(provider: UsageProvider, report: UsageReport, accountKey: string) {
    const entry: CachedUsageReport = { report, fetchedAt: Date.now(), accountKey };
    cache.set(provider, entry);
    const snapshot = cacheSnapshot();
    cacheWrite = cacheWrite
      .catch(() => undefined)
      .then(() => withUsageCacheLock(cachePath, async () => {
        const disk = await readUsageCache(cachePath);
        const merged = mergeUsageCaches(disk, snapshot, cacheSnapshot());
        await writeUsageCache(cachePath, merged);
        replaceCache(merged);
      }));
    return cacheWrite;
  }

  async function loadReport(
    provider: UsageProvider,
    access: UsageAccess,
  ): Promise<FetchedUsage> {
    const now = Date.now();
    const cached = cache.get(provider);
    if (
      isCachedUsageUsable(cached, provider, access.accountKey, now) &&
      isCachedUsageFresh(cached, now, TTL_MS)
    ) {
      return { report: cached.report, accountKey: cached.accountKey };
    }

    const flightKey = `${provider}:${access.accountKey}`;
    const pending = inFlight.get(flightKey);
    if (pending) return pending;
    const request = (async () => {
      await cacheWrite.catch(() => undefined);
      return withUsageCacheLock(cachePath, async () => {
        const disk = await readUsageCache(cachePath);
        const merged = mergeUsageCaches(disk, cacheSnapshot());
        replaceCache(merged);
        const lockedCached = cache.get(provider);
        const lockedNow = Date.now();
        if (
          isCachedUsageUsable(lockedCached, provider, access.accountKey, lockedNow) &&
          isCachedUsageFresh(lockedCached, lockedNow, TTL_MS)
        ) {
          return { report: lockedCached.report, accountKey: lockedCached.accountKey };
        }

        const fetched = await fetchProviderUsage(pi, access);
        const entry: CachedUsageReport = {
          report: fetched.report,
          fetchedAt: Date.now(),
          accountKey: fetched.accountKey,
        };
        if (!isCachedUsageUsable(entry, provider, fetched.accountKey)) {
          throw new Error(`${provider} usage snapshot is already expired`);
        }
        const next = mergeUsageCaches(disk, cacheSnapshot());
        next[provider] = entry;
        await writeUsageCache(cachePath, next);
        replaceCache(next);
        return fetched;
      });
    })().finally(() => {
      inFlight.delete(flightKey);
    });
    inFlight.set(flightKey, request);
    return request;
  }

  function stopQuotaExpiry() {
    if (quotaExpiryTimer) clearTimeout(quotaExpiryTimer);
    quotaExpiryTimer = undefined;
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

  function setDisplay(
    ctx: ExtensionContext,
    key: string | undefined,
    next: UsageDisplay | undefined,
    accountKey?: string,
  ) {
    stopQuotaExpiry();
    displayKey = key;
    displayAccountKey = accountKey;
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
        }, displayAccountKey);
        frame += 1;
      };
      update();
      spinnerInterval = setInterval(update, SPINNER_INTERVAL_MS);
    }, SPINNER_DELAY_MS);
  }

  function showQuota(
    ctx: ExtensionContext,
    key: string,
    quota: QuotaStatus,
    accountKey: string,
    expiresAt: number,
  ) {
    stopSpinner();
    setDisplay(ctx, key, { type: "quota", quota }, accountKey);
    quotaExpiryTimer = setTimeout(() => {
      if (activeCtx !== ctx || displayKey !== key || displayAccountKey !== accountKey) return;
      setDisplay(ctx, key, undefined, accountKey);
      void refresh(ctx);
    }, Math.max(0, expiresAt - Date.now()));
  }

  function showUnavailable(
    ctx: ExtensionContext,
    key: string,
    provider: string,
    accountKey?: string,
  ) {
    stopSpinner();
    setDisplay(ctx, key, { type: "unavailable", provider }, accountKey);
  }

  function cachedQuota(
    provider: string,
    modelId: string,
    accountKey: string,
  ): { quota: QuotaStatus; expiresAt: number } | undefined {
    const source = USAGE_PROVIDERS[provider];
    const cached = source ? cache.get(source) : undefined;
    if (!source || !isCachedUsageUsable(cached, source, accountKey)) return undefined;
    const quota = selectQuota(cached.report, provider, modelId).quota;
    const expiresAt = cachedUsageExpiresAt(cached, source);
    return quota && expiresAt !== undefined ? { quota, expiresAt } : undefined;
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
      setDisplay(ctx, key, undefined);
      scheduleSpinner(ctx, key, requestGeneration);
    } else if (!display) {
      scheduleSpinner(ctx, key, requestGeneration);
    }

    let access: UsageAccess;
    try {
      access = await resolveUsageAccess(usageProvider, pi, ctx);
    } catch {
      if (isCurrentRequest(ctx, key, requestGeneration)) {
        showUnavailable(ctx, key, provider);
      }
      return;
    }
    if (!isCurrentRequest(ctx, key, requestGeneration)) return;

    const stale = cachedQuota(provider, modelId, access.accountKey);
    if (display?.type === "spinner") {
      displayAccountKey = access.accountKey;
    } else if (
      displayAccountKey !== access.accountKey ||
      (display?.type === "quota" && !stale)
    ) {
      if (stale) showQuota(ctx, key, stale.quota, access.accountKey, stale.expiresAt);
      else {
        setDisplay(ctx, key, undefined, access.accountKey);
        scheduleSpinner(ctx, key, requestGeneration);
        displayAccountKey = access.accountKey;
      }
    }

    try {
      const loaded = await loadReport(usageProvider, access);
      if (!isCurrentRequest(ctx, key, requestGeneration)) return;
      const selected = selectQuota(loaded.report, provider, ctx.model?.id ?? modelId);
      if (selected.quota) {
        const currentModelId = ctx.model?.id ?? modelId;
        const currentKey = quotaKey(provider, currentModelId);
        const current = cachedQuota(provider, currentModelId, loaded.accountKey);
        if (current) {
          showQuota(ctx, currentKey, current.quota, loaded.accountKey, current.expiresAt);
          return;
        }
      }
      if (selected.entry?.error && isAuthenticationError(selected.entry.error.message)) {
        showUnavailable(ctx, key, provider, loaded.accountKey);
        return;
      }
      const fallback = cachedQuota(provider, modelId, loaded.accountKey);
      if (fallback) showQuota(ctx, key, fallback.quota, loaded.accountKey, fallback.expiresAt);
      else showUnavailable(ctx, key, provider, loaded.accountKey);
    } catch (error) {
      if (!isCurrentRequest(ctx, key, requestGeneration)) return;
      const accountKey = error instanceof AccountChangedUsageError
        ? error.accountKey
        : access.accountKey;
      const fallback = cachedQuota(provider, modelId, accountKey);
      if (fallback) showQuota(ctx, key, fallback.quota, accountKey, fallback.expiresAt);
      else showUnavailable(ctx, key, provider, accountKey);
    }
  }

  const unsubscribeInvalidate = pi.events.on(FOOTER_INVALIDATE_EVENT, () => {
    if (activeCtx) publishStatus(activeCtx);
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== "openai-codex") return;
    pendingCodexAccountKey = undefined;
    for (const [name, value] of Object.entries(event.headers)) {
      if (name.toLowerCase() === "chatgpt-account-id" && typeof value === "string" && value) {
        pendingCodexAccountKey = codexAccountFingerprint(value);
        break;
      }
    }
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== "openai-codex") return;
    const accountKey = pendingCodexAccountKey;
    pendingCodexAccountKey = undefined;
    if (!accountKey) return;
    let report: UsageReport | undefined;
    try {
      report = parseCodexRateLimitHeaders(event.headers);
    } catch {
      return;
    }
    if (!report) return;
    void saveReport("codex", report, accountKey).catch(() => undefined);
    const selected = selectQuota(report, "openai-codex", ctx.model.id);
    if (!selected.quota || activeCtx !== ctx) return;
    const key = quotaKey("openai-codex", ctx.model.id);
    const current = cachedQuota("openai-codex", ctx.model.id, accountKey);
    if (current) showQuota(ctx, key, current.quota, accountKey, current.expiresAt);
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
    displayAccountKey = undefined;
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
    stopQuotaExpiry();
    display = undefined;
    displayKey = undefined;
    displayAccountKey = undefined;
    activeCtx = undefined;
    unsubscribeInvalidate();
    publishStatus(ctx);
    renderedStatus = undefined;
    hasRenderedStatus = false;
    await cacheWrite.catch(() => undefined);
  });
}
