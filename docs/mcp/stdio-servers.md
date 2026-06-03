---
title: Stdio servers
description: Configure Topchester MCP stdio servers and enabled tools.
section: MCP
order: 20
public: true
---

# Stdio servers

Configure MCP servers under `mcp` in normal Topchester config:

```jsonc
{
  "mcp": {
    "everything": {
      "type": "stdio",
      "command": "node",
      "args": ["./test/fixtures/mcp/stdio-server.js"],
      "env": {
        "EXAMPLE": "1",
      },
      "enabledTools": ["echo"],
      "timeoutMs": 5000,
    },
  },
}
```

Only `type: "stdio"` is accepted.

- `command` is a single executable name or path.
- `args` is the argv list passed without a shell.
- `env` adds string environment variables for the server process.
- `enabled` defaults to `true`.
- `args` and `env` default to empty values.
- `timeoutMs` applies to connect, list, and call requests.

MCP tools are exposed with stable Topchester tool names in the form `mcp_<server>_<tool>`, after sanitizing punctuation and casing. For example, server `everything` tool `echo` becomes `mcp_everything_echo`.

Prefer `enabledTools` so broad servers do not expose every available tool to the model.
