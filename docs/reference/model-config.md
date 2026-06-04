---
title: Model config
description: Detailed model provider and tool protocol options.
section: Reference
order: 30
public: true
---

# Model config

Each provider supports:

```jsonc
{
  "models": {
    "providers": {
      "my-provider": {
        "type": "openai-compatible",
        "baseURL": "https://example.com/v1",
        "apiKeyEnv": "MY_PROVIDER_API_KEY",
        "apiKey": "optional-inline-key",
        "supportsStructuredOutputs": true,
        "service_tier": "flex",
        "includeUsage": true,
        "promptCaching": true,
        "toolProtocol": "auto",
        "openRouterToolRouting": "auto",
        "headers": {
          "X-Custom-Header": "value",
        },
      },
    },
  },
}
```

`toolProtocol` values:

- `auto`: try native tools, then text fallbacks.
- `native`: use native OpenAI-compatible tool calls only.
- `text-json`: ask the model to emit JSON tool calls in text.
- `text-xml`: ask the model to emit XML-style tool calls in text.

`openRouterToolRouting` only matters for OpenRouter providers:

- `auto`: let Topchester add routing hints when native tools are used.
- `force`: always force tool-capable routing hints.
- `off`: do not add OpenRouter tool routing hints.

`includeUsage` defaults to `true` for OpenAI-compatible providers. Set it to `false` for proxies that reject `stream_options`.

`promptCaching` defaults to `true` for OpenAI-compatible providers. Set it to `false` for providers or proxies that reject prompt-cache fields.

## Codex ChatGPT OAuth

Run this from any terminal, including SSH sessions:

```sh
topchester auth login codex --device
```

The command stores OAuth credentials in `~/.config/topchester/auth.json` and writes a non-secret provider entry to `~/.config/topchester/config.jsonc`:

```jsonc
{
  "models": {
    "providers": {
      "default": "codex",
      "codex": {
        "type": "openai-compatible",
        "baseURL": "https://chatgpt.com/backend-api",
      },
    },
    "choices": ["codex/gpt-5.5", "codex/gpt-5.4", "codex/gpt-5.4-mini", "codex/gpt-5.3-codex-spark"],
  },
}
```

Codex auth is OAuth-backed, not API-key-backed. Do not put access tokens or refresh tokens in `topchester.jsonc`. At runtime Topchester loads the stored Codex OAuth record, refreshes expired access tokens with a safety window, injects `Authorization: Bearer <access token>`, adds `ChatGPT-Account-Id` when available, and routes OpenAI-compatible chat/responses requests to the Codex backend.

`toolProtocol` and `supportsStructuredOutputs` are not enabled by the Codex default until they are verified against the ChatGPT Codex backend.
