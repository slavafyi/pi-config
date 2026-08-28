# Footer

A minimal Pi UI extension that customizes the editor's top border and replaces
the built-in footer with one responsive status line. It keeps all extension
statuses available through `footerData.getExtensionStatuses()` and leaves the
built-in working indicator and the `pi-subagents` agent widget unchanged.

## Format

The editor's top border shows the project and Git branch on the left and the
model and thinking level on the right:

```text
─ pi-config:main ───────────────────────────────── gpt-5.6-sol:fast/medium ─
```

Inside tmux, the project name is omitted but the Git branch remains:

```text
─ main ─────────────────────────────────────────── gpt-5.6-sol:fast/medium ─
```

The footer groups provider and runtime statuses on the left and session metrics
on the right:

```text
5h:96% ↺3h  7d:94% ↺5d13h  MCP:0/2    cache:98.1%  ctx:12%/272k  $1.134
```

A non-Git directory shows its folder name in the editor border outside tmux and
no project identifier inside tmux. A detached checkout uses `project:HEAD` or
`HEAD`. Branch changes update the editor border without a reload.

The footer recognizes these fixed status IDs:

- `usage`
- `mcp`
- `subagents`
- `plan-mode`

Known values are parsed and placed in fixed slots. The footer preserves the
canonical ANSI styling supplied by the owned `usage` and `plan-mode`
extensions whenever their displayed text does not need rewriting. On component
invalidation it emits the internal `footer:invalidate` event so those
extensions can rebuild their strings with the current theme. The footer does
not duplicate or override their color rules.

MCP and subagent statuses still require footer-side normalization because they
come from third-party extensions and change shape at narrower widths. For
subagents, the label stays dim, the running count uses accent, and the queued
suffix uses warning in all responsive forms (`agents:2+1q`, `A:2+1q`, or
`A2+1q`). For footer-owned context metrics, only the percentage uses warning
and error colors at the same thresholds as Pi's built-in footer; the label and
context-window size stay dim.

Unknown extension statuses are hidden by default. To show their sanitized
values on a separate second line, enable the footer section in
`$PI_CODING_AGENT_DIR/user-settings.json` and run `/reload`:

```json
{
  "extensions": {
    "footer": {
      "showUnknownStatuses": true
    }
  }
}
```

When enabled, unknown statuses are separated by two spaces. The second line is
absent when there are no unknown statuses.

## Session metrics

The left block starts with the subscription quotas supplied by `usage`. The
right block includes:

- the latest assistant message's prompt-cache hit rate;
- context usage from Pi's public context API;
- total session cost, including assistant messages, tool results with usage,
  compactions, and branch summaries.

After compaction, unknown context usage appears as `ctx:?/272k` until Pi receives
a new model response.

## Responsive behavior

Both layouts select variants by measured terminal width instead of fixed
breakpoints. The editor border progressively shortens thinking, project, and
model labels. The footer progressively rounds metrics, shortens agent, MCP,
plan, cache, and context labels, then removes healthy or lower-priority metrics.
`visibleWidth()` ignores preserved and generated ANSI sequences, and final
ANSI-safe truncation guarantees that no rendered line exceeds the available
width.

Active plan mode, running or queued agents, MCP errors, low-quota reset times,
and critical context usage have priority over optional details. At extremely
small widths, the terminal width is still the final limit.

Use `/reload` after changing the extension. Verify editor input and shortcuts,
tmux, branch changes, model and thinking changes, MCP, subagents, plan mode,
terminal resizing, and both light and dark themes in a real TUI.
