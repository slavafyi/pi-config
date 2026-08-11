# Cache timer

Shows the remaining prompt-cache window in Pi's footer. This helps avoid an
unexpected cache miss after leaving an expensive conversation idle.

The timer is dim while the cache window is healthy, becomes a warning for the
last 30%, and shows `cache expired` when the window ends. Each model request
resets it; it keeps ticking while the model streams and while tools run.
Expiration means the documented or observed window ended; the provider may
retain a cache entry longer.

## Cache windows

| Provider | Model | Window | Basis |
|----------|-------|--------|-------|
| OpenAI | GPT-5.6 | 30 minutes | Documented minimum |
| OpenAI Codex subscription | GPT-5.6 | 5 minutes | Conservative observed idle TTL |
| Cursor | GPT-5.6 | 30 minutes | Underlying OpenAI policy |
| Anthropic | Claude | 5 minutes | Documented default idle TTL |
| Cursor | Claude | 5 minutes | Underlying Anthropic policy |

The indicator stays hidden for Cursor Auto, Composer, Grok, Kimi, GLM, and
other models without a useful published cache window.
