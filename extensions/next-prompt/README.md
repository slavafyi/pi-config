# Next Prompt

A minimal Pi extension that predicts the next message you might type after
an agent run fully settles. It shows one dim suggestion in the empty editor.

- **Tab** or **→** inserts the whole visible suggestion; **Enter** sends it separately.
- Typing, pasting, Escape, or another action dismisses it. Deleting back to empty
  does not bring the old suggestion back.
- Autocomplete keeps priority. Without a visible suggestion, both keys work normally.
- The existing editor instance is decorated, preserving the footer, history,
  undo and application shortcuts. Unsupported custom editors keep normal input
  rather than accepting an invisible suggestion.
- The suggestion uses the conversation's language and style, not a fixed language.
- The model may reply `NO_PREDICTION` when it cannot confidently predict a message.

## Configuration

Add this to `user-settings.json` under `extensions`, then run `/reload`:

```json
"next-prompt": {
  "enabled": true,
  "model": {
    "provider": "openai-codex",
    "id": "gpt-6-luna"
  }
}
```

The model defaults to `openai-codex/gpt-6-luna` when omitted. Remove the section
or set `enabled` to `false` to disable the extension, then `/reload`.
No commands, keybinding menu, project indexing, Jev evaluation or special prompt
cache logic are added. There are no new dependencies.

## Requests and privacy

Every qualifying completed run makes **one extra model request**, including when
the model ultimately returns `NO_PREDICTION`. The configured provider receives
up to ten recent user/assistant text messages from the current branch, bounded
to 12,000 characters. Thinking, images, system instructions and raw tool results
are excluded; visible user/assistant text may still contain sensitive data.
The configured provider is used even if the main agent uses a different provider.

Only interactive TUI sessions generate suggestions. Aborted/error responses,
nonempty drafts and pending messages are skipped. The fixed deadline is ten
seconds, and output is limited to a single line of at most 240 code points.
Missing models, transport errors and invalid output silently omit the suggestion;
there is no automatic fallback model or extension retry loop.

Input and session/model/branch changes cancel pending work. Each reply is checked
against its source session and journal leaf before display. The request uses a
separate stateless SSE call, never the main Codex WebSocket conversation.
Neither unaccepted suggestions nor their prompts are appended to model context.

## Usage accounting

Pi's public extension context exposes a read-only session manager, so the extension
cannot append native usage entries. Returned usage is saved through `pi.appendEntry`
as a `next-prompt-usage` custom entry with model attribution, **not suggestion text**.
Our footer includes its cost without changing the main agent's cache-hit percentage.
Native Pi `/session` totals do not include these custom entries. Usage unavailable
from an interrupted request, or arriving after a session replacement, cannot be
reliably recorded through these public APIs.

## Development

```bash
mise exec -- pnpm check
```

Apply through the Stow step used by dotfiles' `setup_pi` (not handcrafted symlinks),
then `/reload`. Check Tab/Right/Enter, autocomplete, undo, history, footer, resize,
Russian/English, fullscreen and the hardware cursor in the TUI.
