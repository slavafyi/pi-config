import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
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
  const notificationWaiters: (() => void)[] = [];
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
      ui: {
        notify: (text: string, level: string): void => {
          notifications.push({ text, level });
          for (const resolve of notificationWaiters.splice(0)) resolve();
        },
        setWidget: () => { throw new Error("Advisor must not install a widget"); },
      },
    },
    start: () => handlers.get("session_start")?.({}, harness.ctx),
    input: (text: string, patch: Record<string, unknown> = {}) => handlers.get("input")?.({ text, source: "interactive", ...patch }, harness.ctx),
    deliverUser: async (text: string) => {
      const message = { role: "user" as const, content: text, timestamp: 1 };
      await handlers.get("message_start")?.({ message }, harness.ctx);
      // Real Pi persists a message after its message_end extension hooks.
      session.appendMessage(message);
    },
    startAssistant: () => handlers.get("message_start")?.({ message: { role: "assistant", content: [] } }, harness.ctx),
    submit: async (text: string, patch: Record<string, unknown> = {}) => {
      const result = await harness.input(text, patch);
      await harness.deliverUser(text);
      await harness.startAssistant();
      await settle();
      return result;
    },
    waitForNotification: () => new Promise<void>((resolve) => notificationWaiters.push(resolve)),
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

test("completed background advice waits until the user message is persisted", async (t) => {
  const h = setup(t);
  const before = h.session.buildSessionContext().messages;
  const modelBefore = h.ctx.model;
  assert.equal(h.input("Fix a typo in the README"), undefined);
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.entries.length, 0);
  assert.deepEqual(h.session.buildSessionContext().messages, before);
  await h.deliverUser("Fix a typo in the README");
  assert.equal(h.entries.length, 0);
  const withUser = h.session.buildSessionContext().messages;
  await h.startAssistant();
  assert.equal(h.entries.length, 1);
  const entry = h.entries[0];
  assert.equal(entry.data.recommendation.model, "gpt-6-luna");
  assert.equal(entry.data.recommendation.thinkingLevel, "low");
  assert.equal(entry.data.display, true);
  const branch = h.session.getBranch();
  assert.equal(branch.at(-2)?.type, "message");
  assert.equal(branch.at(-1)?.id, entry.id);
  assert.deepEqual(h.session.buildSessionContext().messages, withUser);
  assert.equal(h.ctx.model, modelBefore);
  assert.equal(h.ctx.thinkingLevel, "medium");
  assert.equal(h.handlers.has("context"), false);
  assert.equal(h.handlers.has("tool_result"), false);
});

test("slow classification never blocks user delivery or the start of generation", async (t) => {
  const h = setup(t);
  let complete!: (result: any) => void;
  let context: any;
  const generation = new AbortController();
  h.ctx.signal = generation.signal;
  h.classify = (_model, input) => { context = input; return new Promise((resolve) => { complete = resolve; }); };
  assert.equal(h.input("Fix a typo"), undefined);
  await h.deliverUser("Fix a typo");
  await h.startAssistant();
  assert.equal(h.entries.length, 0);
  const modelContext = h.session.buildSessionContext().messages;
  generation.abort();
  complete(response(context));
  await settle();
  assert.equal(h.entries.length, 1);
  assert.deepEqual(h.session.buildSessionContext().messages, modelContext);
});

test("manual check waits for its explicitly requested result", async (t) => {
  const h = setup(t);
  let complete!: (result: any) => void;
  let context: any;
  let finished = false;
  h.classify = (_model, input) => { context = input; return new Promise((resolve) => { complete = resolve; }); };
  const command = h.command("check Fix a typo").then(() => { finished = true; });
  await settle();
  assert.equal(finished, false);
  complete(response(context));
  await command;
  assert.equal(h.entries.length, 1);
});

test("matching recommendations are saved after delivery without a card", async (t) => {
  const h = setup(t);
  h.classify = async (_model, context) => response(context, "gpt-6.1-sol", "medium");
  await h.submit("Implement a normal feature");
  assert.equal(h.entries[0].data.display, false);
  const theme = { fg: (_color: string, text: string) => text };
  assert.equal(h.renderers.get(ENTRY_TYPE)!(h.entries[0], {}, theme), undefined);
  await h.command("");
  assert.match(h.notifications.at(-1)!.text, /Last recommendation/);
});

test("status puts the selected pair on the Last recommendation line", async (t) => {
  const h = setup(t);
  await h.submit("Fix a typo");
  await h.command("status");
  const text = h.notifications.at(-1)!.text;
  assert.match(text, /Last recommendation: openai-codex\/gpt-6-luna \/ low/);
  assert.doesNotMatch(text, /Last recommendation:\s*\n/);
  assert.doesNotMatch(text, /Model recommendation:/);
});

