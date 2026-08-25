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

All `topchester kb` commands operate on the current workspace's project knowledge. `TOPCHESTER_KB_DIR` selects that mutable project KB.

`topchester kb sync --model provider/model` uses that model for one standalone
sync. For a TUI session, start with `--kb-model provider/model` or use
`/kb-model provider/model`; the choice applies to later `/kb sync` commands in
that session without changing the chat model.

V0 treats every in-scope file content change as potentially semantic. Run `/kb status` or `topchester kb status` when you want to see files that are not current in the knowledge base.

Automatic context retrieval searches the project KB when it is ready. `TOPCHESTER_DISABLE_L1_CONTEXT=1` disables automatic project-context injection without disabling explicit CLI search or skill activation. Questions about Topchester itself use the packaged static `topchester` skill instead of project knowledge.
