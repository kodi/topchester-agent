---
name: topchester-config
description: Configure Topchester project and user settings. Use when editing or explaining `topchester.jsonc`, `~/.config/topchester/config.jsonc`, model providers, command policy, ignore paths, hooks, project instruction files, or repo-scoped command approvals.
---

# Topchester Config

## When to Use

Use when the user asks about Topchester configuration, setup, model routing, provider keys, command approvals, ignore rules, hooks, project instructions, or where a setting should live.

Do not use for ordinary application code unless the task touches Topchester config files or Topchester runtime policy.

## Source Of Truth

Before changing config behavior, inspect the implementation and tests:

- `src/config/index.ts`
- `test/config.test.ts`
- `docs/configuration/config-files.md`
- `docs/configuration/models-and-providers.md`
- `docs/configuration/bash-permissions.md`
- `docs/reference/config-schema.md`
- `docs/reference/cli.md`

Prefer the current code and tests over older docs if they disagree, then update docs when the task changes user-facing behavior.

## File Locations

Topchester loads the base config files in this order. Later base files override earlier files:

1. Built-in defaults.
2. `topchester.jsonc`
3. `~/.config/topchester/config.jsonc`
4. One selected profile: `--config <path>` when supplied, otherwise `TOPCHESTER_CONFIG`.

`--config` and `TOPCHESTER_CONFIG` select the same optional profile slot. If both are set, the CLI path is active and the environment path is shadowed rather than parsed or merged.

Use `topchester.jsonc` for team-shared project policy such as ignore paths, hooks, instruction filenames, and command policy. Use `~/.config/topchester/config.jsonc` for personal provider setup, model choices, and API-key environment names.

Do not put secrets in committed config. Prefer `apiKeyEnv` over `apiKey`.

`.topchester/` is for local state, not runtime configuration. `.agents/topchester/` stores sessions and logs. `topchester-kb/` stores compiled knowledge, not runtime configuration.

## Common Shape

Use JSONC for new examples:

```jsonc
{
  "$schema": "https://topchester.com/schemas/config.v1.json",
  "models": {
    "default": "openrouter/anthropic/claude-sonnet-4.5",
    "fast": "openrouter/google/gemini-3.1-flash-lite",
    "kb.summarize": "openrouter/google/gemini-3.1-flash-lite",
    "choices": ["openrouter/anthropic/claude-sonnet-4.5", "openrouter/google/gemini-3.1-flash-lite"],
  },
  "ignore": {
    "paths": ["generated/**"],
  },
  "tools": {
    "bash": {
      "allowExact": ["pnpm test"],
      "allow": [["node", "scripts/check"]],
      "deny": [["pnpm", "publish"]],
    },
  },
}
```

## Models

Topchester exposes these model slots:

- `default`: main agent work and fallback for unspecified slots.
- `fast`: quick checks and lightweight agent work.
- `kb.summarize`: knowledge-base summarization.
- `choices`: models shown by model-selection UI.

Model refs can be provider-qualified strings such as `openrouter/anthropic/claude-sonnet-4.5`, or objects with `name`, optional `provider`, and optional `toolProtocol`.

Provider config lives in the top-level `providers` object:

```jsonc
{
  "models": {
    "default": "anthropic/claude-sonnet-4.5",
  },
  "providers": {
    "default": "openrouter",
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "supportsStructuredOutputs": true,
    },
  },
}
```

Valid `toolProtocol` values are `auto`, `native`, `text-json`, and `text-xml`. Valid OpenRouter routing values are `auto`, `force`, and `off`.

## Command Policy

`bash` runs approval-gated shell commands inside the workspace. Use:

- `tools.bash.allowExact` for exact repo-approved commands.
- `tools.bash.allow` for simple argv prefixes.
- `tools.bash.deny` for blocked argv prefixes.

Command policy rules must be simple command prefixes. Do not include shell operators, redirects, globs, multiline commands, absolute paths, or leading/trailing whitespace.

Repo-scoped command approvals are persisted to `topchester.jsonc` under `tools.bash.allowExact`.

## Ignore Paths

`ignore.paths` only affects Knowledge Compiler inventory. Patterns are workspace-relative globs. Absolute paths and `..` traversal are invalid.

Do not hardcode lockfiles as default ignores. If a project wants to ignore lockfiles, keep that decision in project config.

## Hooks

Hooks live under `hooks` and use command handlers:

```jsonc
{
  "hooks": {
    "SessionStart": [{ "command": "scripts/topchester-start.sh", "statusMessage": "Starting session hook" }],
    "PostToolUse": [
      { "command": "scripts/tool-hook.sh", "matcher": "edit_file", "statusMessage": "Running edit hook" },
    ],
  },
}
```

Canonical hook names are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, and `Stop`.

Legacy aliases are accepted and normalized: `TaskStart`, `TaskAcknowledge`, `UserActionRequired`, and `TaskComplete`.

## Project Instructions

Topchester loads project instruction files such as `AGENTS.md` and `AGENTS.override.md`. Config can adjust instruction loading through:

```jsonc
{
  "instructions": {
    "enabled": true,
    "files": ["AGENTS.md"],
    "fallbackFiles": ["AGENTS.override.md"],
    "maxBytesPerFile": 100000,
    "maxTotalBytes": 500000,
  },
}
```

Instruction filenames must be single filenames, not paths.

## Verification

After config changes, run the narrowest relevant check:

```sh
mise run test
```

For docs-only config guidance, confirm examples match `src/config/index.ts` and `test/config.test.ts`.
