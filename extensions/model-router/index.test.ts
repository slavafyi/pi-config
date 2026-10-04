import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import modelRouter from "./index.ts";

const ENTRY_TYPE = "model-router-recommendation";
const models = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"].map((id) => ({
  id, provider: "openai-codex", input: ["text", "image"], reasoning: true,
  thinkingLevelMap: { off: id === "gpt-6-luna" ? "none" : null, minimal: "low", xhigh: "xhigh", max: "max" },
}));
const usage = { input: 300, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 320, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function response(context: any, model = "gpt-6-luna", effort = "low") {
  const option = Object.entries(context.questions.route.criteria).find(([_key, text]) => String(text).startsWith(`openai-codex/${model}, effort ${effort}.`));
  assert.ok(option, `Missing choice ${model}/${effort}`);
  return {
    api: "typesafe-system-one", provider: "typesafe", model: "jev-1.13.0", stopReason: "stop", timestamp: 1, usage,
    answers: {
      route: { type: "choice", choice: option[0], confidence: 1, probabilities: { [option[0]]: 1 } },
      reason: { type: "choice", choice: model === "gpt-6-astra" ? "escalation" : "focused", confidence: 1, probabilities: {} },
    },
  };
}

function setup(t: TestContext, config: unknown = { enabled: true }) {
  const directory = mkdtempSync(join(tmpdir(), "pi-router-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  writeFileSync(join(directory, "user-settings.json"), JSON.stringify({ extensions: { "model-router": config } }));
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const renderers = new Map<string, (...args: any[]) => any>();
  const entries: any[] = [];
  const notifications: { text: string; level: string }[] = [];
  const calls: any[] = [];
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "Previous task context", timestamp: 1 });
  const harness = {
    handlers, commands, renderers, entries, notifications, calls, session,
    classify: async (_model: any, context: any, _options: any) => response(context),
    ctx: {
      model: models[1], thinkingLevel: "medium", hasUI: true, mode: "tui", signal: undefined as AbortSignal | undefined,
      sessionManager: session,
      modelRegistry: {
        getAvailable: () => models,
        findOfType: () => ({ id: "jev-latest", provider: "typesafe" }),
        classify: async (...args: any[]) => {
          calls.push(args);
          return harness.classify(args[0], args[1], args[2]);
        },
      },
      ui: { notify: (text: string, level: string) => notifications.push({ text, level }) },
    },
    start: () => handlers.get("session_start")?.({}, harness.ctx),
    input: (text: string, patch: Record<string, unknown> = {}) => handlers.get("input")?.({ text, source: "interactive", ...patch }, harness.ctx),
    command: (text: string) => commands.get("router")!.handler(text, harness.ctx),
    install: () => modelRouter(pi as any),
  };
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => any) => { handlers.set(event, handler); return () => handlers.delete(event); },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerEntryRenderer: (type: string, renderer: any) => renderers.set(type, renderer),
    appendEntry: (type: string, data: unknown) => {
      const id = session.appendCustomEntry(type, data);
      entries.push(session.getEntry(id));
    },
    setModel: () => { throw new Error("Advisor must not switch models"); },
    setThinkingLevel: () => { throw new Error("Advisor must not change thinking"); },
    sendMessage: () => { throw new Error("Advisor must not inject model context"); },
  };
  harness.install();
  harness.start();
  return harness;
}

test("automatic recommendations never change the prompt, model, thinking, or model context", async (t) => {
  const h = setup(t);
  const before = h.session.buildSessionContext().messages;
  const modelBefore = h.ctx.model;
  const result = await h.input("Fix a typo in the README");
  assert.equal(result, undefined);
  assert.equal(h.calls.length, 1);
  assert.equal(h.entries.length, 1);
  const entry = h.entries[0];
  assert.equal(entry.type, "custom");
  assert.equal(entry.customType, ENTRY_TYPE);
  assert.equal(entry.data.recommendation.model, "gpt-6-luna");
  assert.equal(entry.data.recommendation.thinkingLevel, "low");
  assert.equal(entry.data.display, true);
  assert.equal(h.ctx.model, modelBefore);
  assert.equal(h.ctx.thinkingLevel, "medium");
  assert.deepEqual(h.session.buildSessionContext().messages, before);
  assert.equal(h.handlers.has("before_agent_start"), false);
  assert.equal(h.handlers.has("context"), false);
  assert.equal(h.handlers.has("tool_result"), false);
});

test("matching recommendations are retained for /router but hidden automatically", async (t) => {
  const h = setup(t);
  h.classify = async (_model, context) => response(context, "gpt-6.1-sol", "medium");
  await h.input("Implement a normal feature");
  assert.equal(h.entries[0].data.display, false);
  const theme = { fg: (_color: string, text: string) => text };
  assert.equal(h.renderers.get(ENTRY_TYPE)!(h.entries[0], { expanded: false }, theme), undefined);
  await h.command("");
  assert.match(h.notifications.at(-1)!.text, /Last recommendation/);
  assert.match(h.notifications.at(-1)!.text, /gpt-6.1-sol \/ medium/);
});

test("thinking-only differences are displayed and renderer fits narrow widths", async (t) => {
  const h = setup(t);
  h.classify = async (_model, context) => response(context, "gpt-6.1-sol", "high");
  await h.input("Investigate conflicting evidence");
  assert.equal(h.entries[0].data.display, true);
  const theme = { fg: (_color: string, text: string) => text };
  for (const expanded of [false, true]) {
    const component = h.renderers.get(ENTRY_TYPE)!(h.entries[0], { expanded }, theme);
    for (const width of [10, 30, 80]) assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
    component.invalidate();
  }
});

