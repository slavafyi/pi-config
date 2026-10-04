# Usage

This Pi extension publishes the active Codex subscription quota under the
`usage` status ID. The custom footer normalizes and displays that status.

## Setup

No separate usage CLI is required. OpenAI Codex uses the OAuth account
configured through Pi `/login`. The extension does not store provider
credentials.

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
refresh tokens. Only Codex entries are retained when reading the cache.

OpenAI Codex calls ChatGPT's `/backend-api/wham/usage` endpoint directly. It
identifies the five-hour and weekly windows by their reported duration rather
than their response position and accepts `reset_after_seconds` when an absolute
reset is absent. It also updates the cached snapshot from rate-limit headers on
normal Codex responses, so completed turns do not require another quota request.

The network cache lasts five minutes. In-process request sharing and an atomic
inter-process lock deduplicate refreshes across concurrent Pi sessions. Cache
writes merge the latest snapshots. The last good value remains visible through
temporary failures for at most seven days. When no usable cached status is
available, a request that takes longer than 150 milliseconds shows a spinner.
Headless sessions skip quota requests.

The extension publishes the compact display form directly. When Codex reports
both quota windows, both are shown:

```text
5h:96% ↺3h  7d:82% ↺4d22h7m
```

The window and reset are dim. The remaining percentage is accent above 25%,
warning from 11% through 25%, and error at 10% or below. The custom footer
preserves those ANSI colors while positioning and truncating the status
responsively. When the footer is invalidated, the extension restyles its saved
semantic status with the current theme without making another request.

OpenAI shows every reported Codex window, with the five-hour window first.
Missing credentials show `OpenAI: unavailable` without interrupting Pi.
Unsupported Pi providers clear the status. This includes the `openai` provider:
Sign in with ChatGPT uses subscription-sharing limits, so this extension does
not label the legacy Codex quota as the active OpenAI subscription quota.

## Tokens

Pi records token usage natively. Use its built-in `/session` command for input,
output, cache, total cost, and per-provider/model breakdowns. This extension
does not modify message costs.

## Troubleshooting

Use Pi `/login` to configure the OpenAI Codex account. A malformed, unavailable,
or slow provider response is ignored and does not interrupt Pi turns.
