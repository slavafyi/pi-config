import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_STALE_MS,
  readUsageCache,
  withUsageCacheLock,
  writeUsageCache,
  type UsageCache,
} from "./cache.ts";
import { parseCodexUsagePayload, parseCursorUsagePayload } from "./core.ts";
import { codexAccountFingerprint, cursorAccountFingerprint } from "./identity.ts";
import usage from "./index.ts";

const report = JSON.stringify({
  rate_limit: {
    primary_window: null,
    secondary_window: { used_percent: 18, limit_window_seconds: 604_800 },
  },
});
const reportWithBothWindows = JSON.stringify({
  rate_limit: {
    primary_window: { used_percent: 12, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 34, limit_window_seconds: 604_800 },
  },
});
const token = [
  "header",
  Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account" },
  })).toString("base64url"),
  "signature",
].join(".");
const accountKey = codexAccountFingerprint("account");
const normalizedReport = parseCodexUsagePayload(report);

function cursorToken(subject: string, suffix: string): string {
  return [
    "header",
    Buffer.from(JSON.stringify({ sub: subject, nonce: suffix })).toString("base64url"),
    suffix,
  ].join(".");
}

function cursorReport(): string {
  return JSON.stringify({
    billingCycleStart: Date.now() - 86_400_000,
    billingCycleEnd: Date.now() + 30 * 86_400_000,
    planUsage: { totalPercentUsed: 10, autoPercentUsed: 20, apiPercentUsed: 30 },
  });
}

async function flushPromises() {
  for (let index = 0; index < 500; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for usage status");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function setup(options: {
  cache?: UsageCache;
  agentDir?: string;
  provider?: "openai-codex" | "cursor";
  modelId?: string;
} = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const statuses: Array<string | undefined> = [];
  let themeName = "light";
  let unsubscribed = false;
  const ctx = {
    hasUI: true,
    model: {
      provider: options.provider ?? "openai-codex",
      id: options.modelId ?? "gpt-5.6-sol",
    },
    modelRegistry: {
      getProviderAuth: async () => ({
        auth: { apiKey: token, baseUrl: "https://chatgpt.com/backend-api" },
      }),
    },
    ui: {
      setStatus: (id: string, value: string | undefined) => {
        assert.equal(id, "usage");
        statuses.push(value);
      },
      theme: {
        fg: (tone: string, text: string) => `${themeName}:${tone}:${text}`,
      },
    },
  };
  const pi = {
    exec: async () => ({ code: 1, killed: false, stdout: "", stderr: "" }),
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, handler);
    },
    events: {
      on: (event: string, handler: (data: unknown) => void) => {
        eventHandlers.set(event, handler);
        return () => {
          unsubscribed = true;
          eventHandlers.delete(event);
        };
      },
    },
  };

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR =
    options.agentDir ?? await mkdtemp(join(tmpdir(), "pi-usage-test-"));
  try {
    if (options.cache) {
      await writeUsageCache(
        join(process.env.PI_CODING_AGENT_DIR, "usage-cache.json"),
        options.cache,
      );
    }
    await usage(pi as any);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  return {
    ctx,
    handlers,
    eventHandlers,
    statuses,
    setTheme(value: string) {
      themeName = value;
    },
    isUnsubscribed: () => unsubscribed,
  };
}

test("delays the first spinner and keeps a resolved quota during refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let resolveFetch: ((value: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  t.mock.method(globalThis, "fetch", () => pending);
  const state = await setup();

  state.handlers.get("session_start")?.({}, state.ctx);
  assert.equal(state.statuses.at(-1), undefined);

  t.mock.timers.tick(149);
  assert.equal(state.statuses.at(-1), undefined);
  t.mock.timers.tick(1);
  assert.equal(state.statuses.at(-1), "light:dim:⠋");

  resolveFetch?.(new Response(report));
  await flushPromises();
  assert.equal(state.statuses.at(-1), "light:dim:7d:light:accent:82%");

  const beforeRefresh = state.statuses.length;
  state.handlers.get("turn_end")?.({}, state.ctx);
  await flushPromises();
  t.mock.timers.tick(200);
  assert.equal(state.statuses.length, beforeRefresh);

  state.setTheme("dark");
  state.eventHandlers.get("footer:invalidate")?.(undefined);
  assert.equal(state.statuses.at(-1), "dark:dim:7d:dark:accent:82%");
  const afterThemeChange = state.statuses.length;
  state.eventHandlers.get("footer:invalidate")?.(undefined);
  assert.equal(state.statuses.length, afterThemeChange);

  await state.handlers.get("session_shutdown")?.({}, state.ctx);
  assert.equal(state.statuses.at(-1), undefined);
  assert.equal(state.isUnsubscribed(), true);
});

