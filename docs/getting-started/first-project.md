---
title: First project
description: Add project policy, initialize the knowledge base, and run a first task.
section: Intro
order: 40
public: true
---

# First project

Start from the root of the repo you want Topchester to work on.

```sh
topchester
```

## Add project instructions

Use `AGENTS.md` for shared project guidance. Topchester loads `AGENTS.md` before `AGENTS.override.md` at the same scope. Nested instruction files apply inside their folders when tools work there.

Example:

```md
# Project instructions

- Run `pnpm check` before finishing code changes.
- Update docs when CLI behavior changes.
```

## Add project config

Use `topchester.jsonc` for team-shared policy such as allowed commands, ignored paths, MCP servers, and hooks.

Use `~/.config/topchester/config.jsonc` for personal model providers and choices.

## Initialize knowledge

Run this inside the TUI:

```text
/kb init
```

Then ask Topchester to inspect the project and make a small change. Use `/kb status` and `/kb sync` when you want to see or refresh project knowledge.
