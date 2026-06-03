---
title: Models and providers
description: Configure model slots and OpenAI-compatible providers.
section: Configuration
order: 20
public: true
---

# Models and providers

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
    "providers": {
      "default": "openrouter",
      "openrouter": {
        "type": "openai-compatible",
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "supportsStructuredOutputs": true,
      },
    },
  },
}
```

Prefer `apiKeyEnv` over `apiKey` so secrets stay out of config files.
