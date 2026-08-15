---
title: Sessions
description: Understand project-local session storage, resume behavior, and child sessions.
section: Features
order: 30
public: true
---

# Sessions

Topchester sessions are project-local. Full session data is stored under:

```text
.agents/topchester/sessions/
  <session-id>/
    metadata.json
    events.jsonl
```

Do not commit session files.

Use `--resume latest` to restore the newest project-local session, or pass an exact session id:

```sh
topchester --resume latest
topchester --resume 0123456789abcdef
```

Use `/restore` in the TUI to pick a previous project-local session without leaving interactive mode. The picker lists top-level user sessions from the current workspace, excludes the active session and child `task` sessions, and shows each row as updated date, short session ID, and a short session title. Topchester stores that title from the first normal user prompt by flattening whitespace and shortening it to at most 72 characters; visible-only slash commands do not become titles. Older sessions without a stored title get the same title when listed, and empty sessions show `(no user prompt)`. Press `Esc` to cancel without changing the active session or session log. Press `Enter` to switch to the selected session; future events append to that restored session log and Topchester adds one visible restore notice there.

Use `/fork` in the TUI to clone the active session into a fresh top-level session and switch to it. Use `topchester fork --last` or `topchester fork <session-id>` to fork a saved project-local session before opening the fork. A fork keeps an explicit title when one is supplied; otherwise it inherits the source title or derives one from the copied first normal user prompt.

Events are append-only JSONL. They include user messages, assistant messages, tool calls, runtime events, task-plan state, runtime model/effort snapshots, and child-session lifecycle events. Runtime config events contain only model references and effort enum values; provider definitions, URLs, headers, API keys, and auth records stay out of session logs.

`/model`, `/models`, `/effort`, and `/reasoning` update the current session's runtime snapshot. `--resume` and `/restore` apply the latest valid snapshot before rendering or sending a model request. A fork inherits its source snapshot and can then diverge independently. `/new` starts with empty overrides and the currently loaded JSONC defaults. Old sessions without runtime config events continue to load with empty overrides.

If a saved provider no longer exists in the currently selected profile, Topchester drops only the invalid saved entries, keeps any valid entries, and shows a warning instead of making the session impossible to open.

Fork metadata records the source session ID and source root session ID. The source log is not changed by a successful fork. Forks do not copy child `task` session folders in V0; copied parent transcript rows can still include historical child-session lifecycle events.

Child `task` sessions are stored as normal session folders under the same project-local session root. Parent metadata records the relationship, while child events stay in the child log.

Use `topchester session debug <session>` to inspect a saved session and its child-session tree. The selector accepts `latest`, an exact session ID, or a unique prefix. The default report includes event and tool counts, child outcomes, longest event gaps, artifact coverage, and any available model, tool, hook, setup, approval, subagent-wait, and other timing percentages. Add `--json` for the complete machine-readable report.

The terminal report groups those details into labeled sections, shows timing percentages as compact bars, and marks healthy, active, failed, missing, and warning states with both icons and semantic color. It remains readable without color and does not emit color codes when output is redirected or `NO_COLOR` is set.

Session events always provide order and mixed event gaps. Exact timing breakdowns require `TOPCHESTER_LOG_LEVEL=debug` or `trace` before the measured work starts. New timing records include session and turn identifiers, so the report can separate concurrent root and child work. Old unscoped log entries are not assigned to a session.
