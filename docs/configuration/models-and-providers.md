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

The root `-m, --model` option and `topchester run -m, --model` use the same
reference rules. Session model and effort selections survive `--resume`,
`/restore`, and `/fork`; an explicit CLI model wins over the restored model.
`/new` starts from the loaded JSONC defaults. For durable defaults, edit
`models.default` or the provider's `reasoningEffort` in the intended JSONC file.

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
