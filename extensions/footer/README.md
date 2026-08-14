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

Known values are normalized and placed in fixed slots. Other extension statuses
are sanitized and shown on a separate second line, separated by two spaces.
The second line is absent when there are no unknown statuses.

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
healthy or lower-priority metrics. A final ANSI-safe truncation guarantees that
no rendered line exceeds the available width.

Active plan mode, running or queued agents, MCP errors, low-quota reset times,
and critical context usage have priority over optional details. At extremely
small widths, the terminal width is still the final limit.

Use `/reload` after changing the extension. Verify tmux, branch changes, MCP,
subagents, plan mode, terminal resizing, and both light and dark themes in a
real TUI.