test("keeps the spinner moving when Pi supplies a new event context", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let resolveFetch: ((value: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  t.mock.method(globalThis, "fetch", () => pending);
  const state = await setup();

  state.handlers.get("session_start")?.({}, state.ctx);
  t.mock.timers.tick(150);
  assert.equal(state.statuses.at(-1), "light:dim:⠋");

  const nextCtx = {
    ...state.ctx,
    model: { ...state.ctx.model },
  };
  state.handlers.get("turn_end")?.({}, nextCtx);
  t.mock.timers.tick(100);
  assert.equal(state.statuses.at(-1), "light:dim:⠙");

  resolveFetch?.(new Response(report));
  await flushPromises();
  assert.equal(state.statuses.at(-1), "light:dim:7d:light:accent:82%");
  await state.handlers.get("session_shutdown")?.({}, nextCtx);
});

test("shows both Codex windows when direct usage responds quickly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(globalThis, "fetch", async () => new Response(reportWithBothWindows));
  const state = await setup();

  state.handlers.get("session_start")?.({}, state.ctx);
  await flushPromises();
  t.mock.timers.tick(200);

  assert.deepEqual(state.statuses, [
    undefined,
    "light:dim:5h:light:accent:88%  light:dim:7d:light:accent:66%",
  ]);
  await state.handlers.get("session_shutdown")?.({}, state.ctx);
});

test("stops the spinner and shows unavailable after a direct usage failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let resolveFetch: ((value: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  t.mock.method(globalThis, "fetch", () => pending);
  const state = await setup();

  state.handlers.get("session_start")?.({}, state.ctx);
  t.mock.timers.tick(150);
  assert.equal(state.statuses.at(-1), "light:dim:⠋");

  resolveFetch?.(new Response("", { status: 401 }));
  await flushPromises();
  assert.equal(state.statuses.at(-1), "light:dim:OpenAI: unavailable");
  const afterFailure = state.statuses.length;
  t.mock.timers.tick(500);
  assert.equal(state.statuses.length, afterFailure);

  await state.handlers.get("session_shutdown")?.({}, state.ctx);
});

test("shows only a stale cache entry for the current account", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let resolveFetch: ((value: Response) => void) | undefined;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  }));
  const state = await setup({
    cache: {
      codex: { report: normalizedReport, fetchedAt: Date.now() - 10 * 60_000, accountKey },
    },
  });

  state.handlers.get("session_start")?.({}, state.ctx);
  await flushPromises();
  assert.equal(state.statuses.at(-1), "light:dim:7d:light:accent:82%");

  resolveFetch?.(new Response("", { status: 503 }));
  await flushPromises();
  assert.equal(state.statuses.at(-1), "light:dim:7d:light:accent:82%");
  await state.handlers.get("session_shutdown")?.({}, state.ctx);
});

test("does not show another account's cached quota", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
  const state = await setup({
    cache: {
      codex: {
        report: normalizedReport,
        fetchedAt: Date.now(),
        accountKey: codexAccountFingerprint("other-account"),
      },
    },
  });

  state.handlers.get("session_start")?.({}, state.ctx);
  await flushPromises();
  assert.equal(state.statuses.at(-1), "light:dim:OpenAI: unavailable");
  await state.handlers.get("session_shutdown")?.({}, state.ctx);
});

test("does not show a cache entry past the stale limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
  const state = await setup({
    cache: {
      codex: {
        report: normalizedReport,
        fetchedAt: Date.now() - MAX_STALE_MS - 1,
        accountKey,
      },
    },
  });

  state.handlers.get("session_start")?.({}, state.ctx);
  await flushPromises();
  assert.equal(state.statuses.at(-1), "light:dim:OpenAI: unavailable");
  await state.handlers.get("session_shutdown")?.({}, state.ctx);
});

