import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease } from "@earendil-works/pi-tui";
import { loadExtensionSettings } from "../shared/user-settings.ts";
import { PredictionController } from "./controller.ts";
import { parseConfig, USAGE_ENTRY, type Config } from "./core.ts";
import { decorateEditor, isAcceptKey } from "./editor.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

export default function nextPrompt(pi: ExtensionAPI) {
  let config: Config | undefined;
  let repaint: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let installed: EditorFactory | undefined;
  let previous: EditorFactory | undefined;
  const controller = new PredictionController(() => repaint?.(), (message) => {
    if (!message.usage?.totalTokens) return;
    pi.appendEntry(USAGE_ENTRY, { provider: message.provider, model: message.model, usage: message.usage });
    repaint?.();
  });

  function clear() {
    controller.cancel();
  }

  pi.on("session_start", (_event, ctx) => {
    clear();
    unsubscribe?.();
    unsubscribe = undefined;
    repaint = undefined;
    if (installed && ctx.ui.getEditorComponent() === installed) ctx.ui.setEditorComponent(previous);
    installed = undefined;
    previous = undefined;
    config = ctx.mode === "tui" ? parseConfig(loadExtensionSettings("next-prompt")) : undefined;
    if (!config) return;
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data)) return;
      // Acceptance belongs to the focused editor; other input also cancels work during dialogs.
      if (!isAcceptKey(data) || !controller.suggestion) clear();
      return undefined;
    });
  });

  pi.on("resources_discover", (_event, ctx) => {
    if (!config || ctx.mode !== "tui" || installed) return;
    previous = ctx.ui.getEditorComponent();
    const base = previous;
    installed = (tui, theme, keybindings) => {
      const editor = base ? base(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
      repaint = () => tui.requestRender();
      decorateEditor(editor, () => controller.suggestion, clear, tui, (text) => ctx.ui.theme.fg("dim", text));
      return editor;
    };
    ctx.ui.setEditorComponent(installed);
  });

  pi.on("agent_settled", (event, ctx) => {
    if (config && !event.aborted) controller.request(ctx, config);
    else clear();
  });
  pi.on("agent_start", clear);
  pi.on("input", clear);
  pi.on("model_select", clear);
  pi.on("session_before_switch", clear);
  pi.on("session_before_tree", clear);
  pi.on("session_before_fork", clear);
  pi.on("session_before_compact", clear);
  pi.on("session_compact", clear);
  pi.on("ui_prompt_start", clear);
  pi.on("session_shutdown", (_event, ctx) => {
    clear();
    unsubscribe?.();
    unsubscribe = undefined;
    config = undefined;
    repaint = undefined;
    if (ctx.mode === "tui" && installed && ctx.ui.getEditorComponent() === installed) ctx.ui.setEditorComponent(previous);
    installed = undefined;
    previous = undefined;
  });
}
