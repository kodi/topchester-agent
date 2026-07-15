---
title: Knowledge base
description: How Topchester uses project knowledge, sync commands, and drift checks.
section: Features
order: 40
public: true
---

# Knowledge base

Topchester treats the agent and project knowledge base as one system.

Topchester also ships a separate read-only product knowledge source for its own matching package version. Project knowledge describes the repository you are editing and remains mutable. Product knowledge describes Topchester commands and behavior, is checked against the installed version, and can be used even when the current repository has no project KB.

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
topchester kb sources
topchester kb search --source topchester "ignore paths"
topchester kb context --source all "configure knowledge sync" --json
```

`topchester kb search` and `topchester kb context` still default to `project`. Use `--source project`, `--source topchester`, or `--source all` explicitly when you need another source. The top-level `topchester search` alias remains project-only. `/kb sources` shows the same source diagnostics in the TUI.

`topchester kb init`, `sync`, `dry-run`, `status`, and `reset` always affect only project knowledge. `TOPCHESTER_KB_DIR` selects the project's mutable KB; it does not mount or replace the built-in product source.

V0 treats every in-scope file content change as potentially semantic. Run `/kb status` or `topchester kb status` when you want to see files that are not current in the knowledge base.

Automatic context retrieval searches the project source when it is ready. For Topchester-shaped questions it also searches the product source, caps product matches separately, and keeps the source id, version, path, and content hash in the injected context. `TOPCHESTER_DISABLE_L1_CONTEXT=1` disables both automatic sources without disabling explicit CLI search or skill activation.
