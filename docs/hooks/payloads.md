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

`PostToolUse` includes the same tool metadata plus `result`. `PermissionRequest` includes the pending approval context. During `topchester run --dangerously-auto-approve`, pending prompts that will be auto-approved include `approval_mode: "auto_allow"` and `auto_approved: true`. `Stop` includes turn completion status.

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

`block` rejects only the current item that triggered the hook. `stop` ends the whole current turn.

For `PreToolUse`, `block` skips the tool call and returns the hook message to the model as a tool error, so the model can continue. For `PermissionRequest`, `block` cancels the pending approval request before any approval modal is shown. For `UserPromptSubmit`, both `block` and `stop` prevent the prompt from reaching the model. For `PostToolUse`, the tool has already run, so use `stop` if the hook must end the turn after seeing the result.
