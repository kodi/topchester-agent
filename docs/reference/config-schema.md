---
title: Config schema
description: Reference for the public Topchester config shape.
section: Reference
order: 20
public: true
---

# Config schema

Topchester config is JSONC. This is the public shape most users need:

```ts
interface TopchesterConfig {
  models?: {
    "default"?: string | ModelSlotConfig;
    "fast"?: string | ModelSlotConfig;
    "kb.summarize"?: string | ModelSlotConfig;
    "choices"?: string[];
  };
  providers?: Record<string, ModelProviderConfig> & { default?: string };
  ignore?: {
    paths?: string[];
  };
  tools?: {
    bash?: {
      allow?: string[][];
      allowExact?: string[];
      deny?: string[][];
    };
  };
  instructions?: {
    enabled?: boolean;
    files?: string[];
    fallbackFiles?: string[];
  };
  mcp?: Record<string, McpStdioServerConfig>;
  hooks?: Record<string, HookHandlerConfig[]>;
  compaction?: {
    enabled?: boolean;
    thresholdPercent?: number;
    targetPercent?: number;
    reserveTokens?: number;
    keepRecentTokens?: number;
    maxCompactionsPerTurn?: number;
    learnProviderLimits?: boolean;
    assumedContextWindow?: number;
  };
}
```

Arrays such as `ignore.paths`, `tools.bash.allow`, `tools.bash.allowExact`, `tools.bash.deny`, and hook handler arrays concatenate across config layers. Later scalar and object fields override or merge according to the config loader.

Model providers use OpenAI-compatible provider config:

```ts
interface ModelProviderConfig {
  type: "openai-compatible";
  baseURL: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  supportsStructuredOutputs?: boolean;
  service_tier?: "flex" | "priority";
  includeUsage?: boolean;
  promptCaching?: boolean;
  toolProtocol?: "auto" | "native" | "text-json" | "text-xml";
  openRouterToolRouting?: "auto" | "force" | "off";
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  discoverModelLimits?: boolean;
  modelLimits?: Record<
    string,
    {
      contextWindow?: number;
      maxInputTokens?: number;
      maxOutputTokens?: number;
      assumed?: boolean;
    }
  >;
}
```

Context limits are scoped by provider ID, normalized `baseURL`, and exact model ID. Unknown routes remain unknown. Automatic compaction defaults on with an 85% trigger and 40% target; set `compaction.enabled` to `false` for a durable opt-out.

Workspace config and user config are followed by at most one selected profile. CLI `--config` takes precedence over `TOPCHESTER_CONFIG`; the two selectors do not create separate merge layers. Arrays concatenate only across the active layers.

This schema describes immutable JSONC input. Session runtime model and reasoning overrides are stored in project-local session events and are not additional config fields.

The known `codex` provider is OAuth-backed. Its config stays non-secret:

```jsonc
{
  "providers": {
    "codex": {
      "type": "openai-compatible",
      "baseURL": "https://chatgpt.com/backend-api",
    },
  },
}
```

Codex OAuth tokens live in `~/.config/topchester/auth.json`, not in project config.
