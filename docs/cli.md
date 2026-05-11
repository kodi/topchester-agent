# CLI Commands

This document tracks implemented and planned `topchester` CLI commands. Any CLI command additions, removals, or behavior changes should be reflected here in the same change.

## Global options

- `-c, --config <path>` — explicit config file path.
- `--workspace <path>` — workspace root. Defaults to the current working directory.
- `--dev <flag>` — development-only UI/runtime flag. Can be repeated, for example `--dev disable-kb-check-modal --dev do-something-other`.
- `-V, --version` — print the CLI version.
- `-h, --help` — print help.

## Development flags

- `disable-kb-check-modal` — still checks and prints KB status during startup, but does not show the missing-KB modal.

## Logging

- `TOPCHESTER_LOG_LEVEL=debug` writes structured JSON logs to `.agents/topchester/logs/topchester.log`.
- `TOPCHESTER_LOG_FILE=<path>` overrides the log file path. Relative paths are resolved from the workspace root.
- `debug` logs tool calls, tool result metadata, and model response metadata. `trace` also logs full model/tool response text.
- Logging is file-only and does not write to the TUI.

## Output style

- User-facing CLI output should use plain language.
- Color is reserved for useful signal: headings, success, warnings, and errors.
- Spinners are used for work that may take a moment, and only in interactive terminals.
- Color and spinner control sequences are not emitted when output is not a TTY, unless `FORCE_COLOR` is set.

## Commands

### `topchester`

Starts interactive mode.

Status: minimal TUI shell.

Current behavior:

- Opens a generic chat-style TUI when running in an interactive terminal.
- Uses the terminal alternate screen without mouse capture, so terminal text selection keeps working.
- Pressing `Ctrl-C` once shows `press Ctrl-C again to exit.` as a temporary message; pressing `Ctrl-C` again right away exits.
- Shows a scrolling thread area on top with startup context.
- Supports terminal alternate-scroll wheel events, `PageUp`/`PageDown`, and `Home`/`End` for chat history scrolling.
- Shows an unlabeled input box below the thread.
- Shows a status line below the prompt box with `ready`, the current folder name, and the active model as `model [provider]`.
- Tracks chat rows as `System`, `You`, and `Agent` messages, and sends user messages to the configured `agent.primary` model.
- Lets the model use workspace-scoped tools: `read_file` and `grep`.
- `grep` uses `rg` when available, falls back to `grep`, and reports a warning if neither command is installed.
- Intercepts slash commands before chat, starting with `/kb status`.
- Shows slash command suggestions when the prompt starts with `/`; `Tab` completes the selected suggestion.
- Shows a temporary thinking row while waiting for chat responses.
- Checks the configured `agent.fast` model on startup in interactive mode and prints `Agent: ready` when the model responds.
- Skips the startup check with a plain message if the agent takes too long.
- Checks KB status after the agent is ready.
- Shows a warning modal with setup choices when no KB folder exists, or when the KB path is not a folder.
- Shows a temporary spinner row in the chat area while the engine is busy, with copy that says what is happening.
- Shows `press Esc to stop` inside the prompt box while the startup agent check is running.
- Prints a static version of the same layout when output is not interactive.

Slash commands:

- `/kb init` — creates Topchester project folders and prints what was created or already present.
- `/kb status` — prints the same simple workspace KB status as `topchester kb status` inside the chat thread.

### `topchester dev`

Starts local development mode.

Status: placeholder.

Current behavior:

- Prints `Topchester local dev mode`.
- Prints workspace, default model purpose, model assignments, and providers.

### `topchester kb init`

Initializes a project knowledge base.

Status: placeholder.

Intended behavior:

- Bootstrap a repository that does not yet have a canonical KB.
- Create the initial KB directory, schema metadata, and required baseline files.

Current behavior:

- Creates `.agents/topchester/`, `.agents/topchester/sessions/`, `.agents/topchester/logs/`, the configured knowledge folder, and the configured local cache folder.
- Prints the workspace path and which folders were created or already existed.

### `topchester kb compile`

Compiles the project knowledge base.

Status: placeholder.

Intended behavior:

- Scan the current codebase and generate or update KB contents.
- Run against an existing initialized KB.

Current behavior:

- Prints `KB compile: not implemented yet`.
- Prints the workspace path.

### `topchester kb status`

Shows project knowledge base status.

Status: implemented, simple path checks only.

Current behavior:

- Prints the workspace path.
- Checks the knowledge folder path:
  - Default: `topchester-kb/`
  - Override: `TOPCHESTER_KB_DIR`
- Checks the local cache folder path:
  - Default: `.agents/topchester-kb-cache/`
  - Override: `TOPCHESTER_KB_CACHE_DIR`
- Reports each path as `[ok]`, `[missing]`, or `[not a folder]`.
- Prints one state line:
  - `state: no knowledge base found yet`
  - `state: knowledge base path is not a folder`
  - `state: knowledge base found`
