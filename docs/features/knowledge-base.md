---
title: Knowledge base
description: How Topchester uses project knowledge, sync commands, and drift checks.
section: Features
order: 40
public: true
---

# Knowledge base

Topchester treats the agent and project knowledge base as one system.

The default canonical knowledge path is:

```text
topchester-kb/
```

The default generated cache path is:

```text
.agents/topchester-kb-cache/
```

`topchester-kb/` is meant to be committed when it contains generated project knowledge. `.agents/topchester-kb-cache/` is generated runtime cache and should be ignored.

## Commands

Use the TUI slash commands or the CLI:

```sh
topchester kb init
topchester kb status
topchester kb sync
topchester kb sync --full
topchester kb search "status bar"
topchester kb context "status bar" --json
topchester kb reset
```

V0 treats every in-scope file content change as potentially semantic. Run `/kb status` or `topchester kb status` when you want to see files that are not current in the knowledge base.
