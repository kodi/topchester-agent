# CLI Commands

This document tracks implemented and planned `topchester` CLI commands. Any CLI command additions, removals, or behavior changes should be reflected here in the same change.

## Global options

- `-c, --config <path>` — explicit config file path.
- `--workspace <path>` — workspace root. Defaults to the current working directory.
- `--resume <session>` — resume a project-local session from `.agents/topchester/sessions/`. Use `latest` or an exact lowercase session ID.
- `--dev <flag>` — development-only UI/runtime flag. Can be repeated, for example `--dev disable-kb-check-modal --dev do-something-other`.
- `-V, --version` — print the CLI package version.
- `-h, --help` — print help.

## Development flags

- `disable-kb-check-modal` — still checks and prints KB status during startup, but does not show the missing-KB modal.

## Logging

- `TOPCHESTER_LOG_LEVEL=debug` writes structured JSON logs to `.agents/topchester/logs/topchester.log`.
- `TOPCHESTER_LOG_FILE=<path>` overrides the log file path. Relative paths are resolved from the workspace root.
- `debug` logs tool calls, tool result metadata, edit metadata, and model response metadata. For `edit_file`, debug logs include hashes, changed-line metadata, and edit counts, not full old/new edit text. For `inspect_command`, debug logs include the command, cwd, allowlist decision, exit status, timing, and output sizes, not full command output. `trace` also logs full model/tool response text.
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
- Session logs live in the workspace under `.agents/topchester/sessions/`.
- Plain `topchester` starts a fresh session by default. It does not auto-resume old sessions.
- `--resume latest` restores the newest project-local session.
- `--resume <session-id>` restores that exact project-local session.
- Resumed sessions keep using the selected session log. New saved events append to the selected session log instead of creating a replacement session.
- Missing, malformed, invalid, traversal, or no-session resume targets fail before the TUI/static layout opens, with plain error text.
- V0 does not include a `topchester sessions list` command.
- Uses the terminal alternate screen without mouse capture, so terminal text selection keeps working.
- Pressing `Ctrl-C` once shows `press Ctrl-C again to exit.` as a temporary message; pressing `Ctrl-C` again right away exits.
- Shows a scrolling thread area on top with startup context.
- `Up` and `Down` browse submitted prompt history when the normal prompt is active.
- Supports terminal alternate-scroll wheel events, `PageUp`/`PageDown`, and `Home`/`End` for chat history scrolling.
- Shows an unlabeled input box below the thread.
- Shows a status line below the prompt box with `ready`, the current folder name, the active model as `<model> [provider]`, and compact KB state as `✅ kb: ready`, `○ kb: empty`, `⚠ kb: missing`, or `✕ kb: path conflict` after the KB check runs.
- Tracks chat rows as `System`, `You`, and `Agent` messages, and sends user messages to the configured `agent.primary` model.
- Lets the model use workspace-scoped tools: `read_file`, `list_files`, `grep`, `find_file`, `edit_file`, and `inspect_command`.
- `read_file` reads UTF-8 files inside the workspace and returns content hash metadata for stale-read checks.
- `list_files` lists files and directories inside a workspace folder, top-level by default, with optional recursive listing and a result limit.
- `grep` uses `rg` when available, falls back to `grep`, and reports a warning if neither command is installed.
- `find_file` searches existing workspace filenames by fuzzy path or name.
- `edit_file` edits existing UTF-8 files inside the workspace with exact `old_text`/`new_text` replacements. It rejects path escapes, missing files, directories, invalid UTF-8, duplicate or overlapping matches, unchanged output, and stale `expected_hash` values when provided. Successful edits return a compact diff, before/after hashes, first changed line, and mark the KB session overlay as `needs_sync`.
- `inspect_command` runs a small allowlisted set of read-only discovery commands for quick repo orientation, such as `pwd && rg --files docs/plans | head -20`. It validates a narrow shell-like subset itself and runs commands without invoking a shell.
- `inspect_command` supports simple command lists with `&&`, `||`, and `;`, plus pipelines with `|`. It rejects redirects, shell expansion, subshells, background jobs, multiline scripts, `cd`, mutation commands, package managers, interpreters, network commands, Docker/Kubernetes/cloud CLIs, editors, pagers, and process-control commands.
- `inspect_command` keeps its working directory and path arguments inside the workspace, uses short timeouts, bounds returned output, reports exit status/timeout/truncation metadata, and returns a plain rejection reason for unsafe commands.
- Intercepts slash commands before chat, starting with `/kb status`.
- Shows slash command suggestions when the prompt starts with `/`; `Up`/`Down` choose a suggestion and `Tab` completes it.
- Shows a temporary thinking row while waiting for chat responses.
- Checks the configured `agent.fast` model on startup in interactive mode and prints `Agent: ready` when the model responds.
- Skips the startup check with a plain message if the agent takes too long.
- Checks KB status after the agent is ready and refreshes the footer after `/kb init`, `/kb reset`, `/kb compile`, and `/kb status`.
- Shows a warning modal with setup choices when no KB folder exists, or when the KB path is not a folder.
- Uses `Up`/`Down` to navigate active modal choices.
- Shows a temporary spinner row in the chat area while the engine is busy, with copy that says what is happening.
- Shows `press Esc to stop` inside the prompt box while the startup agent check is running.
- Prints a static version of the same layout when output is not interactive.

Slash commands:

