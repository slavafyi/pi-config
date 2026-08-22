# Pi Config

My personal [Pi](https://pi.dev) configuration. It defines the models, agents,
extensions, packages, and themes that shape my coding workflow.

## Setup

### Fresh machine

```bash
# 1. Install Pi
pnpm install -g @earendil-works/pi-coding-agent

# 2. Clone this repository as the agent configuration
mkdir -p ~/.config/pi
git clone git@github.com:slavafyi/pi-config.git ~/.config/pi/agent

# 3. Install the configured packages
pi update --extensions

# 4. Start Pi and use /login to configure a provider
pi
```

Credentials, sessions, installed package checkouts, and trust decisions are
excluded from Git.

### Updating

```bash
cd ~/.config/pi/agent
git pull
pi update --extensions
```

## Agents

| Agent | Purpose |
|-------|---------|
| `general` | Autonomous work on a narrow, self-contained task |
| `oracle` | Read-only second opinion on direction and assumptions |
| `reviewer` | Read-only review of a finished artifact |

Subagents run with a maximum concurrency of four and a maximum nesting depth
of one. Pi's default agents are disabled in favor of these definitions.

## Extensions

| Extension | What it provides |
|-----------|------------------|
| `cache-timer` | Cache-expiry countdown for GPT-5.6 and Claude; unsupported Cursor models stay hidden |
| `footer` | Responsive project, model, extension-status, quota, cache, context, and cost footer |
| `plan-mode` | Read-only planning with cache-preserving execution transitions |
| `usage` | Codex and Cursor quota status and Cursor cost estimates |
| `with-agents` | `/with-agents` policy gate for subagent orchestration |

## Packages

Packages are declared in `settings.json` and managed by Pi.

| Package | Purpose |
|---------|---------|
| [pi-wakatime](https://github.com/ttttmr/pi-wakatime) | WakaTime activity tracking |
| [pi-fff](https://github.com/ShpetimA/pi-fff) | Fast file and content search tools |
| [pi-openai-server-compaction](https://github.com/algal/pi-openai-server-compaction) | OpenAI server-side context compaction |
| [pi-auto-session-titles](https://github.com/edxeth/pi-auto-session-titles) | Automatic session titles |
| [pi-datetime](https://github.com/yusukeshib/pi-datetime) | Date and time context |
| [pi-sidequest](https://github.com/peterp/pi-sidequest) | Side-task execution |
| [pi-subagents](https://github.com/tintinweb/pi-subagents) | Parallel subagent orchestration |
| [pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk) | Cursor SDK agents inside Pi |
| [pi-transcribe](https://github.com/earendil-works/pi-transcribe) | Local speech-to-text dictation |
| [pi-session-recall](https://www.npmjs.com/package/@ogulcancelik/pi-session-recall) | Search across previous sessions |

Pi packages run with full system access. Review third-party package source code
before using this configuration.

## License

MIT License - see [LICENSE](LICENSE) for details.
