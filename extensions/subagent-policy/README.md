# Subagent Policy

`subagent-policy` adds stable orchestration guidance around
`@tintinweb/pi-subagents`. Tintinweb owns execution, persistence, concurrency,
resume, steering, transcripts, and UI. This extension does not register a
command, change the active tool set, or implement another orchestration runtime.

## Behavior

`Agent`, `get_subagent_result`, and `steer_subagent` remain available. The parent
silently evaluates three gates before every `Agent` call:

1. **Necessity and context economy:** delegate only when independent execution,
   review, or context isolation provides enough value.
2. **Independent value:** do not duplicate parent or sibling work.
3. **Handoff readiness:** provide a narrow, self-contained task with relevant
   evidence, constraints, and expected output. Review only a finished artifact.

Calling `Agent` is the model's self-attestation that all gates passed. These are
semantic policy checks, not a security boundary; the extension cannot prove
that a task is useful or non-overlapping.

The policy does not repeat the Agent tool's role list, general tool-selection
guidance, prompt-writing guidance, or result-verification guidance.

## Foreground and background

Tintinweb is configured with `backgroundByDefault: false`. Its generic Agent
tool description currently says that background execution is the default, so
the policy explicitly corrects that mismatch for this installation.

The policy requires every `Agent` call to set `run_in_background` explicitly:
use `false` when the parent must wait for the result, and `true` only for
long-running independent work the parent can continue without. The parent must
not duplicate the delegated scope, invent work merely to stay busy, or finalize
while a required result is uncollected. Smart join consolidates sibling
completion notifications.

Parallel writers require separate worktrees. Read-only agents and a sole writer
do not require worktree isolation.

## Cache behavior

The policy is appended to the system prompt with identical text on every parent
run. Context usage is appended only as a short temporary suffix through Pi's
`context` event, so changing usage does not rewrite the stable system prefix.

## Roles

| Role       | Purpose                                            | Tools                       |
| ---------- | -------------------------------------------------- | --------------------------- |
| `general`  | Autonomous worker for a narrow task                | All built-in coding tools   |
| `oracle`   | Independent challenge to direction and assumptions | Read-only tools             |
| `reviewer` | Independent review of a finished artifact          | Read-only tools plus `bash` |

Profiles live under `$PI_CODING_AGENT_DIR/agents/` and do not pin model,
thinking, execution mode, context inheritance, or isolation.

## Backend settings

`subagents.json` keeps background concurrency bounded while making foreground
the safe default:

```json
{
  "maxConcurrent": 4,
  "defaultJoinMode": "smart",
  "backgroundByDefault": false,
  "schedulingEnabled": false,
  "maxSubagentDepth": 1,
  "disableDefaultAgents": true,
  "fallbackSubagent": "none",
  "fleetView": false,
  "widgetMode": "background"
}
```

The fifth background agent queues. Foreground calls bypass this queue. Nesting
and scheduling remain disabled.

## Validation

```bash
pnpm check

pi --no-extensions --no-session \
  -e extensions/subagent-policy/index.ts \
  --list-models >/dev/null
```
