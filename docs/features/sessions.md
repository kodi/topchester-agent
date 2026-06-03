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

Events are append-only JSONL. They include user messages, assistant messages, tool calls, runtime events, task-plan state, and child-session lifecycle events.

Child `task` sessions are stored as normal session folders under the same project-local session root. Parent metadata records the relationship, while child events stay in the child log.
