# Subagents Once

`subagents-once` is a Pi policy extension that makes delegation explicit and
short-lived. Subagent tools are unavailable to the parent model by default.
Running `/subagents-once` exposes `oracle` and `reviewer` for one parent run,
with at most one child call total.

The extension delegates through the public `pi-subagents` version 2 event
contract. `pi-subagents` remains responsible for child discovery, model and
thinking defaults, session creation, progress, cancellation, and usage
accounting.

## Requirements

The Pi configuration must load `pi-subagents`. Its raw `subagent` tool may be
inactive, but it must be registered as the backend health signal. The command
refuses to arm when the backend is missing.

The repository configuration currently:

- installs `git:github.com/nicobailon/pi-subagents`;
- filters out the package's skills and prompt templates;
- configures `oracle` with forked context;
- configures `reviewer` with fresh context;
- keeps unused builtin child roles disabled; and
- configures foreground execution and session-scoped artifacts in
  `../subagent/config.json`.

## Usage

Arm delegation before the parent prompt that may need it:

```text
/subagents-once
```

Arming does not add a footer status. If the next parent run starts a child, the
footer shows only that role while it is running:

```text
◎ oracle
```

or:

```text
◇ reviewer
```

The next parent run can call one role or neither:

```ts
oracle({
  task: "Challenge the assumptions in the authentication design.",
})
```

```ts
reviewer({
  task: "Review the current diff for correctness and missing tests.",
})
```

Optional overrides apply to one child call:

```ts
reviewer({
  task: "Review the current diff independently.",
  model: "openai-codex/gpt-5.6-terra",
  thinking: "high",
})
```

When `model` or `thinking` is omitted, `pi-subagents` resolves the configured
agent default. Model overrides must be exact `provider/model-id` names present
in Pi's model registry.

Calling `/subagents-once` again while already armed does not reset the call
counter. Non-empty command arguments are rejected.

## Lifecycle

```text
disabled --/subagents-once--> armed
armed --next parent prompt--> active run
active run --zero or one child call--> agent_settled
agent_settled --> disabled
```

On session start or reload, the extension:

1. checks whether the `subagent` backend tool is registered;
2. removes `subagent`, `subagent_wait`, `oracle`, and `reviewer` from the active
   model tool set;
3. clears its footer status; and
4. resets its in-memory state.

`/subagents-once` preserves unrelated active tools and adds only `oracle` and
`reviewer`. After `agent_settled`, both roles are removed even when neither was
called. Session replacement and reload also restore the disabled state.

`subagent_supervisor` and `intercom` are not disabled. They may still be needed
for child-to-parent coordination. The package's human-only `/run` command also
remains available outside this model-facing policy.

## Delegation rules

While armed, the extension adds three gates to the parent system prompt. The
parent evaluates them silently. All three must pass before delegation.

### 1. Necessity

Delegate only when the work cannot be handled reliably in the parent's current
context or requires a genuinely isolated, context-heavy investigation.

Local file reads, routine commands, and bounded implementation work normally
stay with the parent.

### 2. Independent value

The child must provide a distinct challenge or review function. It must not
repeat the parent's work or act as a second vote for reassurance.

### 3. Handoff readiness

The child must receive a narrow task containing:

- the exact question;
- relevant evidence, files, artifacts, or diff;
- decisions and constraints to preserve;
- the expected output; and
- an explicit advisory and non-writing boundary.

If any gate fails, the parent continues locally without announcing the gate
ceremony.

## Roles

| Tool | Use | Backend context |
| --- | --- | --- |
| `oracle` | Challenge direction, assumptions, contradictions, or decision drift before implementation. | `fork` |
| `reviewer` | Independently inspect an existing diff, implementation, plan, or specification. | `fresh` |

Every call creates a new persisted child session. The extension does not expose
resume, background execution, workflows, parallel children, or additional
roles.

The parent remains the only writer, integrator, and final decision-maker.
Oracle and reviewer prompts are advisory controls, not a security sandbox. A
child with `bash` can still mutate the workspace; strict command enforcement
requires a separate guard.

## Tool reference

Both tools accept the same parameters:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `task` | string | yes | Non-whitespace advisory task with evidence, constraints, and expected output. |
| `model` | string | no | Exact `provider/model-id` override. |
| `thinking` | enum | no | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |

The model cannot select the backend agent, context mode, execution mode,
session, tools, acceptance policy, or workflow fields.

## Enforced policy

The extension enforces the objective boundaries in code:

- delegation must be armed;
- only `oracle` and `reviewer` are exposed;
- the first accepted role call consumes the one-call allowance;
- sibling role calls in the same tool batch are blocked sequentially;
- failed or cancelled children still consume the allowance;
- `task` must contain non-whitespace text;
- optional models must resolve exactly in Pi's model registry;
- role and context mappings are fixed;
- execution is foreground-only and always starts a new child;
- progress and bounded metadata are returned to the parent;
- nested model usage contributes to Pi's session totals; and
- cancellation uses the full version 2 request identity.

Semantic value remains the parent's judgment. The extension does not attempt to
infer whether the three gates passed from keywords in the task.

## Installation

The source lives at:

```text
configs/pi/.config/pi/agent/extensions/subagents-once/
```

GNU Stow installs it at:

```text
~/.config/pi/agent/extensions/subagents-once/
```

Apply the Pi component through the repository installer:

```bash
./install.sh setup_pi
```

Do not create the symlink manually.

## Validation

Run the formatter check:

```bash
pnpm dlx oxfmt@latest --check \
  configs/pi/.config/pi/agent/extensions/subagents-once/index.ts
```

Run the built-in policy self-check without loading other extensions:

```bash
PI_SUBAGENTS_ONCE_SELF_TEST=1 \
  pi --no-session --no-extensions \
  -e configs/pi/.config/pi/agent/extensions/subagents-once/index.ts \
  --list-models >/dev/null
```

For a smoke test:

1. start Pi and confirm no `subagent`, `oracle`, or `reviewer` tool is active;
2. run `/subagents-once` and confirm no child status appears yet;
3. run a local task and confirm no child launches when the gates fail;
4. arm again and request `oracle`; confirm only `◎ oracle` appears while the
   foreground forked child runs;
5. arm again and request `reviewer`; confirm only `◇ reviewer` appears while the
   fresh child runs; and
6. confirm each status clears after its child finishes and the tools disappear
   after settlement and `/reload`.
