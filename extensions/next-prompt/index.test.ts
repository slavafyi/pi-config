import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import nextPrompt from "./index.ts";
import footer from "../footer/index.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(t: any, enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "pi-next-prompt-test-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  writeFileSync(join(directory, "user-settings.json"), JSON.stringify({ extensions: { "next-prompt": { enabled } } }));
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(directory, { recursive: true, force: true });
  });
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  let factory: any;
  let leaf = "leaf-a";
  let text = "";
  let calls = 0;
  let terminalInput: any;
  let unsubscribes = 0;
  const entries: any[] = [{ id: "leaf-a", parentId: null, type: "message", message: { role: "assistant", content: "Done.", stopReason: "stop" } }];
  let response: any = { content: [{ type: "text", text: "давай добавим тесты" }], stopReason: "stop", provider: "openai-codex", model: "gpt-6-luna", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.01 } } };
  let signal: AbortSignal | undefined;
  const pi: any = {
    on: (name: string, handler: any) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    appendEntry: (customType: string, data: any) => {
      const id = `leaf-${entries.length + 1}`;
      entries.push({ id, parentId: leaf, type: "custom", customType, data });
      leaf = id;
    },
    exec: async () => ({ code: 0, stdout: "/work/pi-config\n", stderr: "" }),
    events: { emit: () => {} },
  };
  const ctx: any = {
    mode: "tui", cwd: directory, model: { provider: "openai-codex", id: "gpt-6.1-sol" },
    isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: {
      getBranch: () => entries, getEntries: () => entries, getSessionId: () => "session-a", getLeafId: () => leaf,
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
    },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), streamSimple: (_model: any, _context: any, options: any) => {
      calls++; signal = options.signal; return { result: async () => response };
    } },
    getContextUsage: () => undefined,
    ui: {
      getEditorText: () => text, getEditorComponent: () => factory, setEditorComponent: (value: any) => { factory = value; },
      onTerminalInput: (handler: any) => { terminalInput = handler; return () => { terminalInput = undefined; unsubscribes++; }; },
      theme: { fg: (_role: string, value: string) => value },
      setFooter: () => {},
    },
  };
  const emit = async (name: string, event: any = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    await flush();
  };
  return { pi, ctx, entries, emit, calls: () => calls, getFactory: () => factory,
    setFactory: (value: any) => { factory = value; }, setText: (value: string) => { text = value; },
    setResponse: (value: any) => { response = value; }, signal: () => signal,
    input: (data: string) => terminalInput?.(data), unsubscribes: () => unsubscribes,
  };
}

test("only agent_settled triggers generation, and aborted/error runs are skipped", async (t) => {
  const f = fixture(t); nextPrompt(f.pi);
  await f.emit("session_start");
  await f.emit("agent_end"); assert.equal(f.calls(), 0);
  await f.emit("agent_settled", { aborted: true }); assert.equal(f.calls(), 0);
  await f.emit("agent_settled", { aborted: false }); assert.equal(f.calls(), 1);
  assert.equal(f.entries.filter((entry) => entry.type === "message").length, 1);
  assert.equal(f.entries.at(-1).customType, "next-prompt-usage");
  assert.ok(!JSON.stringify(f.entries.at(-1)).includes("давай"));
});

test("disabled and non-TUI sessions install nothing and never request", async (t) => {
  const f = fixture(t, false); nextPrompt(f.pi);
  await f.emit("session_start"); await f.emit("resources_discover"); await f.emit("agent_settled", { aborted: false });
  assert.equal(f.getFactory(), undefined); assert.equal(f.calls(), 0);
  writeFileSync(join(f.ctx.cwd, "user-settings.json"), JSON.stringify({ extensions: { "next-prompt": { enabled: true } } }));
  f.ctx.mode = "rpc";
  await f.emit("session_start"); await f.emit("resources_discover"); await f.emit("agent_settled", { aborted: false });
  assert.equal(f.getFactory(), undefined); assert.equal(f.calls(), 0);
});

test("wraps the existing editor and composes with footer without replacing its instance", async (t) => {
  const f = fixture(t); footer(f.pi); nextPrompt(f.pi);
  await f.emit("session_start");
  const tui = { terminal: { rows: 24 }, requestRender: () => {} };
  const { CustomEditor } = await import("@earendil-works/pi-coding-agent");
  const { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences } = await import("@earendil-works/pi-tui");
  const theme: any = { borderColor: (s: string) => s, selectList: {} };
  const editor = new CustomEditor(tui as any, theme, new KeybindingsManager(TUI_KEYBINDINGS) as any);
  editor.focused = true;
  f.ctx.ui.getEditorText = () => editor.getText();
  const oldFactory = () => editor;
  f.setFactory(oldFactory);
  await f.emit("resources_discover");
  const installed = f.getFactory();
  assert.notEqual(installed, oldFactory);
  assert.equal(installed(tui, theme, {}), editor);
  const before = editor.render(80);
  await f.emit("agent_settled", { aborted: false });
  const lines = editor.render(80);
  assert.equal(lines[0], before[0]);
  assert.equal(lines.at(-1), before.at(-1));
  assert.match(stripTerminalSequences(lines[0]!), /gpt-6\.1-sol/);
  assert.match(stripTerminalSequences(lines[1]!), /давай добавим тесты/);
  assert.ok(lines[1]!.includes(CURSOR_MARKER));
  editor.handleInput("\t"); assert.equal(editor.getText(), "давай добавим тесты");
  editor.setText("");
  await f.emit("agent_settled", { aborted: false });
  editor.render(80);
  f.input("\x1b[C"); // Global listener runs before the focused editor.
  editor.handleInput("\x1b[C");
  assert.equal(editor.getText(), "давай добавим тесты");
});

test("all session boundaries clear suggestions, and raw input cancels pending generation", async (t) => {
  const f = fixture(t); nextPrompt(f.pi); await f.emit("session_start");
  for (const event of ["agent_start", "input", "model_select", "session_before_switch", "session_before_tree", "session_before_fork", "session_before_compact", "session_compact", "ui_prompt_start"]) {
    let resolve!: (value: any) => void;
    f.ctx.modelRegistry.streamSimple = (_m: any, _c: any, options: any) => {
      f.ctx.lastSignal = options.signal;
      return { result: () => new Promise((r) => { resolve = r; }) };
    };
    await f.emit("agent_settled", { aborted: false });
    await f.emit(event);
    assert.equal(f.ctx.lastSignal.aborted, true, event);
    resolve({ content: [], stopReason: "stop" }); await flush();
  }
  await f.emit("agent_settled", { aborted: false });
  f.input("x"); assert.equal(f.ctx.lastSignal.aborted, true);
});

test("restart cleans listeners and repeated resource discovery does not stack factories", async (t) => {
  const f = fixture(t); nextPrompt(f.pi);
  await f.emit("session_start"); await f.emit("resources_discover");
  const installed = f.getFactory();
  await f.emit("resources_discover"); assert.equal(f.getFactory(), installed);
  await f.emit("session_start"); assert.equal(f.unsubscribes(), 1);
  await f.emit("resources_discover");
  await f.emit("session_shutdown"); assert.equal(f.unsubscribes(), 2);
  assert.equal(f.getFactory(), undefined);
});
