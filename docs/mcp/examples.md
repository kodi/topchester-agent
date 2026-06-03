---
title: MCP examples
description: Practical MCP stdio server examples for Topchester.
section: MCP
order: 30
public: true
---

# MCP examples

## Local Node server

```jsonc
{
  "mcp": {
    "docs": {
      "type": "stdio",
      "command": "node",
      "args": ["./tools/docs-mcp-server.js"],
      "enabledTools": ["search_docs"],
      "timeoutMs": 5000,
    },
  },
}
```

The model-facing tool name is `mcp_docs_search_docs`.

## Match an MCP tool in a hook

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp_docs_search_docs",
        "command": ".topchester/hooks/check-mcp-tool.sh",
      },
    ],
  },
}
```

Use hook matchers when MCP tools need extra project policy.
