---
title: Hook payloads
description: Common and event-specific JSON fields sent to command hooks.
section: Hooks
order: 30
public: true
---

# Hook payloads

Every runtime hook payload starts with common fields:

```json
{
  "hook_event_name": "Stop",
  "event": "Stop",
  "cwd": "/path/to/workspace",
  "workspaceRoot": "/path/to/workspace",
  "source": "topchester",
  "session_id": "session_...",
  "sessionId": "session_...",
  "model_ref": "openrouter/anthropic/claude-sonnet-4.5"
}
```

Session fields are present when a session handle is available. Model fields are present when Topchester can resolve the active `agent.primary` model.

`PreToolUse` adds tool metadata:

```json
{
  "tool_name": "bash",
  "tool_input": {
    "command": "pnpm test",
    "workdir": "."
  },
  "tool": {
    "name": "bash",
    "input": {
      "command": "pnpm test",
      "workdir": "."
    },
    "callId": "call_..."
  }
}
```

`PostToolUse` includes the same tool metadata plus `result`. `PermissionRequest` includes the pending approval context. `Stop` includes turn completion status.

## Responses

Empty stdout means continue. A hook may write JSON to stdout:

```json
{ "action": "continue", "context": "extra model context" }
```

```json
{ "action": "block", "message": "Do not run deploy commands from this repo." }
```

```json
{ "action": "stop", "message": "Stop after this hook." }
```

`block` prevents the current prompt, permission request, or tool use from continuing. `stop` ends the turn.
