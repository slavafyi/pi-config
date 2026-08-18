# Cache timer

Publishes the remaining prompt-cache window under the `cache-timer` status ID.
The custom footer adds the `cache:` label and reset symbol. This helps avoid an
unexpected cache miss after leaving an expensive conversation idle.

The extension publishes `4:23` while active or `expired` when the window ends.
The timer is dim while the cache window is healthy and becomes a warning for
the last 30%. Each model request resets it; it keeps ticking while the model
streams and while tools run. Footer invalidation reapplies the current theme
without restarting the timer. The
indicator stays hidden after starting, resuming, reloading, or navigating a
session until the next request because the restored prompt prefix may differ.
Expiration means the documented or observed window ended; the provider may
retain a cache entry longer.

## Cache windows

| Provider | Model | Window | Basis |
|----------|-------|--------|-------|
| OpenAI | GPT-5.5 | 30 minutes | Repeated full-hit interval; later retention was inconsistent |
| OpenAI | GPT-5.6 | 30 minutes | Documented minimum |
| OpenAI Codex subscription | GPT-5.5 | 1 hour | Repeated full-hit interval; later retention was inconsistent |
| OpenAI Codex subscription | GPT-5.6 | 30 minutes | Observed idle TTL, matching the OpenAI default |
| Cursor | GPT-5.5 | 5 minutes | Repeated full-hit interval; later probes were often partial |
| Cursor | GPT-5.6 | 30 minutes | Underlying OpenAI policy |
| Anthropic | Claude | 5 minutes | Documented default idle TTL |
| Cursor | Claude | 5 minutes | Underlying Anthropic policy |

The indicator stays hidden for Cursor Auto, Composer, Grok, Kimi, GLM, and
other models without a useful published cache window.
