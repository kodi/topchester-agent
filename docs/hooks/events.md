---
title: Hook events
description: Supported Topchester hook events and aliases.
section: Hooks
order: 20
public: true
---

# Hook events

Supported events:

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
