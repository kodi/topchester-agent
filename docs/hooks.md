# Hooks

Topchester hooks let user or project config run small programs at agent lifecycle points. Hooks are configured under `hooks` in the normal layered config files.

Topchester runs each command hook as a child shell process, sends one JSON payload to stdin, waits for the process to exit, and reads an optional JSON response from stdout. Write logs and diagnostics to stderr so stdout can stay reserved for hook responses.

## Configuration

Put hook config in any Topchester config file:

1. `topchester.jsonc` in the workspace root for project-shared hooks.
2. `~/.config/topchester/config.jsonc` for personal user hooks.
3. A custom file selected with `TOPCHESTER_CONFIG=/path/to/config.jsonc`.
4. A custom file selected with `--config <path>`.

Topchester loads those sources in that order. Later files override scalar values and hook arrays concatenate across config layers.

```json
{
  "hooks": {
    "SessionStart": [{ "command": ".topchester/hooks/session-start.sh" }],
    "UserPromptSubmit": [{ "command": ".topchester/hooks/user-prompt.sh" }],
    "PreToolUse": [
      {
        "matcher": "bash",
        "command": ".topchester/hooks/check-command.sh",
        "timeoutMs": 5000,
        "statusMessage": "Checking command policy"
      }
    ],
    "Stop": [{ "command": ".topchester/hooks/stop.sh", "statusMessage": "Sending final notification" }]
  }
}
```

Each handler supports:

- `command` - shell command to execute.
- `matcher` - optional event or tool filter. For tool hooks, match against the tool name such as `bash`; `*` matches everything.
- `timeoutMs` - optional timeout. The default is 5000 ms.
- `statusMessage` - optional visible status text shown when the hook starts, formatted like `🪝 hook>stop: Sending final notification`.

If both a canonical event and its legacy alias are configured, both handler arrays run because aliases normalize into the canonical event.

## Execution

Command hooks run with:

- `cwd` set to the workspace root.
- JSON payload written to stdin with a trailing newline.
- `TOPCHESTER_HOOK_EVENT` set to the canonical event name.
- `TOPCHESTER_HOOK_TOOL` set to the tool name for tool hooks, otherwise an empty string.

Empty stdout means continue. Invalid JSON, a non-zero exit code, timeout, abort, or process spawn failure is logged and does not stop the agent.

## Responses

A hook may write JSON to stdout:

```json
{ "action": "continue", "context": "extra model context" }
```

```json
{ "action": "block", "message": "Do not run deploy commands from this repo." }
```

```json
{ "action": "stop", "message": "Stop after this hook." }
```

Response fields:

- `action` - `continue`, `block`, or `stop`.
- `context` - string or array of strings to append as hook context.
- `message`, `feedback`, or `reason` - user-visible message.
- `cancel: true` - treated as `block`, except on `Stop` where it is treated as `stop`.
- `decision` - compatibility field; `block`, `deny`, or `denied` blocks, and `stop` or `halt` stops.

`block` prevents the current prompt, permission request, or tool use from continuing. `stop` ends the turn.

## Supported Events

| Event               | Alias                | When it runs                                                                                     |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `SessionStart`      | `TaskStart`          | Once when a Topchester session starts or resumes for a workspace/session key.                    |
| `UserPromptSubmit`  | `TaskAcknowledge`    | After the user prompt is accepted and before the agent starts model work.                        |
| `PreToolUse`        | none                 | Before a model-requested tool runs.                                                              |
| `PostToolUse`       | none                 | After a tool returns.                                                                            |
| `PermissionRequest` | `UserActionRequired` | Before Topchester asks the user to approve an interactive action, currently command approval.    |
| `PreCompact`        | none                 | Before context compaction. The hook is supported, but there is no automatic compaction path yet. |
| `Stop`              | `TaskComplete`       | When the turn finishes, with completed or failed status.                                         |

Aliases are accepted in config, but payloads use the canonical event name in `hook_event_name` and `event`.

