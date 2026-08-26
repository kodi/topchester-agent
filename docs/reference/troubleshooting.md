---
title: Troubleshooting
description: Common Topchester setup and runtime problems.
section: Reference
order: 40
public: true
---

# Troubleshooting

## Model config is missing

If `OPENROUTER_API_KEY` is set, start without config:

```sh
topchester -m openrouter/google/gemini-3.1-flash-lite
```

Inside the TUI, `/model openrouter/google/gemini-3.1-flash-lite` makes the same
session-only selection. Run `/connect openrouter` when you want saved choices,
or edit `~/.config/topchester/config.jsonc` for a durable default. Custom
providers must be defined in config.

To use a separate KB model without config, start with
`--kb-model openrouter/google/gemini-3.1-flash-lite` or enter
`/kb-model openrouter/google/gemini-3.1-flash-lite`. Use `/kb-model clear` to
return to the configured KB model or the default fallback.

For Codex ChatGPT models, run:

```sh
topchester auth login codex --device
```

Then check `topchester auth status` or `topchester info`.

## Codex auth needs relogin

If a Codex request fails because the refresh token was revoked, expired, reused, or belongs to a different account, run:

```sh
topchester auth login codex --device
```

Topchester stores refreshed Codex OAuth credentials in `~/.config/topchester/auth.json` and redacts token values in `topchester auth status` and `topchester info`.

## Knowledge base is missing

Run:

```text
/kb init
```

Then use `/kb status` and `/kb sync` to refresh project knowledge.

## A command needs approval every time

Add a narrow project rule under `tools.bash.allowExact` or `tools.bash.allow` in `topchester.jsonc`. Use `allowExact` for a complete command string and `allow` for argv prefixes.

## Topchester cannot read a path outside the workspace

The file tools stay inside the current workspace. If you name or clearly authorize an absolute external path, Topchester can use `bash` to inspect it. The command keeps its working directory inside the workspace and passes the external path as a command argument. Topchester asks for any required command approval in the same turn. You do not need to ask it to escalate in a second message.

## An MCP server exposes too much

Add `enabledTools` to the server config. If `enabledTools` is omitted, Topchester applies a V0 exposure cap and omits servers that exceed it.
