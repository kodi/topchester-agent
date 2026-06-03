---
title: MCP overview
description: Use local stdio MCP servers as Topchester tools.
section: MCP
order: 10
public: true
---

# MCP overview

Topchester can expose tools from configured local stdio MCP servers to the primary agent runtime.

V0 starts enabled stdio servers before the first model call in a turn, lists their tools, exposes them as model-facing Topchester tools, and calls the already-connected MCP server when the model selects one.

MCP servers are external programs. They may read files, make network calls, mutate state, or perform other side effects according to the server implementation. Review server commands before adding them to shared config.

V0 intentionally does not support remote MCP transports, OAuth, MCP resources, resource templates, prompts, marketplace install, hot reload, reconnect loops, or rich rendering for binary/image/audio results.