- `/kb init` — creates Topchester project folders and prints what was created or already present. Shows a simple progress line while it runs.
- `/kb compile` — reads `.gitignore` files, lists project files, and processes them into L1 file entries with the configured `kb.summarize` model. Shows L1 processing counts and percentage while it runs.
- `/kb sync` — checks project file sync status and processes only non-clean files into L1 entries.
- `/kb reset` — deletes the configured knowledge folder and local cache folder so the project can start clean. Shows a simple progress line while it runs.
- `/kb status` — prints simple workspace KB folder status inside the chat thread.

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
- Lists project files that are not ignored and skips heavy generated folders such as `.git/`, `node_modules/`, `dist/`, `coverage/`, `topchester-kb/`, `.agents/topchester/`, and `.agents/topchester-kb-cache/`, plus the project config file `topchester.jsonc`.
- Applies `ignore.paths` rules from the resolved Topchester config after `.gitignore` and before L1 queueing. Rules come from `~/.config/topchester/config.jsonc`, `topchester.jsonc`, `.topchester/config.local.jsonc`, `TOPCHESTER_CONFIG`, and `--config` in that order. Negated config rules can re-include files ignored by earlier config rules, but cannot re-include built-in excluded folders.
- Queues each listed file for L1 processing in `.agents/topchester-kb-cache/l1-queue.json`.
- Processes the L1 queue with the configured `kb.summarize` model purpose. If `kb.summarize` is not configured, it uses the configured `fallback` model if one exists.
- Writes one current L1 JSON entry per successfully processed file under `topchester-kb/l1-files/`.
- Writes `topchester-kb/manifest.json` with the KB layout version, compiler name/version, queued file count, config ignore rule count, gitignore files read, and L1 outcome counts.
- Prints progress while reading ignore files, listing files, queueing L1 work, processing L1 entries, and writing output. During L1 processing, the CLI shows a progress bar, completed/total count, percentage, and current file path.
- Prints the workspace path, gitignore file count, config ignore rule count, queue path, manifest path, queued count, completed count, failed count, changed count, missing count, current L1 entry count, and final state.
- Exits successfully only when every in-scope file has a current L1 entry. Per-file failed, changed, or missing outcomes print a partial state and set a non-success automation exit code. Fatal setup or model configuration errors fail before claiming L1 entries are current.

### `topchester kb dry-run`

Lists the project files that would be compiled into the knowledge base.

Status: implemented, read-only inventory preview.

Current behavior:

- Does not require `topchester kb init`.
- Does not create knowledge folders, cache folders, queues, manifests, or L1 entries.
- Uses the same project file inventory rules as `topchester kb compile`.
- Reads `.gitignore` files from the workspace, including nested `.gitignore` files.
- Applies default exclusions such as `.git/`, `node_modules/`, `dist/`, `coverage/`, `topchester-kb/`, `.agents/topchester/`, and `.agents/topchester-kb-cache/`.
- Excludes `topchester.jsonc` from the compile inventory.
- Applies `ignore.paths` rules from the resolved Topchester config in the same order as compile.
- Prints the workspace path, knowledge folder path, gitignore file count, config ignore rule count, and file count.
- Prints one line per in-scope file with sync status, path, and size.
- Prints a bottom separator and total file count after the list.
- Reports sync status as `current`, `changed`, `missing_entry`, `missing_file`, `suspect`, or `invalid` by comparing current file metadata with existing L1 entries when the knowledge folder exists.
- Colors the sync status token when color output is enabled.
- Does not call any model provider.

### `topchester kb sync`

Syncs non-clean project files into the knowledge base.

Status: implemented, dirty-file L1 processing.

Current behavior:

- Requires `topchester kb init` to have created the knowledge folder first.
- Uses the same project file inventory and sync-status logic as `topchester kb status`.
- Queues only files whose sync status is not `current`.
- Writes the sync queue to `.agents/topchester-kb-cache/l1-sync-queue.json`.
- Processes queued files with the configured `kb.summarize` model purpose. If `kb.summarize` is not configured, it uses the configured `fallback` model if one exists.
- Does not remove existing current L1 entries that are absent from the dirty-file queue.
- Writes `topchester-kb/manifest.json` with the sync queue path, queued file count, config ignore rule count, gitignore files read, and L1 outcome counts for the sync run.
- Prints the workspace path, gitignore file count, config ignore rule count, queue path, manifest path, queued count, completed count, failed count, changed count, missing count, current L1 entry count, and final state.
- Exits successfully only when every queued non-clean file has a current L1 entry. Per-file failed, changed, or missing outcomes print a partial state and set a non-success automation exit code.

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

Shows files that are not current in the knowledge base.

Status: implemented, read-only non-clean inventory preview.

Current behavior:

- Does not create knowledge folders, cache folders, queues, manifests, or L1 entries.
- Uses the same project file inventory and sync-status logic as `topchester kb dry-run`.
- Applies default exclusions, `.gitignore`, and resolved `ignore.paths` rules.
- Prints the workspace path, knowledge folder path, gitignore file count, config ignore rule count, and non-clean file count.
- Prints only files whose sync status is not `current`.
- Prints one line per non-clean file with sync status, path, and size.
- Prints a bottom separator and total non-clean file count after the list.
- Prints `state: all in-scope files are current` when there are no non-clean files.
- Colors the sync status token when color output is enabled.
- Does not call any model provider.
