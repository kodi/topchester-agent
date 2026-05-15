# Configuration

Topchester config is JSONC, with YAML accepted as a compatibility alias. Most users only need provider setup in their user config and project policy in `topchester.jsonc`.

## File Locations

Topchester loads config in this order. Later files override earlier files.

1. `topchester.jsonc`
2. `~/.config/topchester/config.jsonc`
3. `TOPCHESTER_CONFIG=/path/to/config.jsonc`
4. `--config <path>`

Use `topchester.jsonc` for team-shared project policy. Use `~/.config/topchester/config.jsonc` for personal provider setup, model choices, and default model preferences. `.topchester/` is for state, sessions, and caches, not config.

## Model Slots

Topchester has three user-facing model slots:

- `default` runs the main agent and fills in any unspecified model work.
- `fast` runs quick checks and lightweight agent calls.
- `kb.summarize` runs knowledge-base summarization.

If `fast` or `kb.summarize` is omitted, Topchester uses `default`.

## Example 1: Smallest OpenRouter Config

This uses one OpenRouter model for everything. Topchester automatically uses `OPENROUTER_API_KEY`.

```yaml
models:
  default: openrouter/google/gemini-3.1-flash-lite
```

Set the key before running Topchester:

```sh
export OPENROUTER_API_KEY=...
```

## Example 2: Separate KB Summarizer

Use one default model for the agent and a different model for knowledge-base summaries.

```yaml
models:
  default: openrouter/google/gemini-3.1-flash-lite
  kb.summarize: openrouter/google/gemini-3.1-pro
```

## Example 3: Default, Fast, And KB Models

Use a stronger default model, a cheaper fast model, and a summarizer tuned for knowledge work.

```yaml
models:
  default: openrouter/anthropic/claude-sonnet-4.5
  fast: openrouter/google/gemini-3.1-flash-lite
  kb.summarize: openrouter/google/gemini-3.1-pro
```

## Example 4: Custom OpenRouter Settings

Use this when you want a custom environment variable name, extra headers, or tool behavior.

```yaml
models:
  default: openrouter/anthropic/claude-sonnet-4.5
  fast: openrouter/openai/gpt-4.1-mini
  kb.summarize: openrouter/google/gemini-3.1-pro
  providers:
    default: openrouter
    openrouter:
      type: openai-compatible
      baseURL: https://openrouter.ai/api/v1
      apiKeyEnv: TOPCHESTER_OPENROUTER_API_KEY
      supportsStructuredOutputs: true
      headers:
        HTTP-Referer: https://topchester.com
        X-Title: Topchester
```

With `providers.default: openrouter`, model names can be written without repeating `openrouter/`:

```yaml
models:
  default: anthropic/claude-sonnet-4.5
  fast: openai/gpt-4.1-mini
  providers:
    default: openrouter
    openrouter:
      type: openai-compatible
      baseURL: https://openrouter.ai/api/v1
      apiKeyEnv: OPENROUTER_API_KEY
```

## Example 5: Local Ollama

Any OpenAI-compatible endpoint can be used as a provider. Ollama commonly runs at `http://localhost:11434/v1`.

```yaml
models:
  default: qwen2.5-coder:14b
  kb.summarize: qwen2.5-coder:14b
  providers:
    default: ollama
    ollama:
      type: openai-compatible
      baseURL: http://localhost:11434/v1
      apiKey: ollama
      supportsStructuredOutputs: false
```

## Example 6: Mixed OpenRouter And Local Summaries

Use OpenRouter for the interactive agent, but summarize the project knowledge base locally.

```yaml
models:
  default: anthropic/claude-sonnet-4.5
  fast: openai/gpt-4.1-mini
  kb.summarize:
    name: qwen2.5-coder:14b
    provider: ollama
    toolProtocol: text-json
  providers:
    default: openrouter
    openrouter:
      type: openai-compatible
      baseURL: https://openrouter.ai/api/v1
      apiKeyEnv: OPENROUTER_API_KEY
      supportsStructuredOutputs: true
    ollama:
      type: openai-compatible
      baseURL: http://localhost:11434/v1
      apiKey: ollama
      supportsStructuredOutputs: false
```

## Example 7: LiteLLM, vLLM, Or LM Studio

For proxies and local servers, add another OpenAI-compatible provider and point `default` at it.

```yaml
models:
  default: claude-sonnet
  fast: gpt-4.1-mini
  providers:
    default: litellm
    litellm:
      type: openai-compatible
      baseURL: http://localhost:4000/v1
      apiKeyEnv: LITELLM_API_KEY
```

## Example 8: Local GPT Or OpenAI Proxy

Providers named `openai` automatically use OpenAI-native tool calls and structured-output support. You only need to provide the model and endpoint.

```yaml
models:
  default:
    name: "gpt-5.5(low)"
    provider: openai
  providers:
    default: openai
    openai:
      type: openai-compatible
      baseURL: http://localhost:8317/v1
      apiKey: dummy-not-used
```

## Advanced Options

Each provider supports:

```yaml
models:
  providers:
    my-provider:
      type: openai-compatible
      baseURL: https://example.com/v1
      apiKeyEnv: MY_PROVIDER_API_KEY
      apiKey: optional-inline-key
      supportsStructuredOutputs: true
      service_tier: flex
      toolProtocol: auto
      openRouterToolRouting: auto
      headers:
        X-Custom-Header: value
```

Prefer `apiKeyEnv` over `apiKey` so secrets stay out of config files.

Topchester adds default `HTTP-Referer` and `X-Title` headers for OpenRouter providers unless the config sets those header names explicitly.

`service_tier` is passed through to compatible OpenRouter requests. Use `flex` for lower cost with higher latency, or `priority` for faster service at higher cost.

`toolProtocol` can be:

- `auto`: try native tools, then text fallbacks.
- `native`: use native OpenAI-compatible tool calls only.
- `text-json`: ask the model to emit JSON tool calls in text.
- `text-xml`: ask the model to emit XML-style tool calls in text.

`openRouterToolRouting` only matters for OpenRouter providers:

- `auto`: let Topchester add routing hints when native tools are used.
- `force`: always force tool-capable routing hints.
- `off`: do not add OpenRouter tool routing hints.

You can also set `toolProtocol` per model slot:

```yaml
models:
  default:
    name: anthropic/claude-sonnet-4.5
    provider: openrouter
    toolProtocol: native
  providers:
    openrouter:
      type: openai-compatible
      baseURL: https://openrouter.ai/api/v1
      apiKeyEnv: OPENROUTER_API_KEY
```

## Ignore Paths

Project config can exclude files from Knowledge Compiler inventory:

```yaml
ignore:
  paths:
    - generated/**
    - snapshots/**/*.json
    - "*.lock.backup"
```

Ignore paths are workspace-relative glob patterns. Absolute paths and `..` traversal are rejected.
