# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Built-in write tools blocked**: Blocks edit/write while preserving the provider tool prefix
- **Bash allowlist**: Only read-only bash commands are allowed
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Progress tracking**: Widget shows completion status during execution
- **[DONE:n] markers**: Explicit step completion tracking
- **Session persistence**: State survives session resume
- **Local completion history**: Completed plans remain visible without entering model context
- **Theme updates**: Footer status and progress widget follow theme changes

## Commands

- `/plan` - Toggle plan mode
- `/todos` - Show current plan progress
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Choose "Execute the plan" when prompted
5. During execution, the agent marks steps complete with `[DONE:n]` tags
6. Progress widget shows completion status

## How It Works

### Plan Mode (Read-Only)
- Built-in edit/write tools blocked at runtime
- Active tool definitions remain unchanged to preserve the provider prompt cache
- Bash commands filtered through allowlist
- Agent creates a plan without making changes

Mode state transitions are append-only so earlier provider prompt prefixes
remain cacheable. Repeated agent runs in the same state do not add duplicate
messages. A short, stable system instruction tells the model that the newest
state message supersedes earlier mode messages. That instruction is required;
without it, resumed sessions and mode changes can leave contradictory active
instructions in context.

### Execution Mode
- Plan-mode restrictions are inactive; the normal active-tool configuration applies
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress
- Completed plans render as TUI-only session entries

Streaming progress is scanned incrementally with a short per-text-block tail so
markers split across provider chunks are recognized without rescanning the full
response. Final messages and completed turns provide fallback detection.
Progress is persisted after tool results at `turn_end`.

The hidden normal-state transition is queued at the final `turn_end`, where Pi
flushes triggerless custom messages before any continuation queued by
`agent_end`. If that final event was not observed, `agent_end` queues the same
transition as a recovery path. The visible completion entry and cleared
execution state are then recorded at `agent_end`. On resume, state is restored
only from the active session branch, and completion markers are rescanned only
after that branch's latest execution marker.

### Command Allowlist

Safe commands (allowed):
- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