## Common Payload

Every runtime hook payload starts with the common fields:

```json
{
  "hook_event_name": "Stop",
  "event": "Stop",
  "cwd": "/path/to/workspace",
  "workspaceRoot": "/path/to/workspace",
  "source": "topchester",
  "session_id": "session_...",
  "sessionId": "session_...",
  "session": {
    "sessionId": "session_...",
    "rootSessionId": "session_...",
    "parentSessionId": "session_...",
    "source": "tui"
  },
  "model_purpose": "agent.primary",
  "model_provider": "openrouter",
  "model_id": "anthropic/claude-sonnet-4.5",
  "model_ref": "openrouter/anthropic/claude-sonnet-4.5",
  "model": {
    "purpose": "agent.primary",
    "providerId": "openrouter",
    "modelId": "anthropic/claude-sonnet-4.5",
    "ref": "openrouter/anthropic/claude-sonnet-4.5"
  }
}
```

Session fields are present when a session handle is available. Model fields are present when Topchester can resolve the active `agent.primary` model. If model resolution fails, the hook still runs without model metadata.

## Event Payloads

### SessionStart

Adds:

```json
{
  "isResumed": false,
  "taskStartAlias": "TaskStart"
}
```

### UserPromptSubmit

Adds:

```json
{
  "prompt": { "text": "user prompt text" },
  "prompt_text": "user prompt text",
  "user_prompt": "user prompt text"
}
```

### PreToolUse

Adds tool metadata:

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

`callId` is present when the model/tool protocol provided one.

### PostToolUse

Includes the same tool metadata as `PreToolUse` plus `result`:

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
  },
  "result": {
    "ok": true,
    "value": {}
  }
}
```

The exact `result` shape depends on the tool.

### PermissionRequest

Includes tool metadata and approval details:

```json
{
  "tool_name": "bash",
  "tool_input": {
    "command": "node scripts/local-task.js",
    "workdir": "."
  },
  "tool": {
    "name": "bash",
    "input": {
      "command": "node scripts/local-task.js",
      "workdir": "."
    },
    "callId": "call_..."
  },
  "notification_type": "permission_prompt",
  "permission_mode": "",
  "command": "node scripts/local-task.js",
  "workdir": ".",
  "reason": "command requires approval"
}
```

### PreCompact

Adds:

```json
{
  "reason": "Compaction is about to start."
}
```

### Stop

Adds:

```json
{
  "taskCompleteAlias": "TaskComplete",
  "finalMessage": "Final assistant message.",
  "status": "completed"
}
```

`status` is `completed` or `failed`.

## Peon-Ping Example

Plain notification hooks usually do not need to return JSON. Redirect stdout so status text does not get parsed as a Topchester hook response:

```jsonc
{
  "hooks": {
    "SessionStart": [{ "command": "bash ~/.claude/hooks/peon-ping/peon.sh >/dev/null" }],
    "UserPromptSubmit": [{ "command": "bash ~/.claude/hooks/peon-ping/peon.sh >/dev/null" }],
    "PermissionRequest": [{ "command": "bash ~/.claude/hooks/peon-ping/peon.sh >/dev/null" }],
    "Stop": [{ "command": "bash ~/.claude/hooks/peon-ping/peon.sh >/dev/null" }],
  },
}
```

Use either canonical events or aliases for a given lifecycle point. Configuring both `Stop` and `TaskComplete`, for example, runs both handlers at turn completion.

## YAML Example

The same hook shape works in `topchester.yaml`:

```yaml
hooks:
  SessionStart:
    - command: .topchester/hooks/session-start.sh
  UserPromptSubmit:
    - command: .topchester/hooks/user-prompt.sh
  PreToolUse:
    - matcher: bash
      command: .topchester/hooks/check-command.sh
      timeoutMs: 5000
      statusMessage: Checking command policy
  Stop:
    - command: .topchester/hooks/stop.sh
      statusMessage: Sending final notification
```
