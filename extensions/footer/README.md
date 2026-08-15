# Footer

A minimal custom Pi footer that replaces the built-in footer with one responsive
status line. It keeps all extension statuses available through
`footerData.getExtensionStatuses()` and leaves the `pi-subagents` agent widget
unchanged.

## Format

At a wide terminal width, the first line has left- and right-aligned blocks:

```text
pi-config:main  gpt-5.6-sol:fast • medium  MCP:0/2  agents:2  ⏸ plan    7d:94% ↺5d13h • cache:98.1% ↺4:23 • ctx:12%/272k • $1.134
```

Inside tmux, the project name is omitted but the Git branch remains:

```text
git:main  gpt-5.6-sol:fast • medium  MCP:0/2  agents:2  ⏸ plan    7d:94% ↺5d13h • cache:98.1% ↺4:23 • ctx:12%/272k • $1.134
```

A non-Git directory shows its folder name outside tmux and no project identifier
inside tmux. A detached checkout uses `project:detached` or `git:detached`.
Branch changes update the footer without a reload.

The footer recognizes these fixed status IDs:

- `usage`
- `cache-timer`
- `mcp`
- `subagents`
- `plan-mode`

Known values are parsed and placed in fixed slots. The footer preserves the
canonical ANSI styling supplied by the owned `usage`, `cache-timer`, and
`plan-mode` extensions whenever their displayed text does not need rewriting.
This retains dynamic cache and quota colors without duplicating their rules.
The cache reset marker is inserted inside the timer's preserved style, so
`↺0:30` changes color as one unit.

MCP and subagent statuses still require footer-side normalization because they
come from third-party extensions and change shape at narrower widths. For
subagents, the label stays dim, the running count uses accent, and the queued
suffix uses warning in all responsive forms (`agents:2+1q`, `A:2+1q`, or
`A2+1q`). Footer-owned context metrics use warning and error colors at the same
thresholds as Pi's built-in footer; the rest of the footer stays dim.

Unknown extension statuses are hidden by default. To show their sanitized
values on a separate second line, enable the footer-specific setting in
`$PI_CODING_AGENT_DIR/footer.json` and run `/reload`:

```json
{
  "showUnknownStatuses": true
}
```

When enabled, unknown statuses are separated by two spaces. The second line is
absent when there are no unknown statuses.

## Session metrics

The right block includes:

- the subscription quota supplied by `usage`;
- the latest assistant message's prompt-cache hit rate;
- the cache expiry supplied by `cache-timer`;
- context usage from Pi's public context API;
- total session cost, including assistant messages, tool results with usage,
  compactions, and branch summaries.

After compaction, unknown context usage appears as `ctx:?/272k` until Pi receives
a new model response.

## Responsive behavior

The layout selects the first variant that fits the measured terminal width. It
does not use fixed breakpoints. It progressively rounds metrics, shortens agent,
MCP, plan, thinking, cache, context, project, and model labels, then removes
healthy or lower-priority metrics. `visibleWidth()` ignores preserved and
footer-generated ANSI sequences, and a final ANSI-safe truncation guarantees
that no rendered line exceeds the available width.

Active plan mode, running or queued agents, MCP errors, low-quota reset times,
and critical context usage have priority over optional details. At extremely
small widths, the terminal width is still the final limit.

Use `/reload` after changing the extension. Verify tmux, branch changes, MCP,
subagents, plan mode, terminal resizing, and both light and dark themes in a
real TUI.