test("old contradictory explanations are displayed as the chosen pair's current profile", async (t) => {
  const h = setup(t);
  await h.submit("Fix a typo");
  const recommendation = { ...h.entries[0].data.recommendation, thinkingLevel: "off", explanation: "Substantive engineering within an understood system; stronger model escalation is not inherently required." };
  const id = h.session.appendCustomEntry(ENTRY_TYPE, { recommendation, display: true });
  const stored = h.session.getEntry(id)!;
  h.start();
  await h.command("status");
  const text = h.notifications.at(-1)!.text;
  assert.match(text, /Model profile: Efficient execution/);
  assert.match(text, /Effort profile: No reasoning needed/);
  assert.doesNotMatch(text, /Substantive engineering/);
  const component = h.renderers.get(ENTRY_TYPE)!(stored, {}, { fg: (_color: string, value: string) => value });
  assert.doesNotMatch(component.render(100).join("\n"), /Substantive engineering/);
  assert.equal((stored as any).data.recommendation.explanation, recommendation.explanation);
});

test("cards wrap within padded margins and do not duplicate the current-model label", async (t) => {
  const h = setup(t);
  h.classify = async (_model, context) => response(context, "gpt-6.1-sol", "high");
  await h.submit("Investigate conflicting evidence");
  const theme = { fg: (_color: string, text: string) => text };
  const renderer = h.renderers.get(ENTRY_TYPE)!;
  const component = renderer(h.entries[0], {}, theme);
  const wide = component.render(80);
  assert.match(wide.join("\n"), /Model recommendation: gpt-6.1-sol \/ high/);
  assert.doesNotMatch(wide.join("\n"), /Current|No settings changed/);
  for (const width of [10, 30, 80]) {
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width);
      assert.ok(line.startsWith(" ") && line.endsWith(" "));
    }
  }
  const changed = renderer(h.entries[0], {}, { fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[0m` });
  assert.match(changed.render(80).join("\n"), /\u001b\[32m/);
});

test("acknowledgements, slash commands, extension input, and non-UI runs do not classify", async (t) => {
  const h = setup(t);
  for (const text of ["давай", "окей", "continue", "вот вот", "ну типа", "хах", "", "/plan", "/skill:review task"]) await h.submit(text);
  await h.submit("Execute this task", { source: "extension" });
  h.ctx.hasUI = false;
  await h.submit("Real task in print mode");
  assert.equal(h.calls.length, 0);
  assert.equal(h.entries.length, 0);
});

test("missing or invalid configuration makes no classifier calls", async (t) => {
  const h = setup(t);
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "user-settings.json"), "{}");
  h.start();
  await h.submit("Implement a feature");
  await h.command("on");
  assert.equal(h.calls.length, 0);
  assert.match(h.notifications.at(-1)!.text, /valid extensions.model-router/);
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "user-settings.json"), JSON.stringify({ extensions: { "model-router": { enabled: "invalid" } } }));
  h.start();
  await h.submit("Implement a feature");
  assert.equal(h.calls.length, 0);
});

test("explicit checks show immediately while automatic advice is off", async (t) => {
  const h = setup(t);
  await h.command("off");
  await h.submit("Fix a typo");
  assert.equal(h.calls.length, 0);
  const context = h.session.buildSessionContext().messages;
  await h.command("check Fix a typo");
  assert.equal(h.calls.length, 1);
  assert.equal(h.entries[0].data.display, true);
  assert.deepEqual(h.session.buildSessionContext().messages, context);
  await h.command("on");
  await h.submit("Fix another typo");
  assert.equal(h.calls.length, 2);
});

test("errors and unknown choices fail open without leaking provider error bodies", async (t) => {
  const h = setup(t);
  h.classify = async () => { throw new Error("SECRET_PROVIDER_RESPONSE"); };
  assert.equal(await h.submit("Fix a typo"), undefined);
  assert.equal(h.entries.length, 0);
  assert.match(h.notifications.at(-1)!.text, /unavailable/);
  assert.doesNotMatch(h.notifications.at(-1)!.text, /SECRET/);
  await h.command("status");
  assert.match(h.notifications.at(-1)!.text, /latest check failed/);
  await h.handlers.get("session_tree")?.({}, h.ctx);
  await h.command("status");
  assert.doesNotMatch(h.notifications.at(-1)!.text, /latest check failed/);
  h.classify = async (_model, context) => ({ ...response(context), answers: { route: { type: "choice", choice: "made_up" } } } as any);
  assert.equal(await h.submit("Another task"), undefined);
  assert.equal(h.entries.length, 0);
});

test("hard timeout does not wait for a classifier that ignores AbortSignal", async (t) => {
  const h = setup(t, { enabled: true, timeoutMs: 100 });
  h.classify = () => new Promise(() => {});
  const warned = h.waitForNotification();
  await h.submit("Investigate a failure");
  assert.equal(h.notifications.length, 0);
  await warned;
  assert.equal(h.entries.length, 0);
  assert.match(h.notifications.at(-1)!.text, /unavailable/);
});

test("a newer input invalidates unfinished evaluations without showing a stale card", async (t) => {
  const h = setup(t);
  let resolveOld!: (result: any) => void;
  let oldContext: any;
  h.classify = (_model, context) => { oldContext = context; return new Promise((resolve) => { resolveOld = resolve; }); };
  const old = h.input("An old task");
  h.classify = async (_model, context) => response(context, "gpt-6-astra", "high");
  await h.submit("A new demanding task");
  resolveOld(response(oldContext));
  await old;
  await h.deliverUser("An old task");
  await h.startAssistant();
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.recommendation.model, "gpt-6-astra");
});

test("lifecycle events and off cancel unfinished evaluations", async (t) => {
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
    await h.deliverUser("A task awaiting classification");
    await h.startAssistant();
  }
  assert.equal(h.entries.length, 0);
});

test("lifecycle events discard completed advice that has not yet been delivered", async (t) => {
  const h = setup(t);
  for (const action of ["session_start", "session_tree", "model_select", "session_shutdown", "off"]) {
    await h.command("on");
    h.input("A classified but undelivered task");
    await settle();
    if (action === "off") await h.command("off");
    else await h.handlers.get(action)?.({}, h.ctx);
    await h.deliverUser("A classified but undelivered task");
    await h.startAssistant();
  }
  assert.equal(h.entries.length, 0);
});

test("reload and tree navigation restore only the active branch's latest valid result", async (t) => {
  const h = setup(t);
  await h.submit("Fix a typo");
  const firstId = h.entries[0].id;
  h.classify = async (_model, context) => response(context, "gpt-6-astra", "high");
  await h.submit("A hard task");
  h.install();
  h.start();
  await h.command("status");
  assert.match(h.notifications.at(-1)!.text, /Last recommendation: openai-codex\/gpt-6-astra/);
  h.session.branch(firstId);
  h.session.appendCustomEntry(ENTRY_TYPE, { recommendation: { version: 1 }, display: true });
  await h.handlers.get("session_tree")?.({}, h.ctx);
  await h.command("status");
  assert.match(h.notifications.at(-1)!.text, /Last recommendation: openai-codex\/gpt-6-luna/);
  assert.equal(h.renderers.get(ENTRY_TYPE)!(h.session.getBranch().at(-1), {}, {}), undefined);
});

test("queued follow-up advice is attached to the matching message, not the running response", async (t) => {
  const h = setup(t);
  h.input("First task");
  await settle();
  h.classify = async (_model, context) => response(context, "gpt-6-astra", "high");
  h.input("Second task", { streamingBehavior: "followUp" });
  await settle();
  await h.deliverUser("First task");
  await h.startAssistant();
  await h.startAssistant();
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.recommendation.model, "gpt-6-luna");
  await h.deliverUser("Second task");
  await h.startAssistant();
  assert.equal(h.entries.length, 2);
  assert.equal(h.entries[1].data.recommendation.model, "gpt-6-astra");
});

test("batched user messages each retain their recommendation directly below them", async (t) => {
  const h = setup(t);
  h.input("First task");
  await settle();
  h.input("Second task", { streamingBehavior: "steer" });
  await settle();
  await h.deliverUser("First task");
  await h.deliverUser("Second task");
  await h.startAssistant();
  const branch = h.session.getBranch().slice(-4);
  assert.deepEqual(branch.map((entry) => entry.type), ["message", "custom", "message", "custom"]);
  assert.equal(h.entries.length, 2);
});

test("image-normalization hints do not break association with the user's original text", async (t) => {
  const h = setup(t);
  h.input("Fix the issue in this screenshot", { images: [{ type: "image", data: "ignored" }] });
  await settle();
  await h.deliverUser("Fix the issue in this screenshot\n\n[Image resized]");
  await h.startAssistant();
  assert.equal(h.entries.length, 1);
});

test("RPC emits advice after user delivery without changing generation", async (t) => {
  const h = setup(t);
  h.ctx.mode = "rpc";
  h.input("Fix a typo");
  await settle();
  assert.equal(h.notifications.length, 0);
  await h.deliverUser("Fix a typo");
  await h.startAssistant();
  assert.equal(h.entries.length, 1);
  assert.match(h.notifications.at(-1)!.text, /No settings changed/);
});
