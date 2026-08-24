import assert from "node:assert/strict";
import test from "node:test";

import footer from "./index.ts";

test("decorates an editor installed by a later session_start handler", async () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let editorFactory: ((tui: any, theme: any, keybindings: any) => any) | undefined;
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, handler);
    },
    exec: async () => ({ code: 0, stdout: "/work/pi-config\n", stderr: "" }),
    events: { emit: () => {} },
  };
  const theme = {
    fg: (_role: string, text: string) => text,
  };
  const footerData = {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map(),
    onBranchChange: () => () => {},
  };
  const ctx = {
    mode: "tui",
    cwd: "/work/pi-config",
    model: { id: "gpt-5.6-sol", contextWindow: 272_000 },
    thinkingLevel: "medium",
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [] },
    ui: {
      theme,
      setFooter: (factory: any) => {
        if (factory) factory({ requestRender: () => {} }, theme, footerData);
      },
      getEditorComponent: () => editorFactory,
      setEditorComponent: (factory: typeof editorFactory) => {
        editorFactory = factory;
      },
    },
  };

  footer(pi as any);
  const tmux = process.env.TMUX;
  delete process.env.TMUX;
  await handlers.get("session_start")?.({}, ctx);
  if (tmux !== undefined) process.env.TMUX = tmux;

  const autocompleteProvider = { name: "fff autocomplete" };
  const baseEditor = {
    marker: "fff",
    borderColor: (text: string) => text,
    render: (width: number) => ["─".repeat(width), "", "─".repeat(width)],
    setAutocompleteProvider: () => autocompleteProvider,
  };
  const fffFactory = () => baseEditor;
  editorFactory = fffFactory;

  handlers.get("resources_discover")?.({}, ctx);
  assert.notEqual(editorFactory, fffFactory);

  const editor = editorFactory?.({}, {}, {});
  assert.equal(editor, baseEditor);
  assert.equal(editor.marker, "fff");
  assert.equal(editor.setAutocompleteProvider(), autocompleteProvider);
  const lines = editor.render(80);
  assert.match(lines[0], /^─ pi-config:main ─+/);
  assert.ok(lines[0].endsWith(" gpt-5.6-sol/medium ─"));
  assert.equal(lines[0].length, 80);
});
