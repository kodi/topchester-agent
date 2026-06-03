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
    "providers"?: Record<string, ModelProviderConfig> & { default?: string };
  };
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
  projectInstructions?: {
    enabled?: boolean;
    files?: string[];
    fallbackFiles?: string[];
  };
  mcp?: Record<string, McpStdioServerConfig>;
  hooks?: Record<string, HookHandlerConfig[]>;
}
```

Arrays such as `ignore.paths`, `tools.bash.allow`, `tools.bash.allowExact`, `tools.bash.deny`, and hook handler arrays concatenate across config layers. Later scalar and object fields override or merge according to the config loader.
