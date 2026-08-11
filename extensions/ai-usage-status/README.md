# AI usage status

This Pi extension shows the active subscription quota in the built-in footer and
adds an API-equivalent cost estimate to new Cursor assistant messages.

## Setup

`ai-usagebar` is installed from Git `main` by mise:

```sh
mise install
mise exec -- ai-usagebar usage --json
```

OpenAI uses the existing `~/.codex/auth.json`. Cursor credentials are resolved
by ai-usagebar.

The machine-local broker config is
`~/Library/Application Support/ai-usagebar/config.toml`. It enables only
OpenAI and Cursor. The machine-local pi-quotas config is
`~/.pi/agent/extensions/quotas.json`, the path pi-quotas 0.3.1 expects.

Reload Pi after setup:

```text
/reload
```

## Status

The extension refreshes on startup, model changes, and completed turns. It
caches results for 30 seconds and ai-usagebar applies its own 60-second cache.
Examples:

```text
7d:82% left (↺in 4d22h7m)
cycle:45% left (↺in 9d4h)
```

OpenAI prefers the weekly Codex window, falling back to the 5-hour window.
Cursor shows exactly one pool: Cursor Models for Composer, Grok, and Auto;
Other Models for named third-party models. It never combines the pools or shows
balances, spend caps, or on-demand state.

A temporary broker failure keeps the last successful value. Missing credentials
show `OpenAI: unavailable` or `Cursor: unavailable` without notifications.

## Cursor cost estimate

For new Cursor messages, the extension prices Pi's recorded input, output,
cache-read, and cache-write tokens and writes the complete breakdown to
`message.usage.cost`. Pi then persists it in session JSONL and includes it in
the built-in footer and `/tokens`.

This dollar value is an estimate, independent of Cursor subscription-pool
usage. Explicit `:fast` model aliases use separate Fast rates. `:slow` and
`@context` suffixes are normalized. Documented long-context pricing is used
only when the recorded prompt exceeds its threshold. No Max Mode uplift or
team token surcharge is inferred without a reliable message-level signal.

Current rates are in `core.ts` under `STANDARD_RATES`, `FAST_RATES`, and
`LONG_CONTEXT_RATES`. Update them from:

- <https://cursor.com/docs/models-and-pricing>
- the model-specific pages under <https://cursor.com/docs/models/>
- the MIT-licensed oh-my-pi catalog for older fallback models

Unknown models and Fast variants without a confirmed rate remain at zero rather
than receiving a guessed charge.

## Troubleshooting

```sh
cursor-agent whoami
mise exec -- ai-usagebar usage --json | jq '.entries[] | {id, error, metrics}'
```

A valid Cursor Agent login can still receive HTTP 401 from ai-usagebar's
reverse-engineered dashboard endpoint; this is an upstream broker compatibility
issue and does not require installing Cursor IDE. If OpenAI is unavailable,
refresh it with `codex login`. A malformed or slow broker response is ignored
and does not interrupt Pi turns.
