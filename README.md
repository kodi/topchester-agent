# Topchester Agent

Website: https://topchester.com

Topchester is a terminal coding agent that learns a project before it starts making changes. It builds a local project knowledge base, uses that knowledge while chatting and editing, and helps keep the knowledge current as the code changes.

If you have used tools like Codex, Claude Code, or OpenCode, the shape should feel familiar: install a CLI, `cd` into a repo, run a command, chat in your terminal, review changes, and keep working. The difference is that Topchester treats project knowledge as part of the agent, not as an optional side index.

## Quick Start

Requirements:

- Node.js `>=24`
- A model provider key. The example below uses OpenRouter.

Install the CLI:

```sh
npm install -g topchester-ai
```

From the project you want Topchester to work on, create `topchester.jsonc`:

```jsonc
{
  "$schema": "https://topchester.com/schemas/config.v1.json",
  "models": {
    "default": "openrouter/google/gemini-3.1-flash-lite",
  },
}
```

Set your API key:

```sh
export OPENROUTER_API_KEY=...
```

Build the project knowledge base:

```sh
topchester kb init
topchester kb sync
```

Start the agent:

```sh
topchester
```

For the short setup guide, see [onboarding.md](onboarding.md).

## What Topchester Creates

Topchester keeps project knowledge and local runtime data in separate places:

- `topchester-kb/` — compiled project knowledge. This is the canonical knowledge base for the repo.
- `.agents/topchester-kb-cache/` — local generated cache and queue files.
- `.agents/topchester/sessions/` — local chat sessions, metadata, and event logs.
- `.agents/topchester/logs/` — local debug logs when logging is enabled.

Session folders, caches, and logs are local machine state and should not be committed.

## Everyday Commands

```sh
topchester
topchester --resume latest
topchester run "Summarize this project."

topchester kb status
topchester kb sync
topchester kb sync --full
topchester kb search "status bar"
topchester kb reset
```

Useful TUI slash commands:

```text
/kb status
/kb sync
/kb sync --full
/new
```

`topchester kb status` is the cheap check. It shows files that are not current in the knowledge base. `topchester kb sync` builds the KB when it is empty and updates only non-clean files afterward. Use `topchester kb sync --full` to rebuild every in-scope file and remove orphaned L1 entries.

## Configuration

The smallest config uses one OpenRouter model for all Topchester work:

```jsonc
{
  "$schema": "https://topchester.com/schemas/config.v1.json",
  "models": {
    "default": "openrouter/google/gemini-3.1-flash-lite",
  },
}
```

You can also use a stronger model for chat and a cheaper model for KB summaries:

```jsonc
{
  "$schema": "https://topchester.com/schemas/config.v1.json",
  "models": {
    "default": "openrouter/anthropic/claude-sonnet-4.5",
    "kb.summarize": "openrouter/google/gemini-3.1-flash-lite",
  },
}
```

Do not commit API keys. Put keys in environment variables, a user config file, or an uncommitted local config.

Topchester reads config in this order, with later entries overriding earlier ones:

1. `~/.config/topchester/config.yaml`
2. `~/.config/topchester/config.jsonc`
3. `topchester.yaml`
4. `topchester.jsonc`
5. `.topchester/config.local.yaml`
6. `.topchester/config.local.jsonc`
7. `TOPCHESTER_CONFIG`
8. `--config <path>`

Prefer `topchester.jsonc` for new project config. YAML paths are kept for compatibility.

## How The Knowledge Base Works

`topchester kb sync` scans the workspace, respects `.gitignore`, skips generated/cache folders, and writes L1 knowledge entries under `topchester-kb/l1-files/`.

The compiler uses `models["kb.summarize"]` when it is configured. If it is not configured, it uses `models.default`.

Common KB states:

- `kb: ready` — the KB exists and has compiled content.
- `kb: empty` — the KB folder exists but has no compiled content yet.
- `kb: missing` — run `topchester kb init`, then `topchester kb sync`.
- `N dirty` — run `topchester kb sync`.

## Working From Source

This section is for contributors working in this repository.

```sh
pnpm install
pnpm build
node dist/cli.mjs --help
```

Common repo checks:

```sh
pnpm check
pnpm test
pnpm typecheck
pnpm lint
pnpm format-check
```

The package name is `topchester-ai`; the installed command is `topchester`.

## Read More

- [Onboarding](onboarding.md)
- [CLI Commands](docs/cli.md)
- [TUI Guide](docs/tui.md)
- [Configuration](docs/config.md)
- [Model Configuration](docs/MODEL_CONFIG.md)
- [Knowledge System](docs/KNOWLEDGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Sessions](docs/SESSIONS.md)