test("acknowledgements, slash commands, extension input, and non-UI runs do not classify", async (t) => {
  const h = setup(t);
  for (const text of ["давай", "окей", "continue", "", "/plan", "/skill:review task"]) await h.input(text);
  await h.input("Execute this task", { source: "extension" });
  h.ctx.hasUI = false;
  await h.input("Real task in print mode");
  assert.equal(h.calls.length, 0);
  assert.equal(h.entries.length, 0);
});

test("missing or invalid configuration makes no classifier calls", async (t) => {
  const h = setup(t, undefined);
  // Explicitly remove the section: setup's default parameter otherwise supplies it.
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "user-settings.json"), "{}");
  h.start();
  await h.input("Implement a feature");
  await h.command("on");
  assert.equal(h.calls.length, 0);
  assert.match(h.notifications.at(-1)!.text, /valid extensions.model-router/);
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "user-settings.json"), JSON.stringify({ extensions: { "model-router": { enabled: "invalid" } } }));
  h.start();
  await h.input("Implement a feature");
  assert.equal(h.calls.length, 0);
});

test("on/off are session-only and explicit checks work while automatic advice is off", async (t) => {
  const h = setup(t);
  await h.command("off");
  await h.input("Fix a typo");
  assert.equal(h.calls.length, 0);
  await h.command("check Fix a typo");
  assert.equal(h.calls.length, 1);
  assert.equal(h.entries[0].data.display, true);
  await h.command("on");
  await h.input("Fix another typo");
  assert.equal(h.calls.length, 2);
});

test("errors and unknown choices fail open without leaking provider error bodies", async (t) => {
  const h = setup(t);
  h.classify = async () => { throw new Error("SECRET_PROVIDER_RESPONSE"); };
  assert.equal(await h.input("Fix a typo"), undefined);
  assert.equal(h.entries.length, 0);
  assert.match(h.notifications.at(-1)!.text, /unavailable/);
  assert.doesNotMatch(h.notifications.at(-1)!.text, /SECRET/);
  await h.command("status");
  assert.match(h.notifications.at(-1)!.text, /latest check failed/);
  await h.handlers.get("session_tree")?.({}, h.ctx);
  await h.command("status");
  assert.doesNotMatch(h.notifications.at(-1)!.text, /latest check failed/);
  h.classify = async (_model, context) => ({ ...response(context), answers: { route: { type: "choice", choice: "made_up" } } } as any);
  assert.equal(await h.input("Another task"), undefined);
  assert.equal(h.entries.length, 0);
});

test("hard timeout does not wait for a classifier that ignores AbortSignal", async (t) => {
  const h = setup(t, { enabled: true, timeoutMs: 100 });
  h.classify = () => new Promise(() => {});
  await h.input("Investigate a failure");
  assert.equal(h.entries.length, 0);
  assert.match(h.notifications.at(-1)!.text, /unavailable/);
});

test("a newer input invalidates stale results even if the old classifier finishes late", async (t) => {
  const h = setup(t);
  let resolveOld!: (result: any) => void;
  let oldContext: any;
  h.classify = (_model, context) => { oldContext = context; return new Promise((resolve) => { resolveOld = resolve; }); };
  const old = h.input("An old task");
  h.classify = async (_model, context) => response(context, "gpt-6-astra", "high");
  await h.input("A new demanding task");
  resolveOld(response(oldContext));
  await old;
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.recommendation.model, "gpt-6-astra");
});

test("session lifecycle and off cancel pending recommendations", async (t) => {
  const h = setup(t);
  for (const action of ["session_start", "session_tree", "model_select", "session_shutdown", "off"]) {
    await h.command("on");
    let complete!: (result: any) => void;
    let context: any;
    h.classify = (_model, input) => { context = input; return new Promise((resolve) => { complete = resolve; }); };
    const pending = h.input("A task awaiting classification");
    if (action === "off") await h.command("off");
    else await h.handlers.get(action)?.({}, h.ctx);
    complete(response(context));
    await pending;
  }
  assert.equal(h.entries.length, 0);
});

test("reload and tree navigation restore only the active branch's latest valid result", async (t) => {
  const h = setup(t);
  await h.input("Fix a typo");
  const firstId = h.entries[0].id;
  h.classify = async (_model, context) => response(context, "gpt-6-astra", "high");
  await h.input("A hard task");
  h.install();
  h.start();
  await h.command("status");
  assert.match(h.notifications.at(-1)!.text, /Last recommendation:\nModel recommendation: openai-codex\/gpt-6-astra/);
  h.session.branch(firstId);
  h.session.appendCustomEntry(ENTRY_TYPE, { recommendation: { version: 1 }, display: true });
  await h.handlers.get("session_tree")?.({}, h.ctx);
  await h.command("status");
  assert.match(h.notifications.at(-1)!.text, /Last recommendation:\nModel recommendation: openai-codex\/gpt-6-luna/);
});

test("RPC displays advice via notification without changing generation", async (t) => {
  const h = setup(t);
  h.ctx.mode = "rpc";
  await h.input("Fix a typo");
  assert.equal(h.entries.length, 1);
  assert.match(h.notifications.at(-1)!.text, /No settings changed/);
});
