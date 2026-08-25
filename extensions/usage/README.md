# Usage

This Pi extension publishes the active Codex or Cursor subscription quota under
the `usage` status ID and adds an API-equivalent cost estimate to new Cursor
assistant messages. The custom footer normalizes and displays that status.

## Setup

No separate usage CLI is required.

OpenAI Codex uses the OAuth account configured through Pi `/login`. Cursor uses
the account configured through `cursor-agent`:

```sh
cursor-agent login
cursor-agent whoami
```

Cursor Agent credentials are resolved from its native store:

- macOS: Login Keychain entry `cursor-access-token` for `cursor-user`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json`
- macOS with `AGENT_CLI_CREDENTIAL_STORE=file`: `~/.cursor/auth.json`

`CURSOR_AUTH_TOKEN` is also accepted when it is already present in Pi's
environment. The extension does not inspect browser cookies and does not store
provider credentials.

Reload Pi after changing credentials:

```text
/reload
```

## Status

The extension reads the last successful snapshot from `usage-cache.json` in
`PI_CODING_AGENT_DIR`. Before displaying it, the extension resolves the current
account and verifies a one-way account fingerprint stored with the snapshot.
The cache contains normalized quota data and account fingerprints only, is
written with mode `0600`, and never contains account IDs, access tokens, or
refresh tokens.

OpenAI Codex calls ChatGPT's `/backend-api/wham/usage` endpoint directly. It
identifies the five-hour and weekly windows by their reported duration rather
than their response position and accepts `reset_after_seconds` when an absolute
reset is absent. It also updates the cached snapshot from rate-limit headers on
normal Codex responses, so completed turns do not require another quota request.

Cursor reads the Cursor Agent access token and calls
`DashboardService/GetCurrentPeriodUsage` directly. The response supplies the
billing-cycle reset and separate Total, Cursor Models, and Other Models usage
percentages. Credentials are re-resolved once after an authentication failure.

The network cache lasts five minutes. In-process request sharing and an atomic
inter-process lock deduplicate refreshes across concurrent Pi sessions. Cache
writes merge the latest provider entries so one process cannot discard another
provider's update. The last good value remains visible through temporary
failures for at most seven days. A Cursor snapshot stops being usable as soon
as its billing cycle resets, even when it is otherwise inside that stale limit.
When no usable cached status is available, a request that takes longer than 150
milliseconds shows a spinner. Headless sessions skip quota requests but still
add Cursor cost estimates.

The extension publishes the compact display form directly. When Codex reports
both quota windows, both are shown:

```text
5h:96% ↺3h  7d:82% ↺4d22h7m
cursor:99% ↺30d4h
other:97% ↺30d4h
```

The window and reset are dim. The remaining percentage is accent above 25%,
warning from 11% through 25%, and error at 10% or below. The custom footer
preserves those ANSI colors while positioning and truncating the status
responsively. When the footer is invalidated, the extension restyles its saved
semantic status with the current theme without making another request.

OpenAI shows every reported Codex window, with the five-hour window first.
Cursor shows `cursor` for models listed
by Cursor in its automatic model bucket and `other` for explicitly selected
third-party models. Router/Auto shows `total` because its selected model can
change between turns. When the preferred category is unavailable, the
extension falls back to Total and then the remaining category. It never
combines pools or displays balances, spend caps, or on-demand state.

Missing credentials show `OpenAI: unavailable` or `Cursor: unavailable` without
interrupting Pi. Unsupported Pi providers clear the status.

## Tokens and Cursor cost estimate

Pi records token usage natively. Use its built-in `/session` command for input,
output, cache, total cost, and per-provider/model breakdowns.

For new Cursor messages, this extension prices Pi's recorded input, output,
cache-read, and cache-write tokens and writes the breakdown to
`message.usage.cost`. Pi persists it in session JSONL and includes it in its
custom footer, built-in session accounting, and `/session`.

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
cursor-agent whoami
cursor-agent login
```

On macOS, Keychain may ask for access the first time Pi reads the Cursor Agent
entry. On Linux, confirm that the Cursor Agent auth file exists and remains
readable only by the current user. A malformed, unavailable, or slow provider
response is ignored and does not interrupt Pi turns.
