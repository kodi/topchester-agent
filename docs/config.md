# Configuration

Topchester config is JSONC. Most users only need provider setup in their user config and project policy in `topchester.jsonc`.

## File Locations

Topchester loads config in this order. Later files override earlier files.

1. `topchester.jsonc`
2. `~/.config/topchester/config.jsonc`
3. One selected profile: `--config <path>` when supplied, otherwise `TOPCHESTER_CONFIG=/path/to/config.jsonc`

The CLI flag and environment variable select the same profile slot. If both are supplied, `--config` wins and Topchester does not parse or merge the environment-selected file. Relative `TOPCHESTER_CONFIG` paths are resolved from the workspace; relative CLI paths are resolved from the invocation directory.

Use `topchester.jsonc` for team-shared project policy. Use `~/.config/topchester/config.jsonc` for personal provider setup, model choices, and default model preferences. `.topchester/` is for state, sessions, and caches, not config.

On first startup, Topchester creates `~/.config/topchester/config.jsonc` with a commented minimal OpenRouter example. Uncomment it when you want to set a personal default model.

Loaded JSONC is immutable for the lifetime of an interactive session. `/model`, `/models`, `/effort`, and `/reasoning` change session runtime state and do not edit a config file. Runtime choices are saved in the project-local session log, restored by `--resume`, `/restore`, and `/fork`, and cleared by `/new`. To change a durable model or effort default, edit the intended JSONC file.

## Model Slots

Topchester has three user-facing model slots:

- `default` runs the main agent and fills in any unspecified model work.
- `fast` runs quick checks and lightweight agent calls.
- `kb.summarize` runs knowledge-base summarization.

If `fast` or `kb.summarize` is omitted, Topchester uses `default`.

## Example 1: Smallest OpenRouter Config

This uses one OpenRouter model for everything. Topchester automatically uses `OPENROUTER_API_KEY`.

```jsonc
{
  "models": {
    "default": "openrouter/google/gemini-3.1-flash-lite",
  },
}
```

Set the key before running Topchester:

```sh
export OPENROUTER_API_KEY=...
```

## Example 2: Separate KB Summarizer

Use one default model for the agent and a different model for knowledge-base summaries.

```jsonc
{
  "models": {
    "default": "openrouter/google/gemini-3.1-flash-lite",
    "kb.summarize": "openrouter/google/gemini-3.1-pro",
  },
}
```

## Example 3: Default, Fast, And KB Models

Use a stronger default model, a cheaper fast model, and a summarizer tuned for knowledge work.

```jsonc
{
  "models": {
    "default": "openrouter/anthropic/claude-sonnet-4.5",
    "fast": "openrouter/google/gemini-3.1-flash-lite",
    "kb.summarize": "openrouter/google/gemini-3.1-pro",
  },
}
```

## Example 4: Custom OpenRouter Settings

Use this when you want a custom environment variable name, extra headers, or tool behavior.

```jsonc
{
  "models": {
    "default": "openrouter/anthropic/claude-sonnet-4.5",
    "fast": "openrouter/openai/gpt-4.1-mini",
    "kb.summarize": "openrouter/google/gemini-3.1-pro",
  },
  "providers": {
    "default": "openrouter",
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "TOPCHESTER_OPENROUTER_API_KEY",
      "supportsStructuredOutputs": true,
      "headers": {
        "HTTP-Referer": "https://topchester.com",
        "X-Title": "Topchester",
      },
    },
  },
}
```

With `providers.default: openrouter`, model names can be written without repeating `openrouter/`:

```jsonc
{
  "models": {
    "default": "anthropic/claude-sonnet-4.5",
    "fast": "openai/gpt-4.1-mini",
  },
  "providers": {
    "default": "openrouter",
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
    },
  },
}
```

## Example 5: Local Ollama

Any OpenAI-compatible endpoint can be used as a provider. Ollama commonly runs at `http://localhost:11434/v1`.

```jsonc
{
  "models": {
    "default": "qwen2.5-coder:14b",
    "kb.summarize": "qwen2.5-coder:14b",
  },
  "providers": {
    "default": "ollama",
    "ollama": {
      "type": "openai-compatible",
      "baseURL": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "supportsStructuredOutputs": false,
    },
  },
}
```

## Example 6: Mixed OpenRouter And Local Summaries

Use OpenRouter for the interactive agent, but summarize the project knowledge base locally.

```jsonc
{
  "models": {
    "default": "anthropic/claude-sonnet-4.5",
    "fast": "openai/gpt-4.1-mini",
    "kb.summarize": {
      "name": "qwen2.5-coder:14b",
      "provider": "ollama",
      "toolProtocol": "text-json",
    },
  },
  "providers": {
    "default": "openrouter",
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "supportsStructuredOutputs": true,
    },
    "ollama": {
      "type": "openai-compatible",
      "baseURL": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "supportsStructuredOutputs": false,
    },
  },
}
```

