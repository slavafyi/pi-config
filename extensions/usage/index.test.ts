import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import usage from "./index.ts";

const report = JSON.stringify({
  rate_limit: {
    primary_window: null,
    secondary_window: { used_percent: 18, limit_window_seconds: 604_800 },
  },
});
const token = [
  "header",
  Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account" },
  })).toString("base64url"),
  "signature",
].join(".");

async function flushPromises() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

async function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const statuses: Array<string | undefined> = [];
  let themeName = "light";
  let unsubscribed = false;
  const ctx = {
    hasUI: true,
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
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
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-usage-test-"));
  try {
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

test("cancels a delayed spinner when direct usage responds quickly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(globalThis, "fetch", async () => new Response(report));
  const state = await setup();

  state.handlers.get("session_start")?.({}, state.ctx);
  await flushPromises();
  t.mock.timers.tick(200);

  assert.deepEqual(state.statuses, [undefined, "light:dim:7d:light:accent:82%"]);
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
