---
title: Models and providers
description: Configure model slots and OpenAI-compatible providers.
section: Configuration
order: 20
public: true
---

# Models and providers

Model references use `provider/model-id`. The first slash separates the provider,
so nested model IDs such as `openrouter/google/gemini-3.1-flash-lite` work as-is.

For a temporary selection, no model config is needed:

```sh
OPENROUTER_API_KEY=... topchester -m openrouter/google/gemini-3.1-flash-lite
```

OpenRouter and Codex are built-in providers. Topchester can materialize their
provider defaults in memory when a CLI or slash-command reference uses them.
Custom provider IDs must be defined under `providers` in JSONC.

Topchester has three user-facing model slots:

- `default` runs the main agent and fills in unspecified model work.
- `fast` runs quick checks and lightweight agent calls.
- `kb.summarize` runs knowledge-base summarization.

If `fast` or `kb.summarize` is omitted, Topchester uses `default`.

## One OpenRouter model

```jsonc
{
  "models": {
    "default": "openrouter/google/gemini-3.1-flash-lite",
  },
}
```

## Separate fast and KB models

```jsonc
{
  "models": {
    "default": "openrouter/anthropic/claude-sonnet-4.5",
    "fast": "openrouter/google/gemini-3.1-flash-lite",
    "kb.summarize": "openrouter/google/gemini-3.1-pro",
  },
}
```

## Custom provider

Use this shape for OpenAI-compatible endpoints such as OpenRouter, LiteLLM, vLLM, LM Studio, Ollama, or local OpenAI-compatible proxies:

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

Prefer `apiKeyEnv` over `apiKey` so secrets stay out of config files.

## Interactive selection

`/model provider/model-id` selects that exact model for the current session,
even when it is not in `models.choices`. Bare `/model` and `/models` open the
saved choices picker. `/model all [search]` browses the OpenRouter catalog and
can add a choice. `/effort` and `/reasoning` set a provider-level effort override
for the current session. These controls never write the effective merged config
back to disk.

Use `--kb-model provider/model-id` at startup or with `topchester run` to select
only the knowledge-base summary model. Inside the TUI, `/kb-model
provider/model-id` makes the same change, bare `/kb-model` opens the saved-choice
picker for that slot, `/kb-model all [search]` browses OpenRouter, and
`/kb-model clear` returns to configured fallback behavior. For one standalone
sync, use `topchester kb sync --model provider/model-id`.

The root `-m, --model`, root/run `--kb-model`, and `topchester run -m, --model`
options use the same reference rules. Session chat, KB model, and effort
selections survive `--resume`, `/restore`, and `/fork`; an explicit CLI choice
wins over the restored choice for that slot. `/new` starts from the loaded JSONC
defaults. For durable defaults, edit `models.default`, `models["kb.summarize"]`,
or the provider's `reasoningEffort` in the intended JSONC file.

For a local OpenAI-compatible proxy, including VibeProxy, a selected profile can contain:

```jsonc
{
  "models": {
    "default": { "name": "gpt-5.5(low)", "provider": "openai" },
    "choices": ["openai/gpt-5.5(low)", "openai/gpt-5.5(high)"],
  },
  "providers": {
    "default": "openai",
    "openai": {
      "type": "openai-compatible",
      "baseURL": "http://127.0.0.1:8317/v1",
      "apiKey": "dummy-not-used",
    },
  },
}
```

Start it with `topchester --config ./vibeproxy.jsonc`. A model-id effort suffix remains part of the model name; a Topchester `/effort` override is also shown separately in the status line, and proxy-specific precedence remains the proxy's responsibility.

## Context capacity and compaction

Context capacity belongs to the exact provider route, not just the model name. Configure limits under the provider that owns the route:

```jsonc
{
  "providers": {
    "vibeproxy": {
      "type": "openai-compatible",
      "baseURL": "http://127.0.0.1:8317/v1",
      "discoverModelLimits": false,
      "modelLimits": {
        "gpt-5.4": {
          "contextWindow": 272000,
          "maxInputTokens": 240000,
          "maxOutputTokens": 32000,
        },
      },
    },
  },
  "compaction": {
    "enabled": true,
    "thresholdPercent": 85,
    "targetPercent": 40,
    "reserveTokens": 16384,
    "keepRecentTokens": 16000,
    "maxCompactionsPerTurn": 2,
    "learnProviderLimits": true,
  },
}
```

`modelLimits` keys are exact provider model IDs. A direct Codex route and a VibeProxy route using `gpt-5.4` are separate capacities because their provider IDs and base URLs differ. `contextWindow` is a shared input/output window; `maxInputTokens` is a separate prompt ceiling and does not have the output reserve subtracted again. Set `assumed: true` only for an explicit policy assumption; Topchester labels it as assumed and uses a larger uncertainty margin.

Generic OpenAI-compatible discovery is off by default. Set `discoverModelLimits: true` only when the endpoint's `/models` response is trusted. Topchester accepts a small allowlist of context/input/output fields, caches reported or overflow-learned limits under `.agents/topchester/context-routes.json`, and never writes them into JSONC. If a proxy reports no limit, `/context` shows `?` instead of inventing a denominator or percentage.

Automatic compaction is enabled by default. Set `compaction.enabled: false` to opt out of proactive threshold compaction; manual `/compact` and one bounded overflow-recovery attempt remain available. Cumulative usage/cost metadata stays separate from the active prompt estimate.
