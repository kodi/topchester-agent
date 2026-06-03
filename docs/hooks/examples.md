---
title: Hook examples
description: Practical Topchester hook configurations.
section: Hooks
order: 40
public: true
---

# Hook examples

## Block a command

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "command": ".topchester/hooks/check-command.sh",
      },
    ],
  },
}
```

The script receives the hook payload on stdin. Return a block response to stop the tool:

```json
{ "action": "block", "message": "Run deploy commands manually." }
```

## Play notifications

Use normal command hooks for notification tools. If the command prints status lines, redirect stdout unless you intentionally return Topchester hook-response JSON.

```jsonc
{
  "hooks": {
    "SessionStart": [{ "command": "peon >/dev/null" }],
    "PermissionRequest": [{ "command": "peon >/dev/null" }],
    "Stop": [{ "command": "peon >/dev/null" }],
  },
}
```
