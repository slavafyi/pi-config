import assert from "node:assert/strict";
import test from "node:test";
import usage from "./index.ts";

const report = JSON.stringify([
  {
    provider: "codex",
    source: "oauth",
    usage: {
      primary: null,
      secondary: { usedPercent: 18, windowMinutes: 10_080 },
      tertiary: null,
    },
  },
]);

async function flushPromises() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function setup(exec: () => Promise<any>) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const statuses: Array<string | undefined> = [];
  let themeName = "light";
  let unsubscribed = false;
  const ctx = {
    hasUI: true,
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
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
    exec,
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

  usage(pi as any);
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
  let resolveExec: ((value: any) => void) | undefined;
  const pending = new Promise<any>((resolve) => {
    resolveExec = resolve;
  });
  const state = setup(() => pending);

  state.handlers.get("session_start")?.({}, state.ctx);
  assert.equal(state.statuses.at(-1), undefined);

  t.mock.timers.tick(149);
  assert.equal(state.statuses.at(-1), undefined);
  t.mock.timers.tick(1);
  assert.equal(state.statuses.at(-1), "light:dim:⠋");

  resolveExec?.({ code: 0, killed: false, stdout: report, stderr: "" });
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

  state.handlers.get("session_shutdown")?.({}, state.ctx);
  assert.equal(state.statuses.at(-1), undefined);
  assert.equal(state.isUnsubscribed(), true);
});

test("keeps the spinner moving when Pi supplies a new event context", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let resolveExec: ((value: any) => void) | undefined;
  const pending = new Promise<any>((resolve) => {
    resolveExec = resolve;
  });
  const state = setup(() => pending);

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

  resolveExec?.({ code: 0, killed: false, stdout: report, stderr: "" });
  await flushPromises();
  assert.equal(state.statuses.at(-1), "light:dim:7d:light:accent:82%");
  state.handlers.get("session_shutdown")?.({}, nextCtx);
});

test("cancels a delayed spinner when CodexBar responds quickly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const state = setup(async () => ({ code: 0, killed: false, stdout: report, stderr: "" }));

  state.handlers.get("session_start")?.({}, state.ctx);
  await flushPromises();
  t.mock.timers.tick(200);

  assert.deepEqual(state.statuses, [undefined, "light:dim:7d:light:accent:82%"]);
  state.handlers.get("session_shutdown")?.({}, state.ctx);
});

test("stops the spinner and shows unavailable after a CodexBar failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let resolveExec: ((value: any) => void) | undefined;
  const pending = new Promise<any>((resolve) => {
    resolveExec = resolve;
  });
  const state = setup(() => pending);

  state.handlers.get("session_start")?.({}, state.ctx);
  t.mock.timers.tick(150);
  assert.equal(state.statuses.at(-1), "light:dim:⠋");

  resolveExec?.({ code: 1, killed: true, stdout: "", stderr: "" });
  await flushPromises();
  assert.equal(state.statuses.at(-1), "light:dim:OpenAI: unavailable");
  const afterFailure = state.statuses.length;
  t.mock.timers.tick(500);
  assert.equal(state.statuses.length, afterFailure);

  state.handlers.get("session_shutdown")?.({}, state.ctx);
});

test("ignores a CodexBar result after session shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let resolveExec: ((value: any) => void) | undefined;
  const pending = new Promise<any>((resolve) => {
    resolveExec = resolve;
  });
  const state = setup(() => pending);

  state.handlers.get("session_start")?.({}, state.ctx);
  t.mock.timers.tick(150);
  state.handlers.get("session_shutdown")?.({}, state.ctx);
  const afterShutdown = state.statuses.length;

  resolveExec?.({ code: 0, killed: false, stdout: report, stderr: "" });
  await flushPromises();
  t.mock.timers.tick(500);
  assert.equal(state.statuses.length, afterShutdown);
});
