---
title: Project instructions
description: Control how Topchester reads AGENTS.md and related instruction files.
section: Configuration
order: 40
public: true
---

# Project instructions

Topchester loads `AGENTS.md` and then `AGENTS.override.md` from the workspace as live project instructions by default.

Nested instruction files apply inside their folders. Later files at the same scope can override earlier guidance.

You can change the instruction filenames in project config:

```jsonc
{
  "projectInstructions": {
    "enabled": true,
    "files": ["AGENTS.md", "AGENTS.override.md"],
    "fallbackFiles": [],
  },
}
```

`files` are loaded first at each directory level, in order. `fallbackFiles` are opt-in compatibility names loaded after `files`.

Set `enabled: false` to disable project instruction loading. Topchester does not load `CLAUDE.md`, `.clinerules`, `.cursor/rules`, remote URLs, or home-level instruction files by default.
