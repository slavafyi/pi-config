import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  calculateSessionStats,
  classifyStatuses,
  normalizeKnownStatuses,
  parseFooterConfig,
  projectName,
  renderEditorTopBorder,
  renderFooter,
  subscribeToBranchChanges,
  type ContextLike,
  type FooterRole,
  type SessionEntryLike,
} from "./core.ts";
import { emitFooterInvalidate } from "./events.ts";

function loadConfig() {
  const codingAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (!codingAgentDir) return parseFooterConfig(undefined);
  try {
    return parseFooterConfig(
      JSON.parse(readFileSync(join(codingAgentDir, "footer.json"), "utf8")),
    );
  } catch {
    return parseFooterConfig(undefined);
  }
}

export default function footer(pi: ExtensionAPI) {
  let generation = 0;
  let cleanup: (() => void) | undefined;
  let editorState: {
    project: string;
    inGit: boolean;
    inTmux: boolean;
    getBranch: () => string | null;
  } | undefined;

  function dispose() {
    cleanup?.();
    cleanup = undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    generation += 1;
    const currentGeneration = generation;
    dispose();
    if (ctx.mode !== "tui") return;

    const gitRoot = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
      timeout: 2_000,
    });
    if (currentGeneration !== generation) return;

    const inGit = gitRoot.code === 0 && Boolean(gitRoot.stdout.trim());
    const project = inGit ? projectName(gitRoot.stdout, ctx.cwd) : basename(ctx.cwd);
    const inTmux = Boolean(process.env.TMUX);
    const config = loadConfig();
    let getBranch: () => string | null = () => null;

    ctx.ui.setFooter((tui, theme, footerData) => {
      getBranch = () => footerData.getGitBranch();
      let disposed = false;
      const unsubscribe = subscribeToBranchChanges(footerData, () => tui.requestRender());
      const componentCleanup = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
      };
      cleanup = componentCleanup;

      const style = (text: string, role: FooterRole): string => {
        switch (role) {
          case "agent-running":
            return theme.fg("accent", text);
          case "agent-queued":
          case "plan":
          case "warning":
            return theme.fg("warning", text);
          case "mcp-error":
          case "error":
            return theme.fg("error", text);
          default:
            return theme.fg("dim", text);
        }
      };

      return {
        dispose: componentCleanup,
        invalidate() {
          emitFooterInvalidate(pi.events);
        },
        render(width: number): string[] {
          const classified = classifyStatuses(footerData.getExtensionStatuses());
          const statuses = normalizeKnownStatuses(classified.known);
          const stats = calculateSessionStats(
            ctx.sessionManager.getEntries() as readonly SessionEntryLike[],
          );
          const contextUsage = ctx.getContextUsage();
          const context: ContextLike | undefined = contextUsage
            ? {
                tokens: contextUsage.tokens,
                contextWindow: contextUsage.contextWindow,
                percent: contextUsage.percent,
              }
            : ctx.model?.contextWindow
              ? { tokens: null, contextWindow: ctx.model.contextWindow, percent: null }
              : undefined;

          const lines = renderFooter(
            {
              statuses,
              metrics: {
                quota: statuses.usage,
                quotaStyled: statuses.usageStyled,
                cacheHitPercent: stats.cacheHitPercent,
                context,
                cost: stats.cost,
              },
              unknown: classified.unknown,
              showUnknownStatuses: config.showUnknownStatuses,
              style,
            },
            width,
            { visibleWidth, truncateToWidth },
          );
          return lines;
        },
      };
    });

    editorState = { project, inGit, inTmux, getBranch };
  });

  pi.on("resources_discover", (_event, ctx) => {
    const state = editorState;
    if (ctx.mode !== "tui" || !state) return;

    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = previous
        ? previous(tui, theme, keybindings)
        : new CustomEditor(tui, theme, keybindings);
      const render = editor.render.bind(editor);
      const borderColor = editor.borderColor ?? theme.borderColor;
      editor.render = (width: number): string[] => {
        const lines = render(width);
        if (lines.length === 0) return lines;
        lines[0] = renderEditorTopBorder(
          {
            project: state.project,
            branch: state.getBranch(),
            inGit: state.inGit,
            inTmux: state.inTmux,
            model: ctx.model?.id,
            thinking: ctx.thinkingLevel,
            style: (text) => ctx.ui.theme.fg("dim", text),
          },
          width,
          { visibleWidth, truncateToWidth },
          borderColor,
        );
        return lines;
      };
      return editor;
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    generation += 1;
    dispose();
    editorState = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
