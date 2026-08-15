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

Assistant replies show a muted compact metadata line with the model and elapsed time. Set `TOPCHESTER_SHOW_TOKEN_USAGE=1` to also show cumulative input, output, cache-read, and cache-write token counts for the full turn, including tool-loop model calls. If the model response includes cost data, the same metadata also shows the total USD cost for the turn.

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
- On a new session, Topchester shows a one-time prompt hint in the thread: `Prompt hint: Enter sends, Shift+Enter adds a line, / opens commands, ↑↓ browse history.` It stays visible through startup checks and disappears after your first message or slash command.
- The prompt shows up to five input lines; longer drafts scroll inside the prompt box.
- Large bracketed pastes are shown as a compact `[Pasted #N ...]` preview and expanded when submitted.
- Type `/` to see slash command suggestions.
- Use `Up` and `Down` in slash command suggestions to choose an item; the suggestion panel scrolls to keep the selected command visible.
- Press `Tab` while a slash command suggestion is selected to complete it.
- Type `/new` to clear the terminal and start a fresh session in the same workspace.
- Type `/fork` to clone the current session into a new session and switch to that fork.
- Type `/restore` to open a previous-session picker and switch to a saved session.
- Type `/queue <prompt>` to queue a follow-up prompt.
- Type `/steer <prompt>` to send best-effort guidance to the active turn.
- Type `/skills` to open the Skills overlay.
- Use `Up` and `Down` in the normal prompt to browse submitted prompt history.
- Use your terminal scrollback to review chat history with the mouse wheel, touchpad, scrollbar, or terminal shortcuts such as `Shift+PageUp`.
- Press `Ctrl-C` once to show `press Ctrl-C again to exit.`.
- Press `Ctrl-C` again right away to exit.

While the startup agent check is running, the prompt shows `press Esc to stop`.

While a chat turn is running, the prompt stays editable. Pressing `Enter` on normal text queues it as the next follow-up turn. Queued prompts are local to the running TUI process and are not saved as user messages until they actually start. A compact `queued: N follow-up` line appears while follow-ups are waiting.

`/queue <prompt>` explicitly queues a follow-up. When the agent is idle, it starts immediately like a normal prompt. `/q <prompt>` is the short alias.

`/steer <prompt>` sends guidance to the active turn. If the runtime reaches a safe tool-result checkpoint, the guidance is folded into the next model prompt without adding a visible user row. If it is not consumed before the active turn completes, Topchester queues it as a follow-up so the text is not lost.

V0 does not persist queued drafts across restarts, does not provide queue editing or deletion, and does not expose configurable busy input modes. Switching sessions with `/new`, `/fork`, or `/restore` drops queued follow-ups and pending steering with a visible notice.

## Slash Commands

Slash commands run inside the TUI before a message is sent to the model.

Most used commands:

- `/model` — choose from configured model choices.
- `/model all [search]` — browse OpenRouter models and add one to choices.
- `/connect` — connect a model provider.
- `/new` — clear the terminal and start a fresh project-local session.
- `/fork` — clone the current session into a new project-local session.
- `/restore` — pick a previous project-local session and switch to it.
- `/queue <prompt>` — queue a follow-up prompt, or start it immediately when idle.
- `/q <prompt>` — short alias for `/queue`.
- `/steer <prompt>` — steer the active turn, with queued fallback if it is not consumed.
- `/skills` — open the Skills overlay.
- `/skills <query>` — open the Skills overlay filtered by text.
- `/skills list` — print available skills.
- `/skills inspect <name>` — show full `SKILL.md` content without activating the skill.
- `/skills reload` — reload skill discovery.
- `/skill <name> [instruction]` — activate a skill, either immediately with the instruction or for the next message.
- `/<skill-name> [instruction]` — activate a skill when the name does not conflict with a built-in slash command.
- `/kb status` — show files that are not current in the knowledge base.
- `/kb sync` — process non-clean project files into L1 entries.
- `/kb sync --full` — process all in-scope project files into L1 entries.
- `/kb init` — create Topchester project knowledge folders.
- `/kb reset` — delete the local knowledge base and cache.

Example:

```text
/kb status
```

`/connect` opens the provider picker. V0 includes OpenRouter. Choosing OpenRouter writes provider setup to `~/.config/topchester/config.jsonc` with `apiKeyEnv: OPENROUTER_API_KEY`; it does not write the API key itself. If `OPENROUTER_API_KEY` is set, Topchester asks OpenRouter for user-filtered text models. If that request is not available, it falls back to the public model list or a small starter shortlist.

`/model` opens a picker from `models.choices`. Model refs use `<provider>/<provider-native-model-id>`, such as `openrouter/qwen/qwen3-coder`; OpenRouter picker labels omit the leading `openrouter/` for readability. Choosing a model selects it for the current session and refreshes the footer model label without editing JSONC. `/models` is an alias for `/model`.

`/model all [search]` asks OpenRouter for text models that support tool parameters, shows matching results in a scrollable picker, saves the selected model to the global choices catalog, and selects it for the current session. If a selected profile supplies its own `models.choices`, that list can continue to shadow the updated global catalog; the selected model still works in the current session.

`/effort <value>` and `/reasoning <value>` set a provider-level override for the current session. `clear` and `default` remove the session override and reveal the effort configured in JSONC or the provider default. Model and effort overrides survive exit/resume, restore, and fork. `/new` clears them and starts from the loaded JSONC defaults.

