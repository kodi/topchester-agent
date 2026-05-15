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
- Visible plan block — appears above the prompt when the agent is working through a session task plan.
- Prompt box — where you type chat messages or slash commands.
- Status line — shows readiness, folder name, active model, provider, and KB state.

The status line uses this shape:

```text
ready · my-project · qwen/qwen3-coder [openrouter] · ✅ kb: ready
```

Assistant replies show a compact metadata line with the model and elapsed time. Set `TOPCHESTER_SHOW_TOKEN_USAGE=1` to also show cumulative input and output token counts for the full turn, including tool-loop model calls.

KB status labels:

- `✅ kb: ready` — the configured KB folder exists and has content.
- `✅ kb: ready | clean` — the KB is ready and checked files are current.
- `✅ kb: ready | N dirty` — the KB is ready, but `N` files are not current.
- `○ kb: empty` — the KB folder exists but has no compiled content yet.
- `⚠ kb: missing` — no KB folder was found.
- `✕ kb: path conflict` — the configured KB path exists but is not a folder.

## Everyday Controls

- Type a message and press `Enter` to send it to the agent.
- Press `Shift+Enter` to add a new prompt line in terminals that report it distinctly.
- The prompt shows up to five input lines; longer drafts scroll inside the prompt box.
- Large bracketed pastes are shown as a compact `[Pasted #N ...]` preview and expanded when submitted.
- Type `/` to see slash command suggestions.
- Use `Up` and `Down` in slash command suggestions to choose an item.
- Press `Tab` while a slash command suggestion is selected to complete it.
- Type `/new` to clear the terminal and start a fresh session in the same workspace.
- Use `Up` and `Down` in the normal prompt to browse submitted prompt history.
- Use your terminal scrollback to review chat history with the mouse wheel, touchpad, scrollbar, or terminal shortcuts such as `Shift+PageUp`.
- Press `Ctrl-C` once to show `press Ctrl-C again to exit.`.
- Press `Ctrl-C` again right away to exit.

While the startup agent check is running, the prompt shows `press Esc to stop`.

## Slash Commands

Slash commands run inside the TUI before a message is sent to the model.

Most used commands:

- `/new` — clear the terminal and start a fresh project-local session.
- `/kb status` — show files that are not current in the knowledge base.
- `/kb sync` — process non-clean project files into L1 entries.
- `/kb compile` — process all in-scope project files into L1 entries.
- `/kb init` — create Topchester project knowledge folders.
- `/kb reset` — delete the local knowledge base and cache.

Example:

```text
/kb status
```

`/new` keeps you in the same workspace but replaces the current thread with a normal startup screen, creates a new session folder, clears prompt history, and reruns startup checks.

The TUI refreshes the KB status line after `/kb init`, `/kb reset`, `/kb compile`, `/kb sync`, and `/kb status`.

## Startup Checks

Interactive startup does two checks:

1. It checks the configured `agent.fast` model. When the check succeeds, the thread shows `Agent: ready`.
2. It checks KB path health and updates the status line.

If the model check takes too long, startup skips the check and prints a plain message.

If the KB is missing, empty, misconfigured, or not current, the startup KB status message includes a short next step. The footer stays visible so you can keep working while you decide whether to run `/kb init`, `/kb compile`, `/kb sync`, or `/kb status`.

## Agent Tools

The agent can use these workspace-scoped tools from the TUI:

- `task` — delegate focused read-only exploration or isolated analysis to a child agent session.
- `plan_todo` — replace the visible session task plan for multi-step work.
- `read_file` — read a UTF-8 file inside the workspace and return hash metadata.
- `list_files` — list files and folders inside a workspace folder.
- `grep` — search text inside workspace file contents.
- `find_file` — find existing workspace files by fuzzy path or filename.
- `edit_file` — edit existing UTF-8 files with exact `old_text` and `new_text` replacements.
- `inspect_command` — run a small allowlisted set of read-only discovery commands.
- `run_validator` — run a strict test, lint, typecheck, build, check, format-check, or smoke command.
- `run_command` — run a validator or project command allowed by command policy.

Tool activity appears as compact rows in the thread. These rows come from tool events, so regular system messages are still rendered as system messages even if their text mentions a tool name.

When the agent uses `plan_todo`, the current plan is pinned above the prompt instead of repeated as chat prose. It also prints a short transient notice such as `todo plan created`, `todo plan updated`, `todo plan completed`, or `todo plan cleared`. The pinned plan renders only the task items with status-colored `completed`, `in_progress`, and `pending` markers. It hides when empty, caps long plans, is restored from the latest session event on resume, and clears automatically when a new user message starts.

Examples:

```text
plan_todo: 3 items, 1 active
read_file: README.md
↳ task: Inspect runtime (running)
↳ task: Inspect runtime (completed)
edit_file: src/example.ts (changed +1/-1)
inspect_command: pwd && rg --files docs/plans | head -20
run_validator: pnpm test test/tools.test.ts (exit 0, 2.1s)
run_command: node scripts/check-fixtures.mjs (exit 0, 0.7s)
```

## Progress And Busy States

The TUI shows temporary progress while work is running:

- A thinking row appears while waiting for chat responses.
- KB commands show progress text in the thread area.
- Long L1 processing work shows counts and percent progress.
- The prompt may show `press Esc to stop` while startup or runtime work is active.

Set `TOPCHESTER_STREAM_REASONING=1` before starting the interactive TUI to show provider-exposed reasoning text while the agent works. This is provider-dependent: models that stream reasoning show dim wrapped thinking text, models that only expose a final reasoning summary may show that summary, and unsupported providers keep the normal spinner text. When the answer arrives, the thinking text stays visible above the final answer for that turn. It is not saved in session history, JSON run output, model conversation history, or KB data.

This flag only affects interactive `topchester` chat turns. It does not make `topchester run` print reasoning, and it does not apply to startup checks or slash commands.

## Terminal Behavior

- The TUI renders inline instead of using the terminal alternate screen, so scrollback stays available.
- Mouse reporting is not enabled, so touchpad scrolling and text selection stay native to your terminal.
- Logging is file-only and does not write into the TUI. See [CLI Commands](./cli.md#logging).
