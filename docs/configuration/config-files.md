---
title: Config files
description: Where Topchester configuration lives and how overrides are applied.
section: Configuration
order: 10
public: true
---

# Config files

Topchester config is JSONC. YAML is accepted as a compatibility alias, but JSONC is the normal format.

Topchester loads config in this order. Later files override earlier files.

1. Built-in defaults.
2. `topchester.jsonc` in the workspace root.
3. `~/.config/topchester/config.jsonc`.
4. `TOPCHESTER_CONFIG=/path/to/config.jsonc`.
5. `--config <path>`.

Use `topchester.jsonc` for shared project policy. Use `~/.config/topchester/config.jsonc` for personal provider setup, model choices, and default model preferences.

`.topchester/` is for state, sessions, and caches. It is not a config layer.

## Minimal user config

```jsonc
{
  "models": {
    "default": "openrouter/google/gemini-3.1-flash-lite",
  },
}
```

Topchester automatically reads `OPENROUTER_API_KEY` for OpenRouter shorthand models.
