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
  selectQuota,
  styleQuotaStatus,
  type QuotaStatus,
  type UsageReport,
} from "./core.ts";
import { codexAccountFingerprint } from "./identity.ts";
import { FOOTER_INVALIDATE_EVENT } from "../footer/events.ts";

const STATUS_ID = "usage";
const TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SPINNER_DELAY_MS = 150;
const SPINNER_INTERVAL_MS = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
type UsageDisplay =
  | { type: "quota"; quotas: QuotaStatus[] }
  | { type: "unavailable" }
  | { type: "spinner"; frame: string };
interface UsageAccess {
  token: string;
  accountId: string;
  accountKey: string;
}
interface FetchedUsage {
  report: UsageReport;
  accountKey: string;
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
    token,
    accountId,
    accountKey: codexAccountFingerprint(accountId),
  };
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
  access: UsageAccess,
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

  function cacheSnapshot(): UsageCache {
    return Object.fromEntries(cache);
  }

  function replaceCache(next: UsageCache) {
    cache.clear();
    for (const [provider, cached] of Object.entries(next)) cache.set(provider, cached);
  }

  function saveReport(report: UsageReport, accountKey: string) {
    const entry: CachedUsageReport = { report, fetchedAt: Date.now(), accountKey };
    cache.set("codex", entry);
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

  async function loadReport(access: UsageAccess): Promise<FetchedUsage> {
    const now = Date.now();
    const cached = cache.get("codex");
    if (
      isCachedUsageUsable(cached, access.accountKey, now) &&
      isCachedUsageFresh(cached, now, TTL_MS)
    ) {
      return { report: cached.report, accountKey: cached.accountKey };
    }

    const flightKey = access.accountKey;
    const pending = inFlight.get(flightKey);
    if (pending) return pending;
    const request = (async () => {
      await cacheWrite.catch(() => undefined);
      return withUsageCacheLock(cachePath, async () => {
        const disk = await readUsageCache(cachePath);
        const merged = mergeUsageCaches(disk, cacheSnapshot());
        replaceCache(merged);
        const lockedCached = cache.get("codex");
        const lockedNow = Date.now();
        if (
          isCachedUsageUsable(lockedCached, access.accountKey, lockedNow) &&
          isCachedUsageFresh(lockedCached, lockedNow, TTL_MS)
        ) {
          return { report: lockedCached.report, accountKey: lockedCached.accountKey };
        }

        const fetched = await fetchCodexUsage(access);
        const entry: CachedUsageReport = {
          report: fetched.report,
          fetchedAt: Date.now(),
          accountKey: fetched.accountKey,
        };
        if (!isCachedUsageUsable(entry, fetched.accountKey)) {
          throw new Error("codex usage snapshot is already expired");
        }
        const next = mergeUsageCaches(disk, cacheSnapshot());
        next.codex = entry;
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
      return display.quotas
        .map((quota) => styleQuotaStatus(quota, (tone, text) => ctx.ui.theme.fg(tone, text)))
        .join("  ");
    }
    if (display.type === "unavailable") {
      return ctx.ui.theme.fg("dim", "OpenAI: unavailable");
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
    return (
      activeCtx === ctx &&
      generation === requestGeneration &&
      ctx.model?.provider === key
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

  function showQuotas(
    ctx: ExtensionContext,
    key: string,
    quotas: QuotaStatus[],
    accountKey: string,
    expiresAt: number,
  ) {
    stopSpinner();
    setDisplay(ctx, key, { type: "quota", quotas }, accountKey);
    quotaExpiryTimer = setTimeout(() => {
      if (activeCtx !== ctx || displayKey !== key || displayAccountKey !== accountKey) return;
      setDisplay(ctx, key, undefined, accountKey);
      void refresh(ctx);
    }, Math.max(0, expiresAt - Date.now()));
  }

  function showUnavailable(
    ctx: ExtensionContext,
    key: string,
    accountKey?: string,
  ) {
    stopSpinner();
    setDisplay(ctx, key, { type: "unavailable" }, accountKey);
  }

  function cachedQuota(
    accountKey: string,
  ): { quotas: QuotaStatus[]; expiresAt: number } | undefined {
    const cached = cache.get("codex");
    if (!isCachedUsageUsable(cached, accountKey)) return undefined;
    const quotas = selectQuota(cached.report).quotas;
    const expiresAt = cachedUsageExpiresAt(cached);
    return quotas?.length && expiresAt !== undefined ? { quotas, expiresAt } : undefined;
  }

  async function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const requestGeneration = ++generation;
    const provider = ctx.model?.provider;
    if (provider !== "openai-codex") {
      stopSpinner();
      setDisplay(ctx, undefined, undefined);
      return;
    }

    const key = provider;
    if (displayKey !== key) {
      stopSpinner();
      setDisplay(ctx, key, undefined);
      scheduleSpinner(ctx, key, requestGeneration);
    } else if (!display) {
      scheduleSpinner(ctx, key, requestGeneration);
    }

    let access: UsageAccess;
    try {
      access = await resolveCodexAccess(ctx);
    } catch {
      if (isCurrentRequest(ctx, key, requestGeneration)) {
        showUnavailable(ctx, key);
      }
      return;
    }
    if (!isCurrentRequest(ctx, key, requestGeneration)) return;

    const stale = cachedQuota(access.accountKey);
    if (display?.type === "spinner") {
      displayAccountKey = access.accountKey;
    } else if (
      displayAccountKey !== access.accountKey ||
      (display?.type === "quota" && !stale)
    ) {
      if (stale) showQuotas(ctx, key, stale.quotas, access.accountKey, stale.expiresAt);
      else {
        setDisplay(ctx, key, undefined, access.accountKey);
        scheduleSpinner(ctx, key, requestGeneration);
        displayAccountKey = access.accountKey;
      }
    }

    try {
      const loaded = await loadReport(access);
      if (!isCurrentRequest(ctx, key, requestGeneration)) return;
      const selected = selectQuota(loaded.report);
      if (selected.quotas?.length) {
        const current = cachedQuota(loaded.accountKey);
        if (current) {
          showQuotas(ctx, key, current.quotas, loaded.accountKey, current.expiresAt);
          return;
        }
      }
      if (selected.entry?.error && isAuthenticationError(selected.entry.error.message)) {
        showUnavailable(ctx, key, loaded.accountKey);
        return;
      }
      const fallback = cachedQuota(loaded.accountKey);
      if (fallback) showQuotas(ctx, key, fallback.quotas, loaded.accountKey, fallback.expiresAt);
      else showUnavailable(ctx, key, loaded.accountKey);
    } catch {
      if (!isCurrentRequest(ctx, key, requestGeneration)) return;
      const accountKey = access.accountKey;
      const fallback = cachedQuota(accountKey);
      if (fallback) showQuotas(ctx, key, fallback.quotas, accountKey, fallback.expiresAt);
      else showUnavailable(ctx, key, accountKey);
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
    void saveReport(report, accountKey).catch(() => undefined);
    const selected = selectQuota(report);
    if (!selected.quotas?.length || activeCtx !== ctx) return;
    const key = "openai-codex";
    const current = cachedQuota(accountKey);
    if (current) showQuotas(ctx, key, current.quotas, accountKey, current.expiresAt);
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
