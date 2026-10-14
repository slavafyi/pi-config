import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { decorateEditor } from "./editor.ts";

function fixture() {
  let suggestion: string | undefined = "давай добавим тесты";
  let renders = 0;
  const tui: any = { terminal: { rows: 24 }, requestRender: () => { renders++; } };
  const theme: any = {
    borderColor: (s: string) => s,
    selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s,
      description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s },
  };
  const keybindings = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.interrupt": { defaultKeys: "escape", description: "Interrupt" },
  });
  const editor = new CustomEditor(tui, theme, keybindings as any);
  editor.focused = true;
  editor.setPaddingX(1);
  const originalRender = editor.render.bind(editor);
  const originalHandleInput = editor.handleInput.bind(editor);
  let cancellations = 0;
  decorateEditor(editor, () => suggestion, () => { suggestion = undefined; cancellations++; }, tui,
    (s) => `\x1b[2m${s}\x1b[22m`);
  return { editor, originalRender, originalHandleInput, tui, theme,
    setSuggestion: (value: string | undefined) => { suggestion = value; },
    cancellations: () => cancellations, renders: () => renders };
}

test("renders ghost text without changing draft, borders, cursor marker or history", () => {
  const f = fixture();
  const before = f.originalRender(50);
  const after = f.editor.render(50);
  assert.equal(f.editor.getText(), "");
  assert.equal(after[0], before[0]);
  assert.equal(after.at(-1), before.at(-1));
  assert.equal(after.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
  assert.match(stripTerminalSequences(after[1]!), /давай добавим тесты/);
  assert.ok(after.every((line) => visibleWidth(line) <= 50));
  assert.ok(after[1]!.includes("\x1b[2m"));
});

test("Tab inserts the whole suggestion without submitting and undo restores empty input", () => {
  const f = fixture();
  let submissions = 0;
  f.editor.onSubmit = () => { submissions++; };
  f.editor.render(50);
  f.editor.handleInput("\t");
  assert.equal(f.editor.getText(), "давай добавим тесты");
  assert.equal(submissions, 0);
  f.editor.handleInput("\x1b[45;5u"); // Kitty ctrl+-: Pi's default undo binding.
  assert.equal(f.editor.getText(), "");
  assert.equal(f.editor.render(50).join("\n").includes("давай"), false);
});

test("Right inserts the whole visible suggestion without submitting, and undo restores empty input", () => {
  const f = fixture();
  let submissions = 0;
  f.editor.onSubmit = () => { submissions++; };
  f.editor.render(50);
  f.editor.handleInput("\x1b[C");
  assert.equal(f.editor.getText(), "давай добавим тесты");
  assert.equal(submissions, 0);
  f.editor.handleInput("\x1b[45;5u");
  assert.equal(f.editor.getText(), "");
});

test("Right preserves cursor movement in a nonempty draft and never accepts an unseen ghost", () => {
  const f = fixture();
  f.editor.handleInput("\x1b[C"); // Not rendered yet: no visible suggestion to accept.
  assert.equal(f.editor.getText(), "");
  f.editor.setText("abc");
  f.editor.handleInput("\x1b[D");
  assert.equal(f.editor.getCursor().col, 2);
  f.setSuggestion("new suggestion");
  f.editor.render(50);
  f.editor.handleInput("\x1b[C");
  assert.equal(f.editor.getCursor().col, 3);
  assert.equal(f.editor.getText(), "abc");
});

test("Enter never submits the unaccepted ghost", () => {
  const f = fixture();
  const submissions: string[] = [];
  f.editor.onSubmit = (text) => submissions.push(text);
  f.editor.render(50);
  f.editor.handleInput("\r");
  assert.ok(submissions.every((text) => text === ""));
  assert.equal(f.editor.getText(), "");
});

test("typing, Escape and paste dismiss ghost and preserve ordinary input behavior", () => {
  for (const input of ["x", "\x1b", "\x1b[200~pasted text\x1b[201~"]) {
    const f = fixture();
    f.editor.render(50); f.editor.handleInput(input);
    assert.ok(f.cancellations() > 0);
    assert.ok(!stripTerminalSequences(f.editor.render(50).join("\n")).includes("давай"));
    if (input === "x") assert.equal(f.editor.getText(), "x");
    if (input.includes("pasted")) assert.equal(f.editor.getText(), "pasted text");
  }
});

test("programmatic edits dismiss ghost, and deleting back to empty does not rearm it", () => {
  const f = fixture();
  f.editor.render(50);
  f.editor.setText("external edit");
  f.editor.setText("");
  assert.ok(!stripTerminalSequences(f.editor.render(50).join("\n")).includes("давай"));
  const g = fixture();
  g.editor.insertTextAtCursor("paste");
  assert.ok(g.cancellations() > 0);
});

test("autocomplete has priority over ghost and Tab reaches the original handler", () => {
  const f = fixture();
  let delegated = 0;
  const original = f.originalHandleInput;
  const base: any = {
    getText: () => "", render: f.originalRender,
    isShowingAutocomplete: () => true,
    handleInput: (data: string) => { delegated++; original(data); },
    setText: () => {}, insertTextAtCursor: () => {},
  };
  decorateEditor(base, () => "suggestion", () => {}, f.tui, (s) => s);
  assert.deepEqual(base.render(50), f.originalRender(50));
  base.handleInput("\t"); assert.equal(delegated, 1);
  base.handleInput("\x1b[C"); assert.equal(delegated, 2);
  assert.equal(f.editor.getText(), "");
});

test("Tab without ghost delegates to the existing editor; app Escape and history survive", () => {
  const f = fixture();
  f.setSuggestion(undefined);
  let escapes = 0;
  f.editor.onEscape = () => { escapes++; };
  f.editor.addToHistory("previous prompt");
  f.editor.handleInput("\x1b"); assert.equal(escapes, 1);
  f.editor.handleInput("\x1b[A"); assert.equal(f.editor.getText(), "previous prompt");
  f.editor.setText("own prompt"); f.editor.render(50); f.editor.handleInput("\t");
  assert.equal(f.editor.getText(), "own prompt");
});

test("ghost rendering is width-safe for Russian, English, emoji, CJK and combining characters", () => {
  const f = fixture();
  for (const text of ["Let's add tests.", "давай проверим сборку", "检查测试 🧪", "cafe\u0301"])
    for (const width of [1, 2, 3, 8, 20, 80]) {
      f.setSuggestion(text);
      const lines = f.editor.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `${text}: width ${width}`);
      assert.equal(f.editor.getText(), "");
    }
});

test("no ghost is painted or accepted without a visible focused editor", () => {
  const f = fixture(); f.editor.focused = false;
  assert.deepEqual(f.editor.render(50), f.originalRender(50));
  f.editor.handleInput("\t"); assert.equal(f.editor.getText(), "");
  f.editor.handleInput("\x1b[C"); assert.equal(f.editor.getText(), "");
});
