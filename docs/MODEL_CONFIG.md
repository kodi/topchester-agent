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

V0 loads config in this order. Later entries override earlier entries.

1. Built-in defaults.
2. Project config: `topchester.jsonc` at the workspace root.
3. User config: `~/.config/topchester/config.jsonc`.
4. Explicit config path: `TOPCHESTER_CONFIG=/path/to/config.jsonc`.
5. CLI flags.

Rationale:

- `topchester.jsonc` is visible at the repo root, easy to review, and appropriate for team-shared policy such as ignore rules, command approvals, and optional project model recommendations.
- `~/.config/topchester/config.jsonc` follows the XDG-style pattern used by OpenCode and other terminal tools. It is the default write target for `/connect` and `/model` because those commands change personal provider and model preferences.
- `.topchester/` is for state, sessions, and caches. It is not a config layer.
- API keys should not be committed. Config should reference environment variables or future secret-store entries.

Topchester should not store model config inside `topchester-kb/`. The KB is compiled project knowledge; model configuration is runtime policy. KB entries may record which model generated an entry, but they should not define provider credentials or routing.

## Config Shape

The model section has three public slots:

- `default` covers normal agent work and every internal purpose that is not configured more specifically.
- `fast` covers quick health checks and lightweight agent calls.
- `kb.summarize` covers knowledge-base summarization.

The interactive `/model` command uses a separate shortlist:

- `choices` is the small list shown by `/model`.
- Each choice should be provider-qualified as `<provider>/<provider-native-model-id>`.
- For OpenRouter, the native model id already includes the upstream company, so a normal choice looks like `openrouter/anthropic/claude-sonnet-4.5`.
- `/model all` can browse OpenRouter's catalog and add one of those models to the user shortlist.

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
type ModelPurpose = "agent.primary" | "agent.fast" | "kb.summarize" | "fallback";

type ModelRef = `${providerId}/${modelId}`;

interface TopchesterConfig {
  models?: {
    "default"?: ModelRef;
    "fast"?: ModelRef;
    "kb.summarize"?: ModelRef;
    "choices"?: ModelRef[];
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

`topchester.jsonc`:

```jsonc
{
  "ignore": {
    "paths": ["docs/**/*.md", "pnpm-lock.yaml"],
  },
  "tools": {
    "commands": {
      "allowExact": ["pnpm test", "pnpm format"],
    },
  },
  "models": {
    "choices": ["openrouter/qwen/qwen3-coder", "openrouter/anthropic/claude-sonnet-4.5"],
    "kb.summarize": "openrouter/google/gemini-3.1-pro",
  },
}
```

User config defines personal provider setup and defaults:

`~/.config/topchester/config.jsonc`:

```jsonc
{
  "models": {
    "default": "openrouter/anthropic/claude-sonnet-4.5",
    "choices": ["openrouter/qwen/qwen3-coder", "openrouter/anthropic/claude-sonnet-4.5"],
    "providers": {
      "openrouter": {
        "type": "openai-compatible",
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
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
- `models.default` fills `agent.primary` and `fallback`; more specific slots such as `models.fast` and `models.kb.summarize` are preserved when another layer only changes the default.
- `models.choices` replaces earlier choice lists in normal config merging. The TUI appends to the user list when a user picks a model from `/model all`.
- `models.providers` merges by provider id.
- Later files may override only one model slot without copying the full model config.

Example:

```jsonc
// project config
{
  "models": {
    "kb.summarize": "ollama/qwen2.5-coder:14b",
  },
}
```

```jsonc
// user config
{
  "models": {
    "default": "openrouter/anthropic/claude-sonnet-4.5",
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

Personal ignore rules can live in `~/.config/topchester/config.jsonc` when they should apply on this machine:

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

`ignore.paths` arrays concatenate across config layers in load order: project config, user config, `TOPCHESTER_CONFIG`, then CLI `--config`. Later entries win inside the effective ignore rule list.

## Command Policy

`run_command` is limited to validators and configured command prefixes. Add project-specific allow and deny rules under `tools.commands`:

```jsonc
{
  "tools": {
    "commands": {
      "allow": ["node scripts/check-fixtures.mjs", "pnpm exec tsx scripts/dev/inspect-config.ts"],
      "allowExact": ["node --version"],
      "deny": ["pnpm publish", "npm publish"],
    },
  },
}
```

Rules match normalized command display strings by exact command or prefix plus a following space. Deny rules win over allow rules. Command rules must be simple command prefixes, not shell syntax, paths, or glob patterns.

`tools.commands.allowExact` matches only the complete normalized command. `tools.commands.allow`, `tools.commands.allowExact`, and `tools.commands.deny` arrays concatenate across config layers in the same load order as `ignore.paths`.

When an interactive `run_command` request is rejected only because it is not configured, the TUI can approve the exact command once, allow it for the current session, or permanently add it to this repo's `topchester.jsonc` under `tools.commands.allowExact`.

## Hooks

Lifecycle hooks live under `hooks` in the same layered config. Events are `SessionStart`/`TaskStart`, `UserPromptSubmit`/`TaskAcknowledge`, `PreToolUse`, `PostToolUse`, `PermissionRequest`/`UserActionRequired`, `PreCompact`, and `Stop`/`TaskComplete`.

```jsonc
{
  "hooks": {
    "PreToolUse": [{ "matcher": "run_command", "command": ".topchester/hooks/check-command.sh" }],
    "TaskAcknowledge": [{ "command": "peon >/dev/null" }],
    "UserActionRequired": [{ "command": "peon >/dev/null" }],
    "Stop": [{ "command": "peon >/dev/null" }],
  },
}
```

Command hooks receive JSON on stdin and may return JSON on stdout with `action: "continue" | "block" | "stop"`, optional `message`, and optional `context`. Payloads include active model metadata when Topchester can resolve it: `model_purpose`, `model_provider`, `model_id`, `model_ref`, and `model`. Integrations such as peon-ping are plain command hooks; redirect stdout for tools that print non-JSON status output. Hook arrays concatenate across config layers.

## Security Rules

- Prefer `apiKeyEnv` over `apiKey`.
- Warn when a project-shared config contains `apiKey`.
- Do not create repo-local config files from interactive commands.
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
models.default      -> ModelGatewayConfig.models["agent.primary"] and ModelGatewayConfig.models["fallback"]
models.fast         -> ModelGatewayConfig.models["agent.fast"]
models.kb.summarize -> ModelGatewayConfig.models["kb.summarize"]
models.providers    -> ModelGatewayConfig.providers

Supported internal purposes are `agent.primary`, `agent.fast`, `kb.summarize`, and `fallback`.
```

The first implementation can skip native provider support and only instantiate OpenAI-compatible providers. That is enough for OpenRouter, Ollama, LiteLLM, vLLM, LM Studio, and most proxy services.