test("deduplicates refreshes across extension instances", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-usage-shared-test-"));
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return new Response(report);
  });

  try {
    const first = await setup({ agentDir });
    const second = await setup({ agentDir });
    first.handlers.get("session_start")?.({}, first.ctx);
    second.handlers.get("session_start")?.({}, second.ctx);
    await waitFor(() =>
      first.statuses.at(-1)?.includes("82%") === true &&
      second.statuses.at(-1)?.includes("82%") === true
    );
    assert.equal(fetches, 1);
    await first.handlers.get("session_shutdown")?.({}, first.ctx);
    await second.handlers.get("session_shutdown")?.({}, second.ctx);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("binds response headers to the outgoing Codex account without blocking", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-usage-header-test-"));
  const cachePath = join(agentDir, "usage-cache.json");
  let releaseLock!: () => void;
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  try {
    const state = await setup({ agentDir });
    const holder = withUsageCacheLock(cachePath, async () => {
      markLocked();
      await gate;
    });
    await locked;
    state.handlers.get("before_provider_headers")?.({
      headers: { "ChatGPT-Account-Id": "outgoing-account" },
    }, state.ctx);
    const result = state.handlers.get("after_provider_response")?.({
      headers: {
        "x-codex-secondary-used-percent": "18",
        "x-codex-secondary-window-minutes": "10080",
      },
    }, state.ctx);
    assert.equal(result, undefined);
    releaseLock();
    await holder;
    await state.handlers.get("session_shutdown")?.({}, state.ctx);
    assert.equal(
      (await readUsageCache(cachePath)).codex?.accountKey,
      codexAccountFingerprint("outgoing-account"),
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("uses the retried Cursor account after credential rotation", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-usage-cursor-rotation-"));
  const firstToken = cursorToken("account-a", "first");
  const secondToken = cursorToken("account-b", "second");
  const previousToken = process.env.CURSOR_AUTH_TOKEN;
  process.env.CURSOR_AUTH_TOKEN = firstToken;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    if (requests === 1) {
      process.env.CURSOR_AUTH_TOKEN = secondToken;
      return new Response("", { status: 401 });
    }
    return new Response(cursorReport());
  });
  try {
    const staleReport = parseCursorUsagePayload(cursorReport());
    const state = await setup({
      agentDir,
      provider: "cursor",
      modelId: "gpt-5.6-sol",
      cache: {
        cursor: {
          report: staleReport,
          fetchedAt: Date.now() - 10 * 60_000,
          accountKey: cursorAccountFingerprint(firstToken),
        },
      },
    });
    state.handlers.get("session_start")?.({}, state.ctx);
    await waitFor(() => state.statuses.at(-1)?.includes("light:accent:70%") === true);
    await state.handlers.get("session_shutdown")?.({}, state.ctx);
    assert.equal(
      (await readUsageCache(join(agentDir, "usage-cache.json"))).cursor?.accountKey,
      cursorAccountFingerprint(secondToken),
    );
  } finally {
    if (previousToken === undefined) delete process.env.CURSOR_AUTH_TOKEN;
    else process.env.CURSOR_AUTH_TOKEN = previousToken;
    await rm(agentDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

test("invalidates a displayed quota when its stale deadline passes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let resolveFetch: ((value: Response) => void) | undefined;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  }));
  const state = await setup({
    cache: {
      codex: {
        report: normalizedReport,
        fetchedAt: Date.now() - MAX_STALE_MS + 1_000,
        accountKey,
      },
    },
  });
    state.handlers.get("session_start")?.({}, state.ctx);
    await flushPromises();
    assert.equal(state.statuses.at(-1), "light:dim:7d:light:accent:82%");
    t.mock.timers.tick(1_000);
    await flushPromises();
    assert.equal(state.statuses.at(-1), undefined);
    resolveFetch?.(new Response("", { status: 503 }));
    await flushPromises();
    await state.handlers.get("session_shutdown")?.({}, state.ctx);
});

test("ignores a direct usage result after session shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let resolveFetch: ((value: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  t.mock.method(globalThis, "fetch", () => pending);
  const state = await setup();

  state.handlers.get("session_start")?.({}, state.ctx);
  t.mock.timers.tick(150);
  await state.handlers.get("session_shutdown")?.({}, state.ctx);
  const afterShutdown = state.statuses.length;

  resolveFetch?.(new Response(report));
  await flushPromises();
  t.mock.timers.tick(500);
  assert.equal(state.statuses.length, afterShutdown);
});
