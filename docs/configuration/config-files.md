---
title: Config files
description: Where Topchester configuration lives and how overrides are applied.
section: Configuration
order: 10
public: true
---

# Config files

Topchester config is JSONC.

Topchester loads config in this order. Later files override earlier files.

1. Built-in defaults.
2. `topchester.jsonc` in the workspace root.
3. `~/.config/topchester/config.jsonc`.
4. One selected profile: `--config <path>` when supplied, otherwise `TOPCHESTER_CONFIG=/path/to/config.jsonc`.

`--config` and `TOPCHESTER_CONFIG` select the same optional profile slot. If both are present, `--config` is active and the environment-selected file is reported as shadowed by `topchester info`; it is not parsed or merged. Relative environment paths are workspace-relative. Relative CLI paths are resolved from the directory where Topchester was invoked.

Use `topchester.jsonc` for shared project policy. Use `~/.config/topchester/config.jsonc` for personal provider setup, model choices, and default model preferences.

`.topchester/` is for state, sessions, and caches. It is not a config layer.

Config files are immutable inputs while the TUI is running. Model and reasoning
changes made with `-m`, `/model`, or reasoning commands are session runtime
overrides, not config writes. Edit the intended JSONC file when you want a
durable default.

## Minimal user config

```jsonc
{
  "models": {
    "default": "openrouter/google/gemini-3.1-flash-lite",
  },
}
```

Topchester automatically reads `OPENROUTER_API_KEY` for OpenRouter shorthand models.

You can skip model config for a temporary OpenRouter selection:

```sh
OPENROUTER_API_KEY=... topchester -m openrouter/google/gemini-3.1-flash-lite
```

The same full reference works with `/model` and `topchester run -m`. Built-in
OpenRouter and Codex provider defaults exist only in memory unless you explicitly
save provider config. Other provider IDs must be configured in JSONC.

On first startup, Topchester creates `~/.config/topchester/config.jsonc` if it does not exist. The file contains this minimal config as comments:

```jsonc
// {
//   "models": {
//     "default": "openrouter/google/gemini-3.1-flash-lite",
//   },
// }
```

Uncomment and edit it when you want personal model defaults. A comments-only config file is valid and behaves like empty config.
