import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { PredictionController } from "./controller.ts";

const config = { model: { provider: "openai-codex", id: "gpt-6-luna" } };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(timeoutMs = 1_000, usageMovesLeaf = false) {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const calls: { model: any; context: any; options: any }[] = [];
  const usage: any[] = [];
  const model = { provider: "openai-codex", id: "gpt-6-luna" };
  let available: any = model;
  let text = "";
  let session = "session-a";
  let leaf = "leaf-a";
  let idle = true;
  let pending = false;
  let branch: any[] = [{ id: "leaf-a", parentId: null, type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done. Tests pass." }], stopReason: "stop" } }];
  const ctx: any = {
    mode: "tui", model,
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    ui: { getEditorText: () => text },
    sessionManager: {
      getSessionId: () => session, getLeafId: () => leaf, getBranch: () => branch,
      getEntry: (id: string) => branch.find((entry) => entry.id === id),
    },
    modelRegistry: {
      find: () => available,
      streamSimple: (model: any, context: any, options: any) => {
        calls.push({ model, context, options });
        const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
        return { result: () => promise };
      },
    },
  };
  let changes = 0;
  const controller = new PredictionController(() => { changes++; }, (result) => {
    usage.push(result);
    if (usageMovesLeaf) {
      const id = `usage-${usage.length}`;
      branch.push({ id, parentId: leaf, type: "custom", customType: "next-prompt-usage" });
      leaf = id;
    }
  }, timeoutMs);
  const response = (content = "давай добавим тесты", stopReason: StopReason = "stop"): AssistantMessage => ({
    role: "assistant", api: "fixture", timestamp: Date.now(),
    content: [{ type: "text", text: content }], stopReason, provider: "openai-codex", model: "gpt-6-luna",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
  });
  return {
    ctx, controller, calls, usage, response, resolve: (r: any) => resolve(r), reject: (e: Error) => reject(e),
    resolver: () => resolve,
    setText: (v: string) => { text = v; }, setSession: (v: string) => { session = v; },
    setLeaf: (v: string) => { leaf = v; }, setIdle: (v: boolean) => { idle = v; },
    setPending: (v: boolean) => { pending = v; }, setBranch: (v: any[]) => { branch = v; },
    setAvailable: (v: any) => { available = v; }, changes: () => changes,
  };
}

test("one side request uses configured model, bounded data, no tools or shared session state", async () => {
  const f = fixture();
  f.controller.request(f.ctx, config);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].model.id, "gpt-6-luna");
  assert.equal(f.calls[0].options.transport, "sse");
  assert.equal(f.calls[0].options.sessionId, undefined);
  assert.equal(f.calls[0].options.reasoning, "minimal");
  assert.equal(f.calls[0].context.messages[0].role, "user");
  assert.ok(!JSON.stringify(f.calls[0].context).includes('"toolsAdded"'));
  f.resolve(f.response());
  await flush();
  assert.equal(f.controller.suggestion, "давай добавим тесты");
  assert.equal(f.usage.length, 1);
  assert.ok(f.changes() > 0);
});

test("does not request in non-TUI modes, while busy, queued, drafted or on failed replies", () => {
  for (const mode of ["rpc", "json", "print"]) {
    const f = fixture(); f.ctx.mode = mode; f.controller.request(f.ctx, config);
    assert.equal(f.calls.length, 0);
  }
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.setIdle(false),
    (f: ReturnType<typeof fixture>) => f.setPending(true),
    (f: ReturnType<typeof fixture>) => f.setText(" "),
    (f: ReturnType<typeof fixture>) => f.setAvailable(undefined),
    (f: ReturnType<typeof fixture>) => f.setBranch([{ type: "message", message: { role: "assistant", content: "error", stopReason: "error" } }]),
  ]) {
    const f = fixture(); change(f); f.controller.request(f.ctx, config); assert.equal(f.calls.length, 0);
  }
});

test("NO_PREDICTION and unsuccessful completions never become suggestions", async () => {
  for (const [text, reason] of [["NO_PREDICTION", "stop"], ["unfinished", "length"], ["error", "error"], ["cancelled", "aborted"]] as const) {
    const f = fixture(); f.controller.request(f.ctx, config); f.resolve(f.response(text, reason));
    await flush(); assert.equal(f.controller.suggestion, undefined); assert.equal(f.usage.length, 1);
  }
});

