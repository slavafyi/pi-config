# Pi Config

My personal [Pi](https://pi.dev) configuration. It defines the models, agents,
extensions, packages, and themes that shape my coding workflow.

## Setup

### Environment variables

This setup keeps Pi's configuration outside its default location. Set these
variables in your shell environment:

```bash
export PI_CONFIG_DIR="${PI_CONFIG_DIR:-$HOME/.config/pi}"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$PI_CONFIG_DIR/agent}"
export PARALLEL_API_KEY="<your-key>"
```

`PI_CODING_AGENT_DIR` is derived from `PI_CONFIG_DIR` and points to this
repository. Keep `PARALLEL_API_KEY` in a local secrets store and outside Git.

### Fresh machine

```bash
# 1. Install Pi and tools
pnpm install -g \
  @earendil-works/pi-coding-agent parallel-web-cli @playwright/cli@latest

# 2. Install skills
pnpx skills add microsoft/playwright-cli \
  --global \
  --agent universal \
  --skill playwright-cli \
  --yes

pnpx skills add parallel-web/parallel-agent-skills \
  --global \
  --agent universal \
  --skill "*" \
  --yes

# 3. Clone this repository as the agent configuration
mkdir -p "$(dirname "$PI_CODING_AGENT_DIR")"
git clone git@github.com:slavafyi/pi-config.git "$PI_CODING_AGENT_DIR"

# 4. Install the configured packages
pi update --extensions

# 5. Start Pi and use /login to configure a provider
pi
```

This configuration uses Parallel for web search and Playwright for browser
work. Both integrations use CLI skills instead of MCP servers to keep tool
context and token usage low.

Credentials, sessions, installed package checkouts, and trust decisions are
excluded from Git.

### Updating

```bash
cd "$PI_CODING_AGENT_DIR"
git pull
pnpm install --prod=false
pi update --extensions
```

Package sources are pinned. `pi update --extensions` reconciles those exact
versions; it does not advance the pins in `settings.json`. Review upstream
changes before changing a pin.

The dotfiles Fish function `pi-update` updates Pi and reconciles packages, then
copies `handoff.ts` and `notify.ts` from the installed Pi examples. Run `/reload`
after updating extensions, or restart Pi when the CLI itself changed.

## Agents

| Agent | Purpose |
|-------|---------|
| `general` | Autonomous work on a narrow, self-contained task |
| `oracle` | Read-only second opinion on direction and assumptions |
| `reviewer` | Read-only review of a finished artifact |

Subagents use foreground execution by default. Explicit background work runs
with a maximum concurrency of four and smart join. The maximum nesting depth is
one, and Pi's default agents are disabled in favor of these definitions.
`SubagentWorkflow` is explicitly disabled; enabling it requires extending our
delegation policy and reviewing its separate concurrency limits.

## Extensions

| Extension | What it provides |
|-----------|------------------|
| `tool-output-limit` | Independent configurable limits for built-in bash, grep, and text read output |
| `footer` | Responsive project, model, extension-status, quota, cache, context, and cost footer |
| `plan-mode` | Read-only planning with cache-preserving execution transitions |
| `usage` | Codex and Cursor quota status and Cursor cost estimates |
| `subagent-policy` | Automatic delegation policy with foreground execution by default |

Extension-specific settings are namespaced under `extensions` in
`user-settings.json`. An extension remains inactive when its required section
or key is absent.

## Packages

Packages are declared in `settings.json` and pinned to immutable git commits or exact npm versions.

| Package | Purpose |
|---------|---------|
| [pi-wakatime](https://github.com/ttttmr/pi-wakatime) | WakaTime activity tracking |
| [pi-fff](https://github.com/ShpetimA/pi-fff) | Fast file and content search tools |
| [pi-openai-server-compaction](https://github.com/ronind/pi-openai-server-compaction/tree/bugfix/report-compaction-usage) | OpenAI server-side compaction; our fork includes [usage reporting](https://github.com/algal/pi-openai-server-compaction/pull/15), [context preservation](https://github.com/algal/pi-openai-server-compaction/pull/18), and Pi 1.0.0 compatibility |
| [pi-auto-session-titles](https://github.com/edxeth/pi-auto-session-titles) | Automatic session titles |
| [pi-datetime](https://github.com/yusukeshib/pi-datetime) | Date and time context |
| [pi-sidequest](https://github.com/peterp/pi-sidequest) | Side-task execution |
| [pi-subagents](https://github.com/tintinweb/pi-subagents) | Parallel subagent orchestration |
| [pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk) | Cursor SDK agents inside Pi |
| [pi-voice](https://github.com/earendil-works/pi-voice) | Local speech-to-text dictation and file transcription |
| [pi-context-view](https://github.com/dimk90/pi-context-view) | Context usage visualization and inspection of system prompt, tools, and extension injections |
| [pi-copy-code](https://github.com/penumbral-labs/pi-copy-code) | Copy code blocks and blockquotes from recent assistant messages |
| [pi-session-recall](https://www.npmjs.com/package/@ogulcancelik/pi-session-recall) | Search across previous sessions |

Pi Voice replaces pi-transcribe. Back up `pi-transcribe.json` before its first
use: upstream migrates settings to `pi-voice.json` and removes the legacy file.
Use `/voice-settings` (`/transcribe` remains an alias).

Session recall's query model is configured in `session-recall.json`; the
`/session-recall` model picker was removed in 1.0.7.

Pi packages run with full system access. Review third-party package source code
before using this configuration.

## License

MIT License - see [LICENSE](LICENSE) for details.
