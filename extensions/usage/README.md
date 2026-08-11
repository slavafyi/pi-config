# Usage

This Pi extension shows the active Codex or Cursor subscription quota in the
built-in footer and adds an API-equivalent cost estimate to new Cursor assistant
messages.

## Setup

CodexBar CLI is installed by the platform's `setup_pi` script: Homebrew on
macOS and AUR on Arch. Fedora and Debian do not install it.

```sh
./install.sh setup_pi
codexbar --version
```

OpenAI uses `~/.codex/auth.json`. Cursor uses the existing cursor.com browser
session; automatic resolution tries cached cookies, supported browsers, legacy
sessions, and Cursor IDE auth in that order. No Cursor IDE is required when a
Firefox session is available.

```sh
codexbar usage --provider codex --source auto --format json
codexbar usage --provider cursor --source auto --format json
```

Reload Pi after setup:

```text
/reload
```

## Status

The extension refreshes on startup, model changes, and completed turns when a
UI is available. Headless sessions skip CodexBar quota requests but still add
Cursor cost estimates. It uses a 30-second cache, deduplicates concurrent
requests, and keeps the last good value through temporary failures.

```text
7d:82% left (↺in 4d22h7m)
auto:99% left (↺in 30d4h)
api:97% left (↺in 30d4h)
```

OpenAI prefers the weekly Codex window. Cursor shows the active category: Auto
for Auto/Composer and API for explicitly selected models, falling back to Total
when that category is unavailable. It never combines pools or displays
balances, spend caps, or on-demand state.

Missing credentials show `OpenAI: unavailable` or `Cursor: unavailable` without
interrupting Pi. Unsupported Pi providers clear the status. CodexBar also
supports Kimi, Z.ai/GLM, Alibaba Coding Plan, and Qwen Cloud directly:

```sh
codexbar usage --provider kimi --format json
codexbar usage --provider zai --format json
codexbar usage --provider alibaba-coding-plan --format json
codexbar usage --provider qwen-cloud --format json
```

## Tokens and Cursor cost estimate

Pi records token usage natively. Use its built-in `/session` command for input,
output, cache, total cost, and per-provider/model breakdowns.

For new Cursor messages, this extension prices Pi's recorded input, output,
cache-read, and cache-write tokens and writes the breakdown to
`message.usage.cost`. Pi persists it in session JSONL and includes it in its
built-in footer and `/session`.

The dollar value is an API-equivalent estimate independent of Cursor
subscription usage. Explicit `:fast` aliases use separate Fast rates. `:slow`
and `@context` suffixes are normalized. Long-context pricing is used only when
the recorded prompt exceeds its documented threshold. No Max Mode uplift or
team surcharge is inferred without a message-level signal.

Rates live in `core.ts` under `STANDARD_RATES`, `FAST_RATES`, and
`LONG_CONTEXT_RATES`. Update them from Cursor's official model pricing pages;
older fallback rates come from the MIT-licensed oh-my-pi catalog. Unknown models
remain at zero rather than receiving a guessed charge.

## Troubleshooting

```sh
codexbar cache clear --cookies --provider cursor
codexbar cookie refresh --provider cursor
codex login
```

A malformed, unavailable, or slow CodexBar response is ignored and does not
interrupt Pi turns. Browser-cookie access may require the permissions described
by CodexBar for that browser.
