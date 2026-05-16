# Topchester Agent

Topchester is a terminal-native TUI coding agent tightly coupled to a committed project knowledge base.

Read these first:

- `docs/ARCHITECTURE.md` — product/runtime architecture, install flow, TUI/runtime boundaries.
- `docs/KNOWLEDGE.md` — mandatory KB architecture, Knowledge Compiler, drift model, storage/API decisions.
- `docs/SESSIONS.md` — project-local session storage and event log decisions.
- `docs/cli.md` — CLI command inventory and behavior notes.
- `docs/tui.md` — interactive TUI layout, controls, slash commands, and status behavior.

If `AGENTS.override.md` exists, read it after this file for local-only instructions.

Core invariant: Agent and KB are one system. Do not design or implement a normal coding path that bypasses `.agents/topchester-kb/`.

CLI modifications should update `docs/cli.md` in the same change so command behavior stays tracked. TUI behavior changes should update `docs/tui.md`.

## Debugging Topchester

When debugging what the agent actually did, inspect the runtime artifacts before guessing from the UI:

- Main log: `.agents/topchester/logs/topchester.log`. Use the newest file and search for `tool_call`, `tool_result`, `tool_result_content`, `model_prompt`, `model_response_text`, `project_instructions_resolved`, and any specific tool name such as `skill_view` or `read_file`.
- Sessions: `.agents/topchester/sessions/<session-id>/metadata.json` and `events.jsonl`. The latest session is usually the newest `metadata.json`; `events.jsonl` gives the ordered user messages, tool calls, task plan updates, assistant replies, and ready/status events.
- To confirm whether a tool result was actually used, find the tool call in `events.jsonl`, then check `topchester.log` for the following `model_prompt` after that tool result. The prompt should include the `Tool result from ...` block that the model saw.
- For tool behavior bugs, compare the compact session events with the raw log. The session proves the high-level order; `topchester.log` shows raw tool result content, model inputs, model outputs, policy decisions, and timing.
- For TUI or session issues, include `docs/tui.md`, `docs/SESSIONS.md`, and the relevant `src/tui/*` or `src/session/*` files in the investigation.

Use PLAIN FOLK SPEAK in user-facing text, even for highly technical product concepts; for example, write something an average developer understands instead of phrasing like `missing canonical KB`.

Never expose a user's full home directory path in user-facing docs, examples, comments, or responses. Use `~` for home-relative paths.
