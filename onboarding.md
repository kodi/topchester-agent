# Onboarding

This is the shortest path to a working Topchester agent in a project.

## Requirements

- Node.js `>=24`
- A model provider key. The examples below use OpenRouter through `OPENROUTER_API_KEY`.

## 1. Install Topchester

```sh
npm install -g topchester-ai
```

The installed command is `topchester`.

## 2. Add A Minimal Model Config

In the project you want Topchester to work on, create `topchester.jsonc`:

```jsonc
{
  "$schema": "https://topchester.com/schemas/config.v1.json",
  "models": {
    "default": "openrouter/google/gemini-3.1-flash-lite",
  },
}
```

Or use a stronger model for chat and the same Gemini model for KB summaries:

```jsonc
{
  "$schema": "https://topchester.com/schemas/config.v1.json",
  "models": {
    "default": "openrouter/anthropic/claude-sonnet-4.5",
    "kb.summarize": "openrouter/google/gemini-3.1-flash-lite",
  },
}
```

Then set your API key in the shell that will run Topchester:

```sh
export OPENROUTER_API_KEY=...
```

Do not put API keys in committed config files. Use environment variables, user config, or `.topchester/config.local.jsonc` for local-only settings.

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

## 3. Build The Project Knowledge Base

From the project root:

```sh
topchester kb init
topchester kb sync
```

`kb init` creates the local Topchester folders. `kb sync` builds `topchester-kb/`, which is the project knowledge base the agent uses for normal work.

For a cheap preview before compiling:

```sh
topchester kb dry-run
```

## 4. Start The Agent

```sh
topchester
```

This opens the terminal chat UI. Type a request and press `Enter`.

Useful first commands inside the TUI:

```text
/kb status
/kb sync
/kb sync --full
/new
```

The status line shows the active model and KB state, for example:

```text
ready · my-project · google/gemini-3.1-flash-lite [openrouter] · ✅ kb: ready
```

## 5. Continue Later

Plain `topchester` starts a fresh project-local session. To continue the newest saved session:

```sh
topchester --resume latest
```

Sessions are stored under `.agents/topchester/sessions/` and should stay out of git.

## Daily Loop

Use this loop for normal work:

```sh
topchester kb status
topchester kb sync
topchester
```

`kb status` is cheap and shows files that are not current in the KB. `kb sync` updates only those non-clean files.

## If Something Fails

- `missing API key`: set `OPENROUTER_API_KEY` in the same shell.
- `kb: missing`: run `topchester kb init`, then `topchester kb sync`.
- `kb: empty`: run `topchester kb sync`.
- `N dirty`: run `topchester kb sync`.
- Command blocked by policy: approve it in the TUI for one run, or add an exact command rule under `tools.commands.allowExact` in `topchester.jsonc`.

More detail lives in:

- `docs/config.md`
- `docs/MODEL_CONFIG.md`
- `docs/cli.md`
- `docs/tui.md`
- `docs/KNOWLEDGE.md`

## Running From Source

If you are working from the source checkout instead of the npm package:

```sh
pnpm install
pnpm build
node dist/cli.mjs --help
```
