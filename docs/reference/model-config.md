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
