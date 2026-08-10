# With Agents

`with-agents` is a small policy gate around
`@tintinweb/pi-subagents`. Tintinweb owns agent execution, persistence,
concurrency, resume, steering, transcripts, and UI. This extension only controls
when its three model-facing orchestration tools are active.

## Behavior

At session start, these tools are registered but hidden from the parent model:

- `Agent`
- `get_subagent_result`
- `steer_subagent`

Run the command before the prompt that may use subagents:

```text
/with-agents
```

The command shows a short toast and arms only the next user prompt. It does not
add a footer status, widget, renderer, or custom runtime. When that prompt
starts, all three orchestration tools become active and the parent receives the
validator policy. The parent may make zero, one, or several `Agent` calls.
Independent sibling calls can run in parallel.

After the parent run reaches `agent_settled`, the orchestration tools are hidden
again. Background agents are not stopped: Tintinweb continues running them and
shows its standard `● Agents`, activity, and running-agent count UI.

A later `/with-agents` can use `get_subagent_result`, `steer_subagent`, or
`Agent({ resume: "..." })` with agent IDs that Tintinweb still holds in its
manager.

`/tools` remains an explicit manual override. Enabling orchestration tools there
makes them available without arming or validator instructions until the user
turns them off or a new session restores the default hidden state.

## Policy

The parent silently evaluates three gates before every `Agent` call. If any
gate fails, it continues locally without announcing the decision:

1. **Necessity and context economy:** keep work local when the parent can
   reliably finish within its remaining context budget. Delegation is also
   justified when isolated independent execution or review is itself required.
   No fixed percentage threshold is used.
2. **Independent value:** delegate distinct work, not duplication or a
   reassurance vote. Sibling calls must be independent and non-overlapping.
3. **Handoff readiness:** provide a narrow task with evidence, files or
   artifacts, preserved constraints, and expected output. Use `reviewer` only
   after a concrete artifact exists.

At parent-run start, the validator receives a context snapshot from
`ctx.getContextUsage()`, including used and remaining tokens and percentages.
Immediately after compaction, Pi may temporarily report usage as unknown; the
validator says so rather than inventing a remainder.

After the gates pass, zero, one, or several calls are allowed. The parent also
chooses model, thinking, background mode, context inheritance, and isolation
per call, uses worktree isolation only when needed, and verifies agent-produced
changes before reporting completion.

No code-level call counter is added. Tintinweb provides parallel execution and
the configured concurrency limit.

## Roles

Only three global custom agents are enabled:

| Role | Purpose | Tools |
| --- | --- | --- |
| `general` | Autonomous worker for a narrow task | All seven built-in coding tools |
| `oracle` | Independent second opinion on direction and assumptions | `read`, `grep`, `find`, `ls` |
| `reviewer` | Independent review of a finished artifact | `read`, `bash`, `grep`, `find`, `ls` |

All profiles set `persist_session: true` and `extensions: false`, so their tool
lists are exact built-in allowlists. They do not pin model, thinking,
background mode, context inheritance, or filesystem isolation. `reviewer` may
use `bash` for tests but is instructed not to modify files.

Profiles live in the Tintinweb global agent directory:

```text
$PI_CODING_AGENT_DIR/agents/
```

In this repository that directory is installed from:

```text
configs/pi/.config/pi/agent/agents/
```

## Backend settings

Global `subagents.json` configures the backend:

```json
{
  "maxConcurrent": 4,
  "defaultJoinMode": "smart",
  "schedulingEnabled": false,
  "maxSubagentDepth": 1,
  "disableDefaultAgents": true,
  "fallbackSubagent": "none"
}
```

This gives background agents a four-run queue limit and smart joins. Built-in
agent types and permissive fallback are disabled. A nesting depth of one means
custom agents receive no nested orchestration tools. Disabling scheduling also
removes the `schedule` field from `Agent` on the next Pi session.

Tintinweb documents that foreground agents bypass `maxConcurrent`; use
background calls for bounded parallel fan-out.

## Resume limitation

`persist_session: true` stores each agent as a normal Pi session on disk, but
Tintinweb's `Agent({ resume: id })` currently resolves the ID through its
in-memory manager record. Completed records are cleaned up after ten minutes,
and manager state is lost when Pi restarts.

The session file remains on disk, but this configuration does not implement
automatic `agent ID → session file` discovery. Resume therefore works only
while the corresponding manager record remains in memory.

## Installation

`settings.json` loads:

```text
git:github.com/tintinweb/pi-subagents
```

The migration was verified against installed version `0.14.3` at commit
`2966cd5a33c0640de9698b56a39c11f83207a835`. The git package is intentionally
unpinned, so recheck its tool and settings API after upstream updates.

Apply the Pi component through GNU Stow from the repository root:

```bash
stow --dir configs --target "$HOME" --stow pi
```

Do not create symlinks manually.

## Validation

Run the state-machine test:

```bash
node --experimental-strip-types \
  configs/pi/.config/pi/agent/extensions/with-agents/contract-test.ts
```

Check formatting and extension loading:

```bash
pnpm dlx oxfmt@latest --check \
  configs/pi/.config/pi/agent/extensions/with-agents/index.ts \
  configs/pi/.config/pi/agent/extensions/with-agents/policy.ts \
  configs/pi/.config/pi/agent/extensions/with-agents/contract-test.ts

pi --no-extensions --no-session \
  -e configs/pi/.config/pi/agent/extensions/with-agents/index.ts \
  --list-models >/dev/null
```

Manual smoke test:

1. Start a new Pi session and confirm all three orchestration tools are hidden.
2. Run `/with-agents`; confirm only the toast appears.
3. Submit a prompt and confirm `Agent`, `get_subagent_result`, and
   `steer_subagent` are available during that run.
4. Start several independent background agents and confirm no more than four
   run concurrently and Tintinweb renders their standard UI.
5. Let the parent settle and confirm the tools disappear while background
   agents continue.
6. Arm again and resume or query an agent whose ID is still in manager memory.
