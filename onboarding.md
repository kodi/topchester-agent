# Onboarding

This is the shortest path to a working Topchester agent in a project.

## Requirements

- Bun `>=1.4`
- A model provider key. The examples below use OpenRouter through `OPENROUTER_API_KEY`.

## 1. Install Topchester

```sh
npm install -g topchester-ai
```

The installed command is `topchester`.

## 2. Set Your API Key

Set your API key in the shell that will run Topchester:

```sh
export OPENROUTER_API_KEY=...
```

Do not put API keys in committed config files. Use environment variables, user config, or `.topchester/config.local.jsonc` for local-only settings.

You do not need model config for your first session. When you want a durable
default, create `topchester.jsonc` in the project:

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

Topchester reads config in this order, with later entries overriding earlier ones:

1. `topchester.jsonc`
2. `~/.config/topchester/config.jsonc`
3. `TOPCHESTER_CONFIG`
4. `--config <path>`

On first startup, Topchester creates `~/.config/topchester/config.jsonc` with a commented minimal example. Uncomment it to set your personal default model, or keep shared project policy in `topchester.jsonc`.

## 3. Start The Agent

From the project root, pass the model as `provider/model`:

```sh
topchester -m openrouter/google/gemini-3.1-flash-lite
```

This opens the terminal chat UI without writing model config. Type a request and press `Enter`.

To keep a stronger chat model while using a cheaper KB model for this session:

```sh
topchester -m openrouter/anthropic/claude-sonnet-4.5 \
  --kb-model openrouter/google/gemini-3.1-flash-lite
```

## 4. Build The Project Knowledge Base

Inside the TUI:

```text
/kb init
/kb sync
```

`/kb init` creates the local Topchester folders. `/kb sync` builds `topchester-kb/`, which is the project knowledge base the agent uses for normal work. Use `/kb-model provider/model` to change the KB model during this session. If no KB model is selected or configured, the chat default is the fallback.

For a cheap preview before compiling, run `topchester kb dry-run` in another shell.

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

With a durable default, plain `topchester` starts a fresh project-local session.
To continue the newest saved session:

```sh
topchester --resume latest
```

The model selection is part of the saved session. An explicit `-m` on resume
wins when you want to change it:

```sh
topchester --resume latest -m openrouter/anthropic/claude-sonnet-4.5
```

Sessions are stored under `.agents/topchester/sessions/` and should stay out of git.

## Daily Loop

Use this loop for normal work:

```sh
topchester -m openrouter/google/gemini-3.1-flash-lite
```

Then use `/kb status` and `/kb sync` in the TUI. Status is cheap and shows
files that are not current in the KB. Sync updates only those non-clean files.
With a durable model default, the standalone `topchester kb` commands work too.

## If Something Fails

- `missing API key`: set `OPENROUTER_API_KEY` in the same shell.
- `kb: missing`: run `topchester kb init`, then `topchester kb sync`.
- `kb: empty`: run `topchester kb sync`.
- `N dirty`: run `topchester kb sync`.
- Command blocked by policy: approve it in the TUI for one run, or add an exact command rule under `tools.bash.allowExact` in `topchester.jsonc`.

More detail lives in:

- `docs/README.md`
- `docs/getting-started/quickstart.md`
- `docs/configuration/config-files.md`
- `docs/configuration/models-and-providers.md`
- `docs/reference/cli.md`
- `docs/features/tui.md`
- `docs/features/knowledge-base.md`

## Running From Source

If you are working from the source checkout instead of the npm package:

```sh
mise install
pnpm install
mise run build
mise exec -- bun dist/bin.mjs --help
```
