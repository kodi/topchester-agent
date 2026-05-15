# Model Configuration

Status: Draft
Date: 2026-05-11

Topchester needs model access in both the agent runtime and the Knowledge Compiler. Both must use the same model configuration and runtime gateway.

The important boundary is:

```text
agent runtime / Knowledge Compiler
  -> Topchester ModelGateway
    -> Vercel AI SDK
      -> native providers later
      -> OpenAI-compatible providers now
```

Do not let `src/agent/` and `src/knowledge/` grow separate provider implementations.

## Competitor Pattern

The common pattern is layered configuration:

- Global user config for personal defaults and provider preferences.
- Project config for team-shared settings.
- Local project config for machine-specific or experimental settings that should not be committed.
- Environment variables or secret storage for API keys.
- CLI flags or inline environment config for one-off overrides.
- Enterprise or managed settings later, if needed.

Observed examples:

- OpenCode uses JSON/JSONC config, merges multiple sources, and supports global config at `~/.config/opencode/opencode.json`, project config at `opencode.json`, custom config via environment variables, and managed settings. It keeps provider/model settings in the normal runtime config.
- Claude Code uses hierarchical `settings.json` files: user config in `~/.claude/settings.json`, shared project config in `.claude/settings.json`, local uncommitted project config in `.claude/settings.local.json`, plus managed enterprise settings.
- aider uses `.aider.conf.yml` and loads it from home, git root, and current directory in order, with later files taking priority.

Implication for Topchester: use a small, explicit hierarchy and make project-shared model routing reviewable, while keeping credentials outside committed files.

Sources:

- OpenCode config: https://opencode.ai/docs/config/
- Claude Code settings: https://code.claude.com/docs/en/settings
- aider config: https://aider.chat/docs/config/aider_conf.html

## Recommended Locations

V0 should load config in this order. Later entries override earlier entries.

1. Built-in defaults.
2. User config: `~/.config/topchester/config.yaml`.
3. Project config: `topchester.yaml` at the workspace root.
4. Local project config: `.topchester/config.local.yaml`.
5. Explicit config path: `TOPCHESTER_CONFIG=/path/to/config.yaml`.
6. CLI flags.

Rationale:

- `~/.config/topchester/config.yaml` follows the XDG-style pattern used by OpenCode and other terminal tools.
- `topchester.yaml` is visible at the repo root, easy to review, and appropriate for team-shared routing such as "use this model for KB scan".
- `.topchester/config.local.yaml` is for personal per-repo overrides and should be gitignored by Topchester when created.
- API keys should not be committed. Config should reference environment variables or future secret-store entries.

Topchester should not store model config inside `topchester-kb/`. The KB is compiled project knowledge; model configuration is runtime policy. KB entries may record which model generated an entry, but they should not define provider credentials or routing.

## Config Shape

The model section has three public slots:

- `default` covers normal agent work and every internal purpose that is not configured more specifically.
- `fast` covers quick health checks and lightweight agent calls.
- `kb.summarize` covers knowledge-base summarization.

For OpenRouter, Topchester expands the `openrouter/...` shorthand into the OpenRouter-compatible provider
defaults and reads the token from `OPENROUTER_API_KEY`.

```yaml
models:
  default: openrouter/google/gemini-3.1-flash-lite
```

Projects that want a dedicated summarizer can set only that slot:

```yaml
models:
  default: openrouter/google/gemini-3.1-flash-lite
  kb.summarize: openrouter/google/gemini-3.1-pro
```

Internally this normalizes to explicit task-purpose assignments and provider connection details.

```ts
type ModelPurpose = "agent.primary" | "agent.fast" | "kb.scan" | "kb.summarize" | "fallback";

type ModelRef = `${providerId}/${modelId}`;

interface TopchesterConfig {
  models?: {
    "default"?: ModelRef;
    "fast"?: ModelRef;
    "kb.summarize"?: ModelRef;
    "providers"?: Record<string, ModelProviderConfig>;
  };
}

interface ModelProviderConfig {
  type: "openai-compatible";
  baseURL: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  supportsStructuredOutputs?: boolean;
  toolProtocol?: "auto" | "native" | "text-json" | "text-xml";
  openRouterToolRouting?: "auto" | "force" | "off";
}
```

V0 only needs `type: "openai-compatible"` because Vercel AI SDK already covers OpenAI-compatible endpoints through `@ai-sdk/openai-compatible`.

Later versions can add native provider types when they are worth it:

```ts
type ModelProviderConfig =
  | OpenAICompatibleProviderConfig
  | { type: "openai"; apiKeyEnv?: string }
  | { type: "anthropic"; apiKeyEnv?: string };
```

## Tool Calling

Users do not configure tool schemas. Topchester owns the tool registry and builds model-facing schemas from the same tool definitions used by the runtime. Normal config stays focused on providers, API keys, and the three model slots.

For agent turns, Topchester tries native OpenAI-compatible tool calls first. If a provider or model rejects native tools, Topchester falls back to text JSON tool calls. If a model emits a simple XML-style tool call, Topchester can parse that as a compatibility fallback. All paths validate tool args against the registered Zod schemas before any tool runs.

