# Topchester Agent

## Overview

Topchester Agent is a terminal-native TUI coding agent tightly coupled to a committed project knowledge base. The normal workflow is to compile project knowledge first, then let the agent use that knowledge while planning, editing, checking drift, and updating the repository.

## Knowledge Compiler

The current `topchester kb compile` command handles L1 file knowledge:

- Requires `topchester kb init` to create the knowledge folders first.
- Reads workspace `.gitignore` files, lists in-scope project files, and skips generated/cache folders such as `.git/`, `node_modules/`, `dist/`, `coverage/`, `topchester-kb/`, `.agents/topchester/`, and `.agents/topchester-kb-cache/`.
- Queues L1 work at `.agents/topchester-kb-cache/l1-queue.json`.
- Processes queued files with the configured `kb.summarize` model, or `fallback` when `kb.summarize` is not configured.
- Writes the manifest at `topchester-kb/manifest.json`.
- Writes current L1 file entries under `topchester-kb/l1-files/`.
- Exits successfully only when every in-scope file has a current L1 entry.

## Setup

- Node.js: `>=24`
- pnpm: `>=11`
- Package manager: `pnpm@11.0.8`

Install dependencies with:

```sh
pnpm install
```

## Common Commands

```sh
pnpm check
pnpm test
pnpm typecheck
pnpm lint
pnpm format-check

topchester kb init
topchester kb compile
topchester kb status
topchester kb reset
```

## Configuration

Model settings are loaded from YAML config files and merged in this order:

1. `~/.config/topchester/config.yaml`
2. `topchester.yaml`
3. `.topchester/config.local.yaml`
4. `TOPCHESTER_CONFIG`
5. `--config <path>`

Example configs live in `config/example.yaml` and `config/gemini.yaml`. OpenRouter configs expect `OPENROUTER_API_KEY` in the environment; do not commit API keys or other secrets.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Knowledge System](docs/KNOWLEDGE.md)
- [CLI Commands](docs/cli.md)
- [Model Configuration](docs/MODEL_CONFIG.md)
- [Sessions](docs/SESSIONS.md)
