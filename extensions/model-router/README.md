# Model Router

A recommendation-only model advisor. Jev suggests an available model and
thinking level; Pi's selected model, thinking, prompt, tools, and delegation
policy remain unchanged. No virtual model or automatic switching is registered.

## Use

Run `/reload` after installation or configuration changes. In TUI and RPC
sessions, substantive user input gets one bounded classification before normal
processing. The default deadline is two seconds. Classification failures warn
and let the original input continue unchanged.

The TUI shows the latest recommendation as one padded line above the editor:
`Suggested: gpt-6-luna / low`. It does not repeat the current selection from the
footer, and no recommendation cards are added to the transcript. Matching
recommendations also appear in this line. `/router` shows the explanation and
original model/thinking comparison. RPC still displays differing recommendations
through a notification.

The line is replaced on a successful check, cleared while checking or after a
failure, and hidden by `/router off` or session shutdown. `/router on`, reload,
and tree navigation restore the appropriate saved recommendation. Explicit
`/router check` displays its result even while automatic advice is off.

- `/router` or `/router status`: advisor state and the latest recommendation.
- `/router check <task>`: explicitly assess a task, including while automatic
  recommendations are off. Always displays the result.
- `/router on` / `/router off`: toggle automatic advice for the current session.
  These commands do not write configuration. Session start and `/reload` restore
  the configured setting.

Common English and Russian acknowledgements such as `continue`, `окей`, and
`продолжай` keep the previous recommendation without another classification.
Short substantive tasks are not skipped just because they are short. Slash
commands, extension-generated input, tool continuations, and non-UI runs do not
trigger automatic advice. Queued steering/follow-up input is assessed when it
is submitted, not again when delivered. Checks are cancelled on newer input,
model selection, session start/tree navigation, shutdown, or `/router off`.

## Configuration

The extension is inactive without a valid `extensions.model-router` section in
`$PI_CODING_AGENT_DIR/user-settings.json`. The repository enables it explicitly:

```json
{
  "extensions": {
    "model-router": {
      "enabled": true,
      "evaluator": {
        "type": "jev",
        "provider": "typesafe",
        "model": "jev-latest"
      },
      "timeoutMs": 2000
    }
  }
}
```

The evaluator defaults to `typesafe/jev-latest`. Set `TYPESAFE_API_KEY` in the
process that starts Pi, or use Pi's supported provider authentication. No keys
are stored in this extension's configuration. `timeoutMs` must be an integer
from 100 to 10,000. A timeout is a hard limit even if an evaluator ignores
cancellation; there are no automatic retries.

`profiles` optionally replaces the complete default list (one to eight entries):

```json
"profiles": [
  {
    "provider": "openai-codex",
    "model": "gpt-6.1-sol",
    "role": "Default model for substantive engineering where cost matters.",
    "useWhen": "Implementation, debugging, refactoring, planning, and review.",
    "avoidWhen": "A small focused task fits Luna, or exceptional judgment is required."
  }
]
```

Profiles must use `openai-codex`, have unique model IDs, and provide nonempty
`role`, `useWhen`, and `avoidWhen` strings of at most 2,000 characters each.
Only models in Pi's authenticated available catalog are offered. Thinking
levels come from Pi's capability API; the advisor omits `minimal` when it is
just an alias for `low`. Attached images filter out text-only candidates, but
image contents themselves are not classified. Image-only requests receive no
automatic recommendation.

### Default model profiles

- **GPT-6 Luna**: focused tasks, local edits, extraction, transformations, and
  known-approach execution. Higher effort can suit constrained multi-step work.
- **GPT-6.1 Sol**: the main option for substantive engineering, including complex
  tasks. Complexity, planning, or review alone does not require Astra.
- **GPT-6 Astra**: selective escalation for consequential novel decisions,
  demanding cross-system analysis, or unresolved substantive failures. It is
  not selected just because a task mentions architecture or several files.

The default role descriptions use OpenAI's
[model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection).
Effort is model-relative, not a universal capability tier. These descriptions
are heuristics, not measured guarantees that a model will finish a task better.

## Data and cost

Each evaluation sends the task text and up to four recent user/assistant text
excerpts to the configured classifier provider. The task keeps at most 8,000
characters and each history excerpt at most 1,600, preserving the beginning and
end. System prompts, custom messages, reasoning blocks, tool-call arguments,
tool-result messages, and images are excluded. User/assistant prose may still
contain sensitive information, including quoted tool output; it is not
redacted. Review the classifier provider's data policy before enabling advice.

The serialized classifier request, including model/effort descriptions, is
limited to 28,000 UTF-8 bytes. Oversized requests fail open without sending the
classification. Long tasks are assessed from excerpts, which can miss important
requirements. An explanation is a selected rationale category, not a generated
account of the classifier's internal reasoning or an accuracy guarantee.

Classifier calls can be billed separately from generation. Reported usage is
stored with the recommendation, and `/router` shows its token count. These
custom entries are not native Pi usage entries: classifier usage is **not added
to the footer or `/session` totals**. A timed-out/cancelled call may still be
billed without returning usage. Direct TypeSafe's catalog price may be absent;
a zero catalog cost must not be interpreted as free API access. API prices are
not a prediction of Codex subscription quota consumption.

Successful recommendations, original model/thinking, and reported usage are
stored as non-rendered custom session entries, not model-context messages. Prompt/history
excerpts are not duplicated into these entries. `/reload`, resume, and tree
navigation restore the latest valid recommendation on the active branch.
Turning the advisor off does not erase existing records. Recommendations do not
promise that switching a long conversation will be economical or compatible
with provider-native compaction artifacts.

## Extension boundaries

- `types.ts`: evaluator-neutral task, candidate, decision, and recommendation
  contracts.
- `profiles.ts`, `config.ts`: model roles, validated settings, and catalog
  capability filtering.
- `context.ts`, `core.ts`, `evaluate.ts`, `advisor.ts`: bounded context, decision
  validation, deadline/cancellation, and recommendation logic.
- `jev.ts`: the only Jev-specific implementation; uses Pi's classification API.
- `index.ts`: session lifecycle, commands, persistence, and presentation.

An evaluator implements `Evaluator.evaluate()` without changing the advisor.
A future virtual `auto` model can consume the same validated decision pipeline.
Neither additional evaluators nor automatic routing/prompt rewriting are
implemented here. The advisor does not alter the existing footer, quota
extension, plan mode, compaction, or subagent policy.

## Validation

Run sequentially to avoid parallel test workers:

```bash
pnpm exec node --test --test-concurrency=1 extensions/model-router/*.test.ts
pnpm typecheck
```

Tests use mocked classification, temporary settings, and real in-memory Pi
sessions. They do not call paid APIs. For a live check, use `/router check Fix a
README typo`, verify that both model and thinking remain unchanged, inspect
`/router`, then try `/router off` and `/router on`. Check the padded line above
the editor at narrow/wide widths, theme changes, and reload/resume.

## Model guidance sources

- [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection)
- [GPT-6 model and prompting guide](https://developers.openai.com/api/docs/guides/latest-model)
- [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)

Prompting guidance informs model roles but does not authorize changing the
user's prompts or safety boundaries. Community reports are hypotheses rather
than model capability guarantees; defaults should be evaluated on your tasks.
