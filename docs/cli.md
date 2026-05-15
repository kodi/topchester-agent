# CLI Commands

This document tracks the `topchester` command-line interface. It should stay focused on command options, command behavior, automation output, and exit behavior.

For the interactive terminal UI, keyboard controls, slash commands, and status line behavior, see [TUI Guide](./tui.md).

## Most Used Commands

```sh
topchester
topchester --resume latest
topchester run "Edit greeting.txt and change Hello to Goodbye."
topchester run /kb status
topchester search "status bar"

topchester kb init
topchester kb compile
topchester kb status
topchester kb search "post author update error"
topchester kb context "status bar" --json
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
| `topchester search`     | Search compiled L1 file knowledge.                       |
| `topchester dev`        | Print local development startup details.                 |
| `topchester kb init`    | Create the project knowledge folders.                    |
| `topchester kb compile` | Build current L1 file knowledge for all in-scope files.  |
| `topchester kb context` | Create an L1 context pack for a query.                   |
| `topchester kb dry-run` | Preview which files would be compiled.                   |
| `topchester kb search`  | Search compiled L1 file knowledge.                       |
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
- The coding loop can use workspace-scoped file tools: `read_file`, `list_files`, `grep`, `find_file`, `edit_file`, `write_file`, and `inspect_command`.
- The coding loop can use structured Git tools: `git_status`, `git_diff`, `git_log`, `git_add`, and `git_commit`.
- The coding loop can use `plan_todo` to keep a visible session-only task plan during non-trivial multi-step work. Completed-only `plan_todo` text emitted with a final answer is ignored when no visible plan is open, so accidental closed-plan updates do not render as raw chat text.
- The coding loop can use `task` to delegate focused read-only exploration or isolated analysis to a child agent session. The parent receives a bounded task result while child events are persisted in the child session log and forwarded as runtime events.
- `git_status`, `git_diff`, and `git_log` are the preferred path for Git state, diffs, and recent history. `inspect_command` can still inspect read-only Git commands, but it is an orientation fallback rather than the normal Git workflow.
- `git_add` stages only explicit paths whose current status was acknowledged. It rejects broad pathspecs such as `.` and does not stage unrelated files by default.
- `git_commit` commits only when staged paths exactly match `expected_staged_paths`. The model prompt still tells the agent not to stage or commit unless the user explicitly asks.
- `write_file` creates new UTF-8 files by default. It can create parent directories when explicitly requested, marks the file dirty-known and `needs_sync`, and fails if the target file already exists unless `overwrite: true` is paired with `expected_current_hash` from the latest `read_file` result for that file. The hash is a pre-write stale-read guard, not a predicted after-write hash.
- `edit_file` remains the targeted edit tool for existing files; `inspect_command` remains read-only orientation and is not used for file creation.

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
- Persists `plan_todo` task-plan events to the session log. Resume restores the latest visible plan without adding task-plan rows to future model context.
- Persists child `task` sessions separately under the same project-local session root and records parent-child links in session metadata.
- Includes a per-run `runId` in structured logs when `TOPCHESTER_LOG_LEVEL` enables logging.
- Routes slash-command prompts such as `/kb status` through the same command dispatcher used by the TUI.
- Does not open the interactive TUI.
- Exits non-zero on runtime failure or timeout.

## `topchester search`

Alias for [`topchester kb search`](#topchester-kb-search).

Example:

```sh
topchester search "status bar"
topchester search --json "status bar"
```

## `topchester dev`

Starts local development mode.

Current behavior:

- Prints `Topchester local dev mode`.
- Prints the workspace, resolved model slots, providers, development flags, and log file path when available.

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
- Processes queued files with the configured `kb.summarize` model. If `kb.summarize` is not configured, it uses the `default` model when available.
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
- Processes queued files with the configured `kb.summarize` model. If `kb.summarize` is not configured, it uses the `default` model when available.
- Does not remove existing current L1 entries that are absent from the dirty-file queue.
- Writes `topchester-kb/manifest.json` with sync metadata and L1 outcome counts.
- Prints workspace, queue, manifest, count, and final state details.
- Exits successfully only when every queued non-clean file has a current L1 entry.
- Prints partial state and exits with a non-success automation code when any queued file fails, changes during processing, or is missing.

## `topchester kb search`

Searches compiled L1 file knowledge for the current workspace.

Examples:

```sh
topchester kb search "post author update error"
topchester kb search --limit 5 updatePostAuthor
topchester kb search --json "status bar"
topchester kb query "CMS post service"
```

Current behavior:

- Requires `topchester kb init` and compiled L1 entries from `topchester kb compile` or `topchester kb sync`.
- Loads canonical L1 JSON entries from `topchester-kb/l1-files/`.
- Builds a small in-memory lexical index for the command run.
- Uses weighted matching across file paths, symbols, exports, responsibilities, summaries, imports, relationships, evidence, and known test IDs.
- Splits camelCase, snake_case, paths, and log-like text into query terms.
- Prints ranked matches with score, path, scan status, content hash, match reasons, and summary.
- Supports `--json` for the full structured result object.
- Skips invalid L1 entries and reports how many were skipped.
- Does not call any model provider.

## `topchester kb context`

Creates an L1 context pack for a query.

Examples:

```sh
topchester kb context "status bar"
topchester kb context --json "status bar"
topchester kb context --json --full-l1 "status bar"
topchester kb context --limit 5 --min-score 20 "post author update"
```

Current behavior:

- Requires `topchester kb init` and compiled L1 entries from `topchester kb compile` or `topchester kb sync`.
- Uses the same in-memory lexical index as `topchester kb search`.
- Selects strong matches by score, using a default limit of 8 files and default minimum score of 12.
- Includes compact L1 knowledge for selected files by default: summary, capped responsibilities, capped symbols, capped imports/exports, relationships, tests, confidence, and omitted counts.
- Supports `--full-l1` when the raw full L1 entries are needed for debugging or local inspection.
- Marks drift as `unchecked`; exact hash drift checking remains a separate step.
- Supports `--json` for the structured context pack.
- Does not call any model provider.

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

## Agent Experiment Flags

- `TOPCHESTER_DISABLE_L1_CONTEXT=1` skips automatic L1 context-pack injection for normal agent prompts. The model receives only the retained user/assistant conversation for that turn. KB status checks, `/kb ...` commands, and manual KB search still work.
- `TOPCHESTER_SHOW_TOKEN_USAGE=1` adds cumulative input and output token counts to the assistant metadata line after each agent turn, including model calls made before and after tool use.
- `TOPCHESTER_STREAM_REASONING=1` lets the interactive TUI show provider-exposed reasoning text as dim thinking text above the final answer. It is provider-dependent, not saved, and does not affect `topchester run`.

## Logging

- `TOPCHESTER_LOG_LEVEL=debug` writes structured JSON logs to `.agents/topchester/logs/topchester.log`.
- `TOPCHESTER_LOG_FILE=<path>` overrides the log file path. Relative paths are resolved from the workspace root.
- `debug` logs tool calls, tool result metadata, edit/write metadata, command metadata, Git metadata, and model response metadata.
- `debug` does not log full old/new edit text, full `write_file` content, full Git diff content, or full `inspect_command` output.
- `trace` also logs full model and tool response text.
- Logging is file-only and does not write to the TUI.

## Output Style

- User-facing CLI output should use plain language.
- Color is reserved for useful signal: headings, success, warnings, and errors.
- Spinners and progress lines are used only for work that may take a moment.
- Color and spinner control sequences are not emitted when output is not a TTY, unless `FORCE_COLOR` is set.