test("cancel aborts the request and rejects late output without injecting it", async () => {
  const f = fixture(); f.controller.request(f.ctx, config);
  f.controller.cancel(); assert.equal(f.calls[0].options.signal.aborted, true);
  f.resolve(f.response()); await flush(); assert.equal(f.controller.suggestion, undefined);
});

test("request deadline aborts stalled generation and ignores a late response", async () => {
  const f = fixture(15); f.controller.request(f.ctx, config);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.calls[0].options.signal.aborted, true);
  f.resolve(f.response()); await flush(); assert.equal(f.controller.suggestion, undefined);
});

test("late output is discarded after draft, leaf, session, active-model or idle state changes", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.setText("my own request"),
    (f: ReturnType<typeof fixture>) => f.setLeaf("leaf-b"),
    (f: ReturnType<typeof fixture>) => f.setSession("session-b"),
    (f: ReturnType<typeof fixture>) => { f.ctx.model = { provider: "other", id: "other" }; },
    (f: ReturnType<typeof fixture>) => f.setIdle(false),
    (f: ReturnType<typeof fixture>) => f.setPending(true),
  ]) {
    const f = fixture(); f.controller.request(f.ctx, config); change(f); f.resolve(f.response());
    await flush(); assert.equal(f.controller.suggestion, undefined);
  }
});

test("a newer request wins even when the older transport ignores abort", async () => {
  const f = fixture(); f.controller.request(f.ctx, config);
  const oldResolve = f.resolve;
  let secondResolve!: (value: any) => void;
  f.ctx.modelRegistry.streamSimple = (model: any, context: any, options: any) => {
    f.calls.push({ model, context, options });
    return { result: () => new Promise<any>((resolve) => { secondResolve = resolve; }) };
  };
  f.controller.request(f.ctx, config);
  oldResolve(f.response("old")); await flush(); assert.equal(f.controller.suggestion, undefined);
  secondResolve(f.response("new")); await flush(); assert.equal(f.controller.suggestion, "new");
});

test("late usage from an old request never invalidates a newer pending or visible prediction", async () => {
  for (const oldFirst of [true, false]) {
    const f = fixture(1_000, true);
    f.controller.request(f.ctx, config);
    const oldResolve = f.resolver();
    f.controller.request(f.ctx, config);
    const newResolve = f.resolver();
    if (oldFirst) {
      oldResolve(f.response("old")); await flush();
      assert.equal(f.controller.suggestion, undefined);
      newResolve(f.response("new")); await flush();
    } else {
      newResolve(f.response("new")); await flush();
      assert.equal(f.controller.suggestion, "new");
      oldResolve(f.response("old")); await flush();
    }
    assert.equal(f.usage.length, 2);
    assert.equal(f.controller.suggestion, "new");
  }
});

test("real Pi journal usage stays transparent, but messages, unrelated entries and branch changes invalidate", async () => {
  for (const oldFirst of [true, false]) {
    const f = fixture();
    const manager = SessionManager.inMemory("/tmp/next-prompt-journal-test");
    const root = manager.appendMessage({ role: "user", content: "original request", timestamp: Date.now() });
    manager.appendMessage({ ...f.response("Done."), role: "assistant", api: "fixture", timestamp: Date.now() });
    f.ctx.sessionManager = manager;
    const controller = new PredictionController(() => {}, (message) => {
      manager.appendCustomEntry("next-prompt-usage", { usage: message.usage });
    });
    controller.request(f.ctx, config); const oldResolve = f.resolver();
    controller.request(f.ctx, config); const newResolve = f.resolver();
    if (oldFirst) { oldResolve(f.response("old")); await flush(); }
    newResolve(f.response("new")); await flush();
    if (!oldFirst) { oldResolve(f.response("old")); await flush(); }
    assert.equal(controller.suggestion, "new");
    manager.appendCustomEntry("unrelated-context", {});
    assert.equal(controller.suggestion, undefined);
    controller.request(f.ctx, config); f.resolve(f.response("another")); await flush();
    assert.equal(controller.suggestion, "another");
    manager.appendMessage({ role: "user", content: "next request", timestamp: Date.now() });
    assert.equal(controller.suggestion, undefined);
    manager.branch(root);
    assert.equal(controller.suggestion, undefined);
    controller.cancel();
  }
});

test("provider failures are silent and leave the editor usable", async () => {
  const f = fixture(); f.controller.request(f.ctx, config); f.reject(new Error("provider unavailable"));
  await flush(); assert.equal(f.controller.suggestion, undefined);
  f.setText("normal input"); assert.equal(f.ctx.ui.getEditorText(), "normal input");
});