OpenRouter requests that try native tools include internal routing hints so OpenRouter should pick an upstream that can accept tool parameters. This is automatic for providers named like `openrouter` or using an OpenRouter base URL.

Topchester also adds default `HTTP-Referer` and `X-Title` attribution headers for OpenRouter providers unless the config sets those header names explicitly.

Advanced debugging overrides are available but should stay out of normal examples:

```jsonc
{
  "models": {
    "providers": {
      "openrouter": {
        "type": "openai-compatible",
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "service_tier": "flex",
        "toolProtocol": "text-json",
        "openRouterToolRouting": "off",
      },
    },
  },
}
```

`service_tier` is passed through to compatible OpenRouter requests. Supported request values are `flex` and `priority`.

`toolProtocol` values:

- `auto` — default; try native tools, then text fallbacks.
- `native` — native OpenAI-compatible tools only.
- `text-json` — text JSON tool calls only.
- `text-xml` — XML-style text tool calls only.

Override precedence is: smoke or runtime override, model slot override, provider override, then Topchester's `auto` default.

## Example Config

`topchester.yaml`:

```yaml
models:
  default: openrouter/google/gemini-3.1-flash-lite
  fast: openrouter/google/gemini-3.1-flash-lite
  kb.summarize: openrouter/google/gemini-3.1-pro
```

User config can define personal defaults:

`~/.config/topchester/config.yaml`:

```yaml
models:
  default: openrouter/anthropic/claude-sonnet-4.5
```

Local project config can override one of the public slots without touching committed files:

`.topchester/config.local.jsonc`:

```jsonc
{
  "models": {
    "kb.summarize": "ollama/qwen2.5-coder:14b",
    "providers": {
      "ollama": {
        "type": "openai-compatible",
        "baseURL": "http://localhost:11434/v1",
        "apiKey": "ollama",
      },
    },
  },
}
```

## Merge Rules

Config files should be deep-merged.

- Objects merge recursively.
- Scalars replace earlier values.
- Arrays replace earlier values unless a field explicitly defines append semantics.
- `models.default`, `models.fast`, and `models.kb.summarize` replace earlier values independently.
- `models.providers` merges by provider id.
- Later files may override only one model slot without copying the full model config.

Example:

```jsonc
// user config
{
  "models": {
    "default": "openrouter/anthropic/claude-sonnet-4.5",
  },
}
```

```jsonc
// project config
{
  "models": {
    "kb.summarize": "ollama/qwen2.5-coder:14b",
  },
}
```

Resolved config keeps the user default and uses the project summarizer for knowledge-base summaries.

## Project Ignore Paths

Project config can exclude files from Knowledge Compiler inventory before they are queued for L1 processing:

```jsonc
{
  "$schema": "https://topchester.com/schemas/config.v1.json",
  "ignore": {
    "paths": ["generated/**", "snapshots/**/*.json", "*.lock.backup"],
  },
}
```

Local uncommitted ignores belong in `.topchester/config.local.jsonc`:

```jsonc
{
  "ignore": {
    "paths": [".scratch/**", "local-dumps/**"],
  },
}
```

Rules are workspace-relative POSIX glob patterns. Absolute paths and `..` traversal are rejected. Matching supports standard glob tokens such as `*`, `**`, `?`, character classes, braces, and dotfiles. Negated rules can re-include files that earlier config ignore rules excluded:

```jsonc
{
  "ignore": {
    "paths": ["fixtures/**", "!fixtures/important/**"],
  },
}
```

Config ignores are applied after built-in safety exclusions and `.gitignore`. Negation cannot re-include default excluded folders such as `.git/`, `node_modules/`, `.agents/topchester/`, `.agents/topchester-kb-cache/`, or `topchester-kb/`.

`ignore.paths` arrays concatenate across config layers in load order: user config, project config, local project config, `TOPCHESTER_CONFIG`, then CLI `--config`. Later entries win inside the effective ignore rule list.

## Security Rules

- Prefer `apiKeyEnv` over `apiKey`.
- Warn when a project-shared config contains `apiKey`.
- Automatically add `.topchester/config.local.jsonc` to `.gitignore` when Topchester creates it.
- Never write discovered API keys into `topchester-kb/`, logs, transcripts, or generated docs.
- KB provenance may record provider id, model id, and model settings, but never credentials.

## V0 Implementation Notes

The current wrapper in `src/model/index.ts` already expects this normalized shape:

```ts
interface ModelGatewayConfig {
  defaultPurpose: ModelPurpose;
  models: Partial<Record<ModelPurpose, string>>;
  providers: Record<string, OpenAICompatibleProviderConfig>;
}
```

The config loader translates the persisted config:

```text
models.default      -> ModelGatewayConfig.models["agent.primary"] and unspecified internal purposes
models.fast         -> ModelGatewayConfig.models["agent.fast"]
models.kb.summarize -> ModelGatewayConfig.models["kb.summarize"]
models.providers    -> ModelGatewayConfig.providers

Supported internal purposes are `agent.primary`, `agent.fast`, `kb.scan`, `kb.summarize`, and `fallback`.
```

The first implementation can skip native provider support and only instantiate OpenAI-compatible providers. That is enough for OpenRouter, Ollama, LiteLLM, vLLM, LM Studio, and most proxy services.
