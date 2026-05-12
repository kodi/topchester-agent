# CLI Commands

This document tracks implemented and planned `topchester` CLI commands. Any CLI command additions, removals, or behavior changes should be reflected here in the same change.

## Global options

- `-c, --config <path>` — explicit config file path.
- `--workspace <path>` — workspace root. Defaults to the current working directory.
- `--resume <session>` — resume a project-local session. Use `latest` or an exact lowercase session ID.
- `--dev <flag>` — development-only UI/runtime flag. Can be repeated, for example `--dev disable-kb-check-modal --dev do-something-other`.
- `-V, --version` — print the CLI version.
- `-h, --help` — print help.

## Development flags

- `disable-kb-check-modal` — still checks and prints KB status during startup, but does not show the missing-KB modal.

## Logging

- `TOPCHESTER_LOG_LEVEL=debug` writes structured JSON logs to `.agents/topchester/logs/topchester.log`.
- `TOPCHESTER_LOG_FILE=<path>` overrides the log file path. Relative paths are resolved from the workspace root.
- `debug` logs tool calls, tool result metadata, edit metadata, and model response metadata. For `edit_file`, debug logs include hashes, changed-line metadata, and edit counts, not full old/new edit text. `trace` also logs full model/tool response text.
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
- Creates a fresh project-local session by default under `.agents/topchester/sessions/`. It does not auto-resume old sessions.
- `--resume latest` restores the newest project-local session. `--resume <session-id>` restores that exact session.
- Resumed sessions keep using the selected session log. New saved events append to that log instead of creating a replacement session.
- Missing, malformed, invalid, traversal, or no-session resume targets fail before the TUI/static layout opens, with plain error text.
- Uses the terminal alternate screen without mouse capture, so terminal text selection keeps working.
- Pressing `Ctrl-C` once shows `press Ctrl-C again to exit.` as a temporary message; pressing `Ctrl-C` again right away exits.
- Shows a scrolling thread area on top with startup context.
- Supports terminal alternate-scroll wheel events, `PageUp`/`PageDown`, and `Home`/`End` for chat history scrolling.
- Shows an unlabeled input box below the thread.
- Shows a status line below the prompt box with `ready`, the current folder name, the active model as `<model> [provider]`, and compact KB state as `✅ kb: ready`, `○ kb: empty`, `⚠ kb: missing`, or `✕ kb: path conflict` after the KB check runs.
- Tracks chat rows as `System`, `You`, and `Agent` messages, and sends user messages to the configured `agent.primary` model.
- Lets the model use workspace-scoped tools: `read_file`, `grep`, `find_file`, and `edit_file`.
- `read_file` reads UTF-8 files inside the workspace and returns content hash metadata for stale-read checks.
- `grep` uses `rg` when available, falls back to `grep`, and reports a warning if neither command is installed.
- `find_file` searches existing workspace filenames by fuzzy path or name.
- `edit_file` edits existing UTF-8 files inside the workspace with exact `old_text`/`new_text` replacements. It rejects path escapes, missing files, directories, invalid UTF-8, duplicate or overlapping matches, unchanged output, and stale `expected_hash` values when provided. Successful edits return a compact diff, before/after hashes, first changed line, and mark the KB session overlay as `needs_sync`.
- Intercepts slash commands before chat, starting with `/kb status`.
- Shows slash command suggestions when the prompt starts with `/`; `Tab` completes the selected suggestion.
- Shows a temporary thinking row while waiting for chat responses.
- Checks the configured `agent.fast` model on startup in interactive mode and prints `Agent: ready` when the model responds.
- Skips the startup check with a plain message if the agent takes too long.
- Checks KB status after the agent is ready and refreshes the footer after `/kb init`, `/kb reset`, `/kb compile`, and `/kb status`.
- Shows a warning modal with setup choices when no KB folder exists, or when the KB path is not a folder.
- Shows a temporary spinner row in the chat area while the engine is busy, with copy that says what is happening.
- Shows `press Esc to stop` inside the prompt box while the startup agent check is running.
- Prints a static version of the same layout when output is not interactive.

Slash commands:

- `/kb init` — creates Topchester project folders and prints what was created or already present. Shows a simple progress line while it runs.
- `/kb compile` — reads `.gitignore` files, lists project files, and processes them into L1 file entries with the configured `kb.summarize` model. Shows L1 processing counts and percentage while it runs.
- `/kb reset` — deletes the configured knowledge folder and local cache folder so the project can start clean. Shows a simple progress line while it runs.
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

- Creates `.agents/topchester/`, `.agents/topchester/sessions/`, `.agents/topchester/logs/`, the configured knowledge folder, baseline knowledge subfolders (`l1-files/`, `l2-modules/`, `l3-features/`, `graph/`, `reviews/`), and the configured local cache folder.
- Prints progress while checking and creating folders, with updates no more than every 5 seconds in the CLI and rotating progress text in the TUI.
- Prints the workspace path and which folders were created or already existed.

### `topchester kb compile`

Compiles the project knowledge base.

Status: implemented, L1 queue and model-backed L1 file processing.

Current behavior:

- Requires `topchester kb init` to have created the knowledge folder first.
- Reads `.gitignore` files from the workspace, including nested `.gitignore` files.
- Lists project files that are not ignored and skips heavy generated folders such as `.git/`, `node_modules/`, `dist/`, `coverage/`, `topchester-kb/`, `.agents/topchester/`, and `.agents/topchester-kb-cache/`.
- Queues each listed file for L1 processing in `.agents/topchester-kb-cache/l1-queue.json`.
- Processes the L1 queue with the configured `kb.summarize` model purpose. If `kb.summarize` is not configured, it uses the configured `fallback` model if one exists.
- Writes one current L1 JSON entry per successfully processed file under `topchester-kb/l1-files/`.
- Writes `topchester-kb/manifest.json` with the KB layout version, compiler name/version, queued file count, gitignore files read, and L1 outcome counts.
- Prints progress while reading ignore files, listing files, queueing L1 work, processing L1 entries, and writing output. During L1 processing, the CLI shows a progress bar, completed/total count, percentage, and current file path.
- Prints the workspace path, gitignore file count, queue path, manifest path, queued count, completed count, failed count, changed count, missing count, current L1 entry count, and final state.
- Exits successfully only when every in-scope file has a current L1 entry. Per-file failed, changed, or missing outcomes print a partial state and set a non-success automation exit code. Fatal setup or model configuration errors fail before claiming L1 entries are current.

### `topchester kb reset`

Deletes the local project knowledge base and cache.

Status: implemented.

Current behavior:

- Deletes the configured knowledge folder and configured local cache folder.
- Uses the same paths as `topchester kb status`:
  - Knowledge folder default: `topchester-kb/`
  - Local cache folder default: `.agents/topchester-kb-cache/`
  - Environment overrides: `TOPCHESTER_KB_DIR` and `TOPCHESTER_KB_CACHE_DIR`
- Prints each removed path, or `already missing` for paths that were not present.
- Refuses to delete the workspace root or a filesystem root if a path is misconfigured.
- After reset, run `topchester kb init` to start clean.

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
