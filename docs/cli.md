# CLI Commands

This document tracks the `topchester` command-line interface. It should stay focused on command options, command behavior, automation output, and exit behavior.

For the interactive terminal UI, keyboard controls, slash commands, and status line behavior, see [TUI Guide](./tui.md).

## Most Used Commands

```sh
topchester
topchester --resume latest
topchester run "Edit greeting.txt and change Hello to Goodbye."
topchester run /kb status

topchester kb init
topchester kb compile
topchester kb status
topchester kb sync
topchester kb reset
```

## Global Options

These options can be used with the top-level command and subcommands:

- `-c, --config <path>` — use an explicit config file.
- `--workspace <path>` — use this workspace root. Defaults to the current working directory.
- `--resume <session>` — resume a project-local session from `.agents/topchester/sessions/`. Use `latest` or an exact lowercase session ID.
- `--dev <flag>` — enable a development-only UI or runtime flag. Can be repeated.
- `-V, --version` — print the CLI package version.
- `-h, --help` — print help.

## Command Overview

| Command                 | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `topchester`            | Start the interactive coding agent.                      |
| `topchester run`        | Run one prompt or slash command without opening the TUI. |
| `topchester dev`        | Print local development startup details.                 |
| `topchester kb init`    | Create the project knowledge folders.                    |
| `topchester kb compile` | Build current L1 file knowledge for all in-scope files.  |
| `topchester kb dry-run` | Preview which files would be compiled.                   |
| `topchester kb sync`    | Rebuild L1 entries only for non-clean files.             |
| `topchester kb reset`   | Delete the local knowledge base and cache.               |
| `topchester kb status`  | Show files that are not current in the knowledge base.   |

## `topchester`

Starts interactive mode.

Common examples:

```sh
topchester
topchester --workspace ../my-app
topchester --resume latest
topchester --resume 0123456789abcdef
```

Current behavior:

- Plain `topchester` starts a fresh session. It does not auto-resume old sessions.
- `--resume latest` restores the newest project-local session.
- `--resume <session-id>` restores that exact project-local session.
- Resumed sessions keep using the selected session log. New saved events append to the selected session log instead of creating a replacement session.
- Session logs live under `.agents/topchester/sessions/` in the workspace.
- Missing, malformed, invalid, traversal, or no-session resume targets fail before the TUI/static layout opens, with plain error text.
- V0 does not include a `topchester sessions list` command.
- In an interactive terminal, the command opens the TUI. See [TUI Guide](./tui.md).
- In non-interactive output, the command prints a static version of the layout.

## `topchester run`

Runs one prompt without opening the TUI.

Common examples:

```sh
topchester run "Read data.txt and summarize it."
topchester run --json "Edit greeting.txt and change Hello to Goodbye."
topchester run --output-json /tmp/topchester-events.jsonl "Run /kb status"
topchester run /kb status
```

Options:

- `--model <model>` — override the `agent.primary` model for this run.
- `--timeout <ms>` — stop the run after this many milliseconds.
- `--json` — write JSONL run events to stdout.
- `--output-json <path>` — write JSONL run events to a file.

Current behavior:

- Creates a project-local session under `.agents/topchester/sessions/`.
- Emits startup KB status before the prompt runs.
- Persists user messages and runtime events to the session log.
- Includes a per-run `runId` in structured logs when `TOPCHESTER_LOG_LEVEL` enables logging.
- Routes slash-command prompts such as `/kb status` through the same command dispatcher used by the TUI.
- Does not open the interactive TUI.
- Exits non-zero on runtime failure or timeout.

## `topchester dev`

Starts local development mode.

Current behavior:

- Prints `Topchester local dev mode`.
- Prints the workspace, default model purpose, model assignments, providers, development flags, and log file path when available.

## `topchester kb init`

Creates the project knowledge folders.

Current behavior:

- Creates `.agents/topchester/`, `.agents/topchester/sessions/`, `.agents/topchester/logs/`, the configured knowledge folder, baseline knowledge subfolders, and the configured local cache folder.
- Baseline knowledge subfolders are `l1-files/`, `l2-modules/`, `l3-features/`, `graph/`, and `reviews/`.
- Prints the workspace path and which folders were created or already existed.
- Prints progress while checking and creating folders.

Run this before `topchester kb compile` in a new project:

```sh
topchester kb init
topchester kb compile
```

## `topchester kb compile`

Compiles the project knowledge base.

Current behavior:

- Requires `topchester kb init` to have created the knowledge folder first.
- Reads `.gitignore` files from the workspace, including nested `.gitignore` files.
- Lists project files that are not ignored.
- Skips heavy generated folders such as `.git/`, `node_modules/`, `dist/`, `coverage/`, `topchester-kb/`, `.agents/topchester/`, and `.agents/topchester-kb-cache/`.
- Excludes `topchester.jsonc` from the compile inventory.
- Applies `ignore.paths` rules from resolved Topchester config after `.gitignore`.
- Queues listed files in `.agents/topchester-kb-cache/l1-queue.json`.
- Processes queued files with the configured `kb.summarize` model. If `kb.summarize` is not configured, it uses `fallback` when available.
- Writes one current L1 JSON entry per successfully processed file under `topchester-kb/l1-files/`.
- Writes `topchester-kb/manifest.json` with compiler metadata, input counts, ignore counts, and L1 outcome counts.
- Prints workspace, queue, manifest, count, and final state details.
- Shows progress while reading ignore files, listing files, queueing work, processing L1 entries, and writing output.
- Exits successfully only when every in-scope file has a current L1 entry.
- Prints partial state and exits with a non-success automation code when any queued file fails, changes during processing, or is missing.
- Fails early for fatal setup or model configuration errors.

## `topchester kb dry-run`

Lists the files that would be compiled into the knowledge base.

Current behavior:

- Does not require `topchester kb init`.
- Does not create knowledge folders, cache folders, queues, manifests, or L1 entries.
- Uses the same project file inventory rules as `topchester kb compile`.
- Prints the workspace path, knowledge folder path, gitignore file count, config ignore rule count, and file count.
- Prints one line per in-scope file with sync status, path, and size.
- Reports sync status as `current`, `changed`, `missing_entry`, `missing_file`, `suspect`, or `invalid` when an existing knowledge folder can be checked.
- Does not call any model provider.

Use it before a full compile when you want to inspect scope:

```sh
topchester kb dry-run
```

## `topchester kb sync`

Syncs non-clean project files into the knowledge base.

Current behavior:

- Requires `topchester kb init` to have created the knowledge folder first.
- Uses the same project file inventory and sync-status logic as `topchester kb status`.
- Queues only files whose sync status is not `current`.
- Writes the sync queue to `.agents/topchester-kb-cache/l1-sync-queue.json`.
- Processes queued files with the configured `kb.summarize` model. If `kb.summarize` is not configured, it uses `fallback` when available.
- Does not remove existing current L1 entries that are absent from the dirty-file queue.
- Writes `topchester-kb/manifest.json` with sync metadata and L1 outcome counts.
- Prints workspace, queue, manifest, count, and final state details.
- Exits successfully only when every queued non-clean file has a current L1 entry.
- Prints partial state and exits with a non-success automation code when any queued file fails, changes during processing, or is missing.

## `topchester kb reset`

Deletes the local project knowledge base and cache.

Current behavior:

- Deletes the configured knowledge folder and configured local cache folder.
- Uses these default paths:
  - Knowledge folder: `topchester-kb/`
  - Local cache folder: `.agents/topchester-kb-cache/`
- Supports path overrides through `TOPCHESTER_KB_DIR` and `TOPCHESTER_KB_CACHE_DIR`.
- Prints each removed path, or `already missing` for paths that were not present.
- Refuses to delete the workspace root or a filesystem root if a path is misconfigured.

After reset, run `topchester kb init` to start clean.

## `topchester kb status`

Shows files that are not current in the knowledge base.

Current behavior:

- Does not create knowledge folders, cache folders, queues, manifests, or L1 entries.
- Uses the same project file inventory and sync-status logic as `topchester kb dry-run`.
- Applies default exclusions, `.gitignore`, and resolved `ignore.paths` rules.
- Prints the workspace path, knowledge folder path, gitignore file count, config ignore rule count, and non-clean file count.
- Prints only files whose sync status is not `current`.
- Prints one line per non-clean file with sync status, path, and size.
- Prints `state: all in-scope files are current` when there are no non-clean files.
- Does not call any model provider.

Use this as the cheap check before deciding whether to sync:

```sh
topchester kb status
topchester kb sync
```

## Logging

- `TOPCHESTER_LOG_LEVEL=debug` writes structured JSON logs to `.agents/topchester/logs/topchester.log`.
- `TOPCHESTER_LOG_FILE=<path>` overrides the log file path. Relative paths are resolved from the workspace root.
- `debug` logs tool calls, tool result metadata, edit metadata, command metadata, and model response metadata.
- `debug` does not log full old/new edit text or full `inspect_command` output.
- `trace` also logs full model and tool response text.
- Logging is file-only and does not write to the TUI.

## Output Style

- User-facing CLI output should use plain language.
- Color is reserved for useful signal: headings, success, warnings, and errors.
- Spinners and progress lines are used only for work that may take a moment.
- Color and spinner control sequences are not emitted when output is not a TTY, unless `FORCE_COLOR` is set.
