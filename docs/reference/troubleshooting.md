---
title: Troubleshooting
description: Common Topchester setup and runtime problems.
section: Reference
order: 40
public: true
---

# Troubleshooting

## Model config is missing

Run `/connect openrouter` and then `/model` in the TUI, or edit `~/.config/topchester/config.jsonc` directly.

## Knowledge base is missing

Run:

```text
/kb init
```

Then use `/kb status` and `/kb sync` to refresh project knowledge.

## A command needs approval every time

Add a narrow project rule under `tools.bash.allowExact` or `tools.bash.allow` in `topchester.jsonc`. Use `allowExact` for a complete command string and `allow` for argv prefixes.

## An MCP server exposes too much

Add `enabledTools` to the server config. If `enabledTools` is omitted, Topchester applies a V0 exposure cap and omits servers that exceed it.
