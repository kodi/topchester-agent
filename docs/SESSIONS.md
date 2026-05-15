# Sessions

Topchester sessions start as project-local state.

## Decision

- Store full sessions inside the workspace under `.agents/topchester/sessions/`.
- Use append-only JSONL event logs for session history.
- Do not commit session files.
- Do not start with global session storage.
- A global recent-session index can be added later, but it should only point to project sessions and store small metadata.

## Why project-local first

Sessions are tied to the project being edited:

- current folder,
- model/provider config used for the run,
- chat messages,
- tool calls,
- command output,
- file edits,
- KB state and drift warnings.

Keeping that data beside the project makes resume/replay simpler and avoids mixing unrelated repositories.

## Initial shape

```text
.agents/topchester/sessions/
  <session-id>/
    events.jsonl
    metadata.json
```

`events.jsonl` is the source of truth. Each line is one event.

Early event kinds:

- `message` — user, agent, or system-visible chat row.
- `status` — transient or persisted state changes.
- `tool_call` — command/tool request.
- `task_plan` — visible session-only task plan state.
- `choice` — visible user choice prompt.
- `subagent_started` — parent log reference to a child session starting.
- `subagent_event` — parent log reference to a forwarded child runtime event.
- `subagent_completed` — parent log reference to a child session completing.
- `subagent_failed` — parent log reference to a child session failing.

`metadata.json` includes the root session identity and, for child sessions, the
parent link:

```json
{
  "version": 1,
  "sessionId": "019e0000-0000-7000-8000-000000000000",
  "rootSessionId": "019e0000-0000-7000-8000-000000000000",
  "parentSessionId": "019e0000-0000-7000-8000-000000000000",
  "parentToolCallId": "task-call-1",
  "source": "subagent",
  "agentProfileId": "explore",
  "title": "Inspect runtime"
}
```

For existing sessions that do not have tree fields, loaders treat `source` as
`user` and `rootSessionId` as the session's own `sessionId`. That keeps older
project-local sessions readable without rewriting their JSONL.

Keep model-facing chat roles separate from UI/runtime events. The TUI can show both, but model context should only include what the agent runtime intentionally selects.
