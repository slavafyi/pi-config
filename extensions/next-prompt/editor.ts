import {
  CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth,
  type Editor, type EditorComponent, type TUI,
} from "@earendil-works/pi-tui";

type GhostCapableEditor = EditorComponent & Partial<Pick<Editor, "isShowingAutocomplete">>;

export function isAcceptKey(data: string): boolean {
  return matchesKey(data, "tab") || matchesKey(data, "right");
}

/** Decorate the same editor instance: keep its history, autocomplete, shortcuts and footer wrappers. */
export function decorateEditor(
  editor: GhostCapableEditor,
  getSuggestion: () => string | undefined,
  cancel: () => void,
  tui: Pick<TUI, "requestRender">,
  dim: (text: string) => string,
): void {
  const render = editor.render.bind(editor);
  const handleInput = editor.handleInput.bind(editor);
  const setText = editor.setText.bind(editor);
  const insert = editor.insertTextAtCursor?.bind(editor);
  let shown: string | undefined;
  // Unknown custom editors cannot promise that acceptance keys aren't owned by autocomplete.
  const eligible = () => editor.getText() === "" && editor.isShowingAutocomplete?.() === false;

  editor.render = (width) => {
    const lines = render(width);
    shown = undefined;
    const suggestion = eligible() ? getSuggestion() : undefined;
    if (!suggestion) return lines;
    const row = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    if (row < 0) return lines;
    const line = lines[row]!;
    const prefix = line.slice(0, line.indexOf(CURSOR_MARKER));
    const available = width - visibleWidth(prefix) - 1;
    if (available <= 0) return lines;
    const preview = truncateToWidth(suggestion, available, "…");
    const content = `${prefix}${CURSOR_MARKER}${renderFakeCursor(" ")}${dim(preview)}`;
    const result = [...lines];
    result[row] = content + " ".repeat(Math.max(0, width - visibleWidth(content)));
    shown = suggestion;
    return result;
  };

  editor.handleInput = (data) => {
    const suggestion = eligible() ? getSuggestion() : undefined;
    const accept = isAcceptKey(data) && suggestion && shown === suggestion && insert;
    shown = undefined;
    cancel();
    if (accept) insert(suggestion);
    else handleInput(data);
    tui.requestRender();
  };

  editor.setText = (text) => {
    if (text !== editor.getText()) {
      shown = undefined;
      cancel();
    }
    setText(text);
  };
  if (insert) editor.insertTextAtCursor = (text) => {
    shown = undefined;
    cancel();
    insert(text);
  };
}
