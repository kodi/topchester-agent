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
topchester kb sync src/agent/runtime/index.ts
topchester kb sync --full
topchester kb live on
topchester kb search "status bar"
topchester kb context "status bar" --json
topchester kb reset
```

All `topchester kb` commands operate on the current workspace's project knowledge. `TOPCHESTER_KB_DIR` selects that mutable project KB.

`topchester kb sync --model provider/model` uses that model for one standalone
sync. For a TUI session, start with `--kb-model provider/model` or use
`/kb-model provider/model`; the choice applies to later `/kb sync` commands in
that session without changing the chat model.

Pass workspace-relative paths to `kb sync` to update only those L1 entries.
This path checks ignore rules and the file SHA directly; it does not list the
whole project or rebuild higher knowledge layers.

`topchester kb live on` or `/kb live on` turns on the durable personal live
mode. If the project has no knowledge folder, turning live mode on initializes
the empty folder structure first. It does not run a full project sync. While
live mode is on, successful `read_file`, `edit_file`, `write_file`, and
apply-patch writes queue the touched file for L1 sync. Work is debounced per
path, processed one file at a time with the `kb.summarize` model, and skipped
when the current L1 entry already has the same SHA. Search, list, grep, and bash
results do not enqueue files.

Missing or empty project knowledge does not add setup guidance or other KB text
to the agent prompt. Live mode does not generate L2/L3 entries, rebuild the
graph, remove orphan entries, or commit `topchester-kb/`.

V0 treats every in-scope file content change as potentially semantic. Run `/kb status` or `topchester kb status` when you want to see files that are not current in the knowledge base. Status reports the live setting, current file count, and non-clean file count. The upper-right footer status shows the current synced count while live mode is idle and temporarily replaces it with the active syncing count while work runs.

Automatic context retrieval searches the project KB when it is ready. `TOPCHESTER_DISABLE_L1_CONTEXT=1` disables automatic project-context injection without disabling explicit CLI search or skill activation. Questions about Topchester itself use the packaged static `topchester` skill instead of project knowledge.
