import assert from "node:assert/strict";
import test from "node:test";

import { stripAnsi } from "./core.ts";
import footer from "./index.ts";

for (const scenario of [
  { name: "origin name", origin: "git@example.com:team/repository.git", expected: "repository:main" },
  { name: "missing origin", expected: "pi-config:main" },
  { name: "Rex", rex: "session:test", expected: "main" },
  { name: "tmux", tmux: "/tmp/tmux/test", expected: "main" },
  { name: "non-Git cwd", nonGit: true, expected: "pi-config" },
  { name: "non-Git Rex", nonGit: true, rex: "session:test", expected: undefined },
]) {
  test(`decorates an editor installed by a later handler: ${scenario.name}`, async (t) => {
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    let editorFactory: ((tui: any, theme: any, keybindings: any) => any) | undefined;
    const pi = {
      on: (event: string, handler: (event: any, ctx: any) => any) => {
        handlers.set(event, handler);
      },
      exec: async (command: string, args: string[], options: any) => {
        assert.equal(command, "git");
        assert.equal(options.cwd, "/work/pi-config");
        if (args[0] === "rev-parse") {
          return { code: scenario.nonGit ? 128 : 0, stdout: scenario.nonGit ? "" : "/work/pi-config\n", stderr: "" };
        }
        assert.deepEqual(args, ["remote", "get-url", "origin"]);
        assert.ok(!scenario.nonGit);
        return { code: scenario.origin ? 0 : 2, stdout: scenario.origin ?? "", stderr: "" };
      },
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
    const saved = { TMUX: process.env.TMUX, REX_SESSION: process.env.REX_SESSION };
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    delete process.env.TMUX;
    delete process.env.REX_SESSION;
    if (scenario.tmux) process.env.TMUX = scenario.tmux;
    if (scenario.rex) process.env.REX_SESSION = scenario.rex;
    await handlers.get("session_start")?.({}, ctx);

    const autocompleteProvider = { name: "fff autocomplete" };
    const baseEditor = {
      marker: "fff",
      borderColor: (text: string) => `\x1b[2m${text}\x1b[0m`,
      render: (width: number) => ["─".repeat(width), "", "─".repeat(width)],
      setAutocompleteProvider: () => autocompleteProvider,
    };
    const fffFactory = () => baseEditor;
    editorFactory = fffFactory;

    handlers.get("resources_discover")?.({}, ctx);
    assert.notEqual(editorFactory, fffFactory);

    const editor = editorFactory?.({}, { borderColor: (text: string) => text }, {});
    assert.equal(editor, baseEditor);
    assert.equal(editor.marker, "fff");
    assert.equal(editor.setAutocompleteProvider(), autocompleteProvider);

    editor.borderColor = (text: string) => `\x1b[36m${text}\x1b[0m`;
    const lines = editor.render(80);
    const topBorder = stripAnsi(lines[0]);
    assert.match(lines[0], /^\x1b\[36m─\x1b\[0m/);
    if (scenario.expected) assert.ok(topBorder.startsWith(`─ ${scenario.expected} ─`), topBorder);
    else assert.match(topBorder, /^─+ /);
    assert.ok(topBorder.endsWith(" gpt-5.6-sol/medium ─"));
    assert.equal(topBorder.length, 80);
  });
}