## Example 7: LiteLLM, vLLM, Or LM Studio

For proxies and local servers, add another OpenAI-compatible provider and point `default` at it.

```jsonc
{
  "models": {
    "default": "claude-sonnet",
    "fast": "gpt-4.1-mini",
  },
  "providers": {
    "default": "litellm",
    "litellm": {
      "type": "openai-compatible",
      "baseURL": "http://localhost:4000/v1",
      "apiKeyEnv": "LITELLM_API_KEY",
    },
  },
}
```

## Example 8: Local GPT Or OpenAI Proxy

Providers named `openai` automatically use OpenAI-native tool calls and structured-output support. You only need to provide the model and endpoint.

```jsonc
{
  "models": {
    "default": {
      "name": "gpt-5.5(low)",
      "provider": "openai",
    },
  },
  "providers": {
    "default": "openai",
    "openai": {
      "type": "openai-compatible",
      "baseURL": "http://localhost:8317/v1",
      "apiKey": "dummy-not-used",
    },
  },
}
```

## Advanced Options

Each provider supports:

```jsonc
{
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
}
```

Prefer `apiKeyEnv` over `apiKey` so secrets stay out of config files.

Topchester adds default `HTTP-Referer` and `X-Title` headers for OpenRouter providers unless the config sets those header names explicitly.

`service_tier` is passed through to compatible OpenRouter requests. Use `flex` for lower cost with higher latency, or `priority` for faster service at higher cost.

`includeUsage` defaults to `true` for OpenAI-compatible providers. When enabled, Topchester asks streaming providers to return final usage data with `stream_options: { include_usage: true }`. Set `includeUsage: false` for proxies that reject `stream_options`.

`promptCaching` defaults to `true` for OpenAI-compatible providers. When enabled, Topchester sends the current session id as `prompt_cache_key` and adds conservative `cache_control: { type: "ephemeral" }` markers to the system and current user message. Set `promptCaching: false` for providers or proxies that reject those fields.

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

```jsonc
{
  "models": {
    "default": {
      "name": "anthropic/claude-sonnet-4.5",
      "provider": "openrouter",
      "toolProtocol": "native",
    },
  },
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
    },
  },
}
```

## Ignore Paths

Project config can exclude files from Knowledge Compiler inventory:

```jsonc
{
  "ignore": {
    "paths": ["generated/**", "snapshots/**/*.json", "*.lock.backup"],
  },
}
```

Ignore paths are workspace-relative glob patterns. Absolute paths and `..` traversal are rejected.

## Project Instructions

Topchester loads `AGENTS.md` and then `AGENTS.override.md` from the workspace as live project instructions by default. Nested files apply inside their folders, and later files at the same scope can override earlier guidance.

You can change the instruction filenames in project config:

```jsonc
{
  "instructions": {
    "enabled": true,
    "files": ["AGENTS.md", "AGENTS.override.md"],
    "fallbackFiles": ["CLAUDE.md"],
    "maxBytesPerFile": 32768,
    "maxTotalBytes": 98304,
  },
}
```

`files` are loaded first at each directory level, in order. `fallbackFiles` are opt-in compatibility names loaded after `files`. Set `enabled: false` to disable project instruction loading. Topchester does not load `CLAUDE.md`, `.clinerules`, `.cursor/rules`, remote URLs, or home-level instruction files by default.

## Bash Permissions

`bash` runs shell command strings inside the workspace. Unknown commands require interactive approval unless project or user config allows the exact command or a prefix under `tools.bash`:

```jsonc
{
  "tools": {
    "bash": {
      "allow": ["node scripts/check-fixtures.mjs"],
      "allowExact": ["printf hi | wc -c"],
      "deny": ["pnpm publish", "npm publish"],
    },
  },
}
```

Deny rules win over allow rules. `allowExact` matches a complete command string, while `allow` matches a command prefix plus a following space. `allowExact`, `allow`, and `deny` arrays concatenate across config layers. Tests, lint, typecheck, builds, checks, format checks, and smoke commands use the same `bash` approval rules as other shell work.

For benchmark or automation runs, `topchester run --dangerously-auto-approve` can auto-approve approval-required `bash` prompts without writing allow rules to `topchester.jsonc`. This is a runtime mode, not config. Deny rules, destructive command detection, workspace boundary checks, and hook blocks still win over auto-approval.

## MCP Stdio Servers

Topchester can expose tools from configured local stdio MCP servers to the primary agent runtime. V0 starts enabled stdio servers before the first model call in a turn, lists their tools, exposes them as model-facing Topchester tools, and calls the already-connected MCP server when the model selects one.

```jsonc
{
  "mcp": {
    "everything": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "env": {
        "EXAMPLE": "value",
      },
      "enabled": true,
      "timeoutMs": 30000,
      "enabledTools": ["echo"],
    },
  },
}
```

