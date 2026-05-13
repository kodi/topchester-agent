# TUI Guide

This document tracks the interactive terminal UI started by `topchester`.

For command-line options and automation behavior, see [CLI Commands](./cli.md).

## Start The Agent

```sh
topchester
topchester --resume latest
```

Running `topchester` in an interactive terminal opens the chat-style TUI. A plain run starts a fresh project-local session. Resume behavior is controlled by CLI options and is documented in [CLI Commands](./cli.md).

## Basic Layout

The TUI has three main areas:

- Thread area — shows startup context, system messages, your messages, agent replies, and compact tool rows.
- Prompt box — where you type chat messages or slash commands.
- Status line — shows readiness, folder name, active model, provider, and KB state.

The status line uses this shape:

```text
ready · my-project · qwen/qwen3-coder [openrouter] · ✅ kb: ready
```

KB status labels:

- `✅ kb: ready` — the configured KB folder exists and has content.
- `✅ kb: ready | clean` — the KB is ready and checked files are current.
- `✅ kb: ready | N dirty` — the KB is ready, but `N` files are not current.
- `○ kb: empty` — the KB folder exists but has no compiled content yet.
- `⚠ kb: missing` — no KB folder was found.
- `✕ kb: path conflict` — the configured KB path exists but is not a folder.

## Everyday Controls

- Type a message and press `Enter` to send it to the agent.
- Type `/` to see slash command suggestions.
- Use `Up` and `Down` in slash command suggestions to choose an item.
- Press `Tab` while a slash command suggestion is selected to complete it.
- Use `Up` and `Down` in the normal prompt to browse submitted prompt history.
- Use `PageUp`, `PageDown`, `Home`, `End`, or the mouse wheel to scroll chat history.
- Press `Ctrl-C` once to show `press Ctrl-C again to exit.`.
- Press `Ctrl-C` again right away to exit.

While the startup agent check is running, the prompt shows `press Esc to stop`.

## Slash Commands

Slash commands run inside the TUI before a message is sent to the model.

Most used commands:

- `/kb status` — show files that are not current in the knowledge base.
- `/kb sync` — process non-clean project files into L1 entries.
- `/kb compile` — process all in-scope project files into L1 entries.
- `/kb init` — create Topchester project knowledge folders.
- `/kb reset` — delete the local knowledge base and cache.

Example:

```text
/kb status
```

The TUI refreshes the KB status line after `/kb init`, `/kb reset`, `/kb compile`, `/kb sync`, and `/kb status`.

## Startup Checks

Interactive startup does two checks:

1. It checks the configured `agent.fast` model. When the check succeeds, the thread shows `Agent: ready`.
2. It checks KB path health and updates the status line.

If the model check takes too long, startup skips the check and prints a plain message.

If the KB is missing, empty, misconfigured, or not current, the startup KB status message includes a short next step. The footer stays visible so you can keep working while you decide whether to run `/kb init`, `/kb compile`, `/kb sync`, or `/kb status`.

## Agent Tools

The agent can use these workspace-scoped tools from the TUI:

- `read_file` — read a UTF-8 file inside the workspace and return hash metadata.
- `list_files` — list files and folders inside a workspace folder.
- `grep` — search text inside workspace file contents.
- `find_file` — find existing workspace files by fuzzy path or filename.
- `edit_file` — edit existing UTF-8 files with exact `old_text` and `new_text` replacements.
- `inspect_command` — run a small allowlisted set of read-only discovery commands.

Tool activity appears as compact rows in the thread, for example:

```text
read_file: README.md
edit_file: src/example.ts (changed +1/-1)
inspect_command: pwd && rg --files docs/plans | head -20
```

## Progress And Busy States

The TUI shows temporary progress while work is running:

- A thinking row appears while waiting for chat responses.
- KB commands show progress text in the thread area.
- Long L1 processing work shows counts and percent progress.
- The prompt may show `press Esc to stop` while startup or runtime work is active.

## Terminal Behavior

- The TUI uses the terminal alternate screen.
- Mouse capture is not enabled, so normal terminal text selection keeps working.
- Logging is file-only and does not write into the TUI. See [CLI Commands](./cli.md#logging).
