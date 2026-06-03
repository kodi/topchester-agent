---
title: Hooks overview
description: Configure lifecycle hooks that run small programs during agent work.
section: Hooks
order: 10
public: true
---

# Hooks overview

Topchester hooks let user or project config run small programs at agent lifecycle points.

Topchester starts each command hook as a child shell process, sends one JSON payload to stdin, waits for the process to exit, and reads an optional JSON response from stdout.

Write logs and diagnostics to stderr so stdout can stay reserved for hook responses.

## Example

```jsonc
{
  "hooks": {
    "SessionStart": [{ "command": ".topchester/hooks/session-start.sh" }],
    "UserPromptSubmit": [{ "command": ".topchester/hooks/user-prompt.sh" }],
    "PreToolUse": [
      {
        "matcher": "bash",
        "command": ".topchester/hooks/check-command.sh",
        "timeoutMs": 5000,
        "statusMessage": "Checking command policy",
      },
    ],
    "Stop": [{ "command": ".topchester/hooks/stop.sh" }],
  },
}
```

Hook arrays concatenate across config layers. If both a canonical event and its legacy alias are configured, both handler arrays run because aliases normalize into the canonical event.