Only `type: "stdio"` is accepted. `command` is a single executable name or path, and `args` is the argv list passed without a shell. `env` adds string environment variables for the server process. `enabled` defaults to `true`; `args` and `env` default to empty values. `timeoutMs` applies to MCP connect, list, and call requests.

MCP tools are exposed with stable Topchester tool names in the form `mcp_<server>_<tool>`, after sanitizing punctuation and casing. For example, server `everything` tool `echo` becomes `mcp_everything_echo`. These names are visible in tool events, logs, text fallback parsing, and hook matchers.

MCP servers are external programs. They may read files, make network calls, mutate state, or perform other side effects according to the server implementation. Review server commands before adding them to shared config, and prefer `enabledTools` so broad servers do not expose every available tool to the model. If `enabledTools` is omitted, Topchester applies a V0 exposure cap and omits servers that exceed it.

MCP server entries merge by server name across config layers. Object fields merge recursively, but arrays such as `enabledTools` are replaced by later config instead of concatenated. This lets a user config tighten a project-level MCP allowlist instead of broadening it accidentally.

V0 intentionally does not support remote MCP transports, OAuth, MCP resources, resource templates, prompts, marketplace install, hot reload, reconnect loops, or rich rendering for binary/image/audio results. Text result parts are included in the normal tool result prompt. Unsupported result parts are summarized instead of rendered.

## Hooks

Hooks let project or user config run small programs at agent lifecycle points. Topchester starts the hook command as a child shell process, writes one JSON payload to stdin, waits for it to finish, and reads an optional JSON response from stdout. Write logs to stderr.

See [Hooks](./hooks.md) for the full event and payload reference.

Supported events:

- `SessionStart` / `TaskStart` — a Topchester session starts. `TaskStart` is an alias.
- `UserPromptSubmit` / `TaskAcknowledge` — the user prompt is accepted and the agent is about to work. `TaskAcknowledge` is an alias.
- `PreToolUse` — before a tool runs.
- `PostToolUse` — after a tool returns.
- `PermissionRequest` / `UserActionRequired` — the agent needs approval or another user action. `UserActionRequired` is an alias.
- `PreCompact` — before manual, threshold, overflow-recovery, or model-switch compaction mutates model context.
- `Stop` / `TaskComplete` — the turn finishes. `TaskComplete` is an alias.

Command hook example:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "command": ".topchester/hooks/check-command.sh",
        "timeoutMs": 5000,
        "statusMessage": "Checking command policy",
      },
    ],
  },
}
```

Hook payloads include `hook_event_name`, `event`, `cwd`, `workspaceRoot`, `source: "topchester"`, session ids when available, model metadata when the active model can be resolved, and event-specific fields. Model metadata is exposed as `model_purpose`, `model_provider`, `model_id`, `model_ref`, and a structured `model` object. Tool hooks include `tool.name`, `tool.input`, `tool.callId`, and `result` on `PostToolUse`.

Set `statusMessage` on a command hook to show a visible hook-start row such as `🪝 hook>pre-tool-use: Checking command policy` while the hook runs.

Command hooks may return:

```jsonc
{ "action": "continue", "context": "extra model context" }
{ "action": "block", "message": "Do not run deploy commands from this repo." }
{ "action": "stop", "message": "Stop after this hook." }
```

Empty stdout means continue. Invalid JSON, non-zero exit, timeout, or hook process failure is logged and does not stop the agent.

Hook arrays concatenate across config layers in the same load order as `ignore.paths`.

### peon-ping

Use normal command hooks to integrate [peon-ping](https://github.com/PeonPing/peon-ping). Topchester sends its hook payload as JSON on stdin to the configured command. Since peon-ping shell scripts usually print status lines instead of Topchester hook-response JSON, redirect stdout unless you wrap the command and intentionally return JSON to Topchester.

```jsonc
{
  "hooks": {
    "SessionStart": [{ "command": "peon >/dev/null" }],
    "TaskAcknowledge": [{ "command": "peon >/dev/null" }],
    "UserActionRequired": [{ "command": "peon >/dev/null" }],
    "Stop": [{ "command": "peon >/dev/null" }],
    "PostToolUse": [{ "matcher": "bash", "command": "peon >/dev/null" }],
  },
}
```

`TaskAcknowledge` normalizes to `UserPromptSubmit`, which peon-ping maps to its `task.acknowledge` category.
`UserActionRequired` normalizes to `PermissionRequest`, which peon-ping maps to its `input.required` category.

If your shell only has an interactive alias, set the explicit script command:

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "command": "bash ~/.claude/hooks/peon-ping/peon.sh >/dev/null",
      },
    ],
  },
}
```

For custom event mapping, put the mapping in a wrapper script and configure that script as the hook command:

```jsonc
{
  "hooks": {
    "PreCompact": [{ "command": ".topchester/hooks/peon-resource-limit.sh >/dev/null" }],
  },
}
```
