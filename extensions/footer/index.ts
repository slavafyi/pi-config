import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  calculateSessionStats,
  classifyStatuses,
  normalizeKnownStatuses,
  projectName,
  renderFooter,
  subscribeToBranchChanges,
  type ContextLike,
  type SessionEntryLike,
} from "./core.js";

export default function footer(pi: ExtensionAPI) {
  let generation = 0;
  let cleanup: (() => void) | undefined;

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

    ctx.ui.setFooter((tui, theme, footerData) => {
      let disposed = false;
      const unsubscribe = subscribeToBranchChanges(footerData, () => tui.requestRender());
      const componentCleanup = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
      };
      cleanup = componentCleanup;

      return {
        dispose: componentCleanup,
        invalidate() {},
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
              project,
              branch: footerData.getGitBranch(),
              inGit,
              inTmux,
              model: ctx.model?.id,
              thinking: ctx.thinkingLevel,
              statuses,
              metrics: {
                quota: statuses.usage,
                cacheTimer: statuses.cacheTimer,
                cacheHitPercent: stats.cacheHitPercent,
                context,
                cost: stats.cost,
              },
              unknown: classified.unknown,
            },
            width,
            { visibleWidth, truncateToWidth },
          );
          return lines.map((line) =>
            truncateToWidth(theme.fg("dim", line), width, ""),
          );
        },
      };
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    generation += 1;
    dispose();
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