`/new` keeps you in the same workspace but replaces the current thread with a normal startup screen, creates a new session folder, clears runtime model and effort overrides, clears prompt history, and reruns startup checks.

`/fork` keeps the current transcript and runtime model/effort selection, creates a fresh top-level session ID, records fork lineage in metadata, adds one system notice in the fork, and switches future messages to the fork. The source session log is left untouched. V0 does not copy child `task` session folders.

`/restore` replaces the thread area with a previous-session picker while leaving the prompt box and status line visible. Rows show the session updated date, short session ID, and the first normal user prompt truncated to one line. The current active session and child `task` sessions are excluded. Use `Up` and `Down` to move, `Enter` to restore the selected session, and `Esc` to cancel without changing the active transcript or session log. After restore, the selected session's runtime model and effort are applied, future messages append to that session, and Topchester adds one visible restore notice.

`/skills` opens a modal overlay. Use `Up` and `Down` to choose a skill, `Enter` to inspect it, and the modal actions to activate, reload, go back, or close. Activating from the overlay applies the skill to the next message. `/skills <query>` opens the same overlay filtered by skill name, description, or source.

You can also activate active skills from normal prompts with `@skill-name`, such as `@code-review review this diff`. Unknown mentions stay normal text. Multiple skill mentions are applied in mention order.

The TUI refreshes the KB status line after `/kb init`, `/kb reset`, `/kb sync`, `/kb sync --full`, and `/kb status`.

## Startup Checks

Interactive startup does two checks:

1. It checks the configured `agent.fast` model. When the check succeeds, the thread shows `Agent: ready`.
2. It checks KB path health and updates the status line.

If root `AGENTS.md` or `AGENTS.override.md` instructions are present, startup shows a compact `Project instructions: ...` line. When both exist, the line lists both files. The footer does not add a separate instruction status.

If the model check takes too long, startup skips the check and prints a plain message.

If model config is missing, startup shows a hint to run `/connect openrouter` and then `/model`, or to edit `topchester.jsonc` for shared project choices and `~/.config/topchester/config.jsonc` for personal defaults.

If the KB is missing, empty, misconfigured, or not current, the startup KB status message includes a short next step. The footer stays visible so you can keep working while you decide whether to run `/kb init`, `/kb sync`, `/kb sync --full`, or `/kb status`.

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
- `bash` — run an approval-gated shell command inside the workspace, including tests, lint, typecheck, builds, checks, and smoke scripts.
- `skills_list` — list available skills as compact metadata.
- `skill_view` — load full `SKILL.md` content for one skill.

Tool activity appears as compact rows in the thread. These rows come from tool events, so regular system messages are still rendered as system messages even if their text mentions a tool name.

Configured lifecycle hooks run during the same agent loop. Hook `statusMessage` feedback appears as a temporary thread line and disappears after 2 seconds. A `PreToolUse` hook can block a tool before it runs; the blocked result is shown as the tool row and sent back to the model so it can continue safely. `UserActionRequired` hooks run before interactive approval prompts. External integrations such as peon-ping can play sounds by running through normal command hooks.

`AGENTS.md` and `AGENTS.override.md` are protected because they change future agent behavior. Ask directly to update project instructions, or name the instruction file, when you want the agent to edit one.

When the agent uses `plan_todo`, the current plan is pinned above the prompt instead of repeated as chat prose. It also prints a short transient notice such as `todo plan created`, `todo plan updated`, `todo plan completed`, or `todo plan cleared`. The pinned plan renders only the task items with status-colored `completed`, `in_progress`, and `pending` markers. It hides when empty, caps long plans, is restored from the latest session event on resume, and clears automatically when a new user message starts.

Examples:

```text
plan_todo: 3 items, 1 active
read_file: README.md
↳ task: Inspect runtime (running)
↳ task: Inspect runtime (completed)
edit_file: src/example.ts (changed +1/-1)
inspect_command: pwd && rg --files docs/plans | head -20
bash: pnpm test test/tools.test.ts (exit 0, 2.1s)
```

## Progress And Busy States

The TUI shows temporary progress while work is running:

- A thinking row appears while waiting for chat responses.
- KB commands show progress text in the thread area.
- Long L1 processing work shows counts and percent progress.
- The prompt may show `press Esc to stop` while startup or runtime work is active.
- Temporary thread lines can be set with an optional `expireAfterMs` timeout. Hook `statusMessage` feedback uses this path so busy spinner updates and model completion rows do not clear it before the timeout.

Set `TOPCHESTER_STREAM_REASONING=1` before starting the interactive TUI to show provider-exposed reasoning text while the agent works. This is provider-dependent: models that stream reasoning show recent thinking updates as separate dim rows, models that only expose a final reasoning summary may show that summary, and unsupported providers keep the normal spinner text. Markdown-style bold headings are shown as plain status text instead of raw `**` markers. The spinner and stop hint stay beside the newest update. When the answer arrives, the thinking text stays visible above the final answer for that turn. It is not saved in session history, JSON run output, model conversation history, or KB data.

This flag only affects interactive `topchester` chat turns. It does not make `topchester run` print reasoning, and it does not apply to startup checks or slash commands.

## Terminal Behavior

- The TUI renders inline instead of using the terminal alternate screen, so scrollback stays available.
- Mouse reporting is not enabled, so touchpad scrolling and text selection stay native to your terminal.
- Logging is file-only and does not write into the TUI. See [CLI Commands](./cli.md#logging).
