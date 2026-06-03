# MCP Stdio V0 Implementation Plan

## Summary

Add V0 Model Context Protocol support for local stdio MCP servers only. The target is a small runtime integration that lets a user opt into configured MCP servers, discovers their tools before the model request, exposes those tools through Topchester's normal tool loop, and calls the connected MCP server when the model selects one.

This plan exists because MCP crosses several Topchester boundaries at once: config, runtime startup, model-visible tools, text fallback parsing, tool execution, hooks, logging, and docs. The work should be done in ordered slices so the repo remains usable after each checkpoint.

## Protocol Clarification

MCP is not just a blind forwarding mechanism. The client needs to connect to each configured server and ask it for capabilities before the model can use those capabilities.

For tool use, the basic flow is:

```text
Topchester config
  -> start/connect stdio MCP server
  -> MCP initialize handshake
  -> tools/list
  -> convert discovered tools into model-visible Topchester tool definitions
  -> model chooses one discovered tool
  -> tools/call against the already-connected MCP client
  -> format MCP result into Topchester's normal tool result prompt
```

The important point: Topchester does need to spawn/connect enabled stdio MCP servers before the first model request that should see those tools. It does not need to respawn a server per tool call. V0 should keep connected clients for the active runtime/session and close them on shutdown.

Lazy connection is possible, but only if it still happens before tool schemas are sent to the model. If the model has not seen a tool's name, description, and input schema, it cannot reliably call it through native tool calls, and Topchester's text fallback parsers cannot validate it.

## Decisions

- V0 supports local stdio MCP servers only.
- V0 does not support remote HTTP, SSE, OAuth, MCP resources, MCP prompts, marketplace/catalog install, hot reload, or reconnect loops.
- MCP server startup happens when an agent runtime is preparing the model-visible tool list, not for non-agent CLI commands.
- Enabled MCP clients are reused for the active runtime/session and closed during runtime/session teardown.
- Topchester should not mutate the static `toolRegistry` globally for discovered MCP tools. V0 should introduce a per-runtime tool catalog that combines static tools with discovered MCP tools.
- MCP tools should use a stable model-facing name derived from server and tool name, such as `mcp_<server>_<tool>`.
- V0 should include an `enabledTools` allowlist or a hard exposure cap so a large MCP server cannot silently add hundreds of tool schemas to every prompt.
- MCP tool calls should flow through normal Topchester `PreToolUse` and `PostToolUse` hooks with the model-facing tool name.

## Scope

Included:

- Add `@modelcontextprotocol/sdk`.
- Add config schema for stdio MCP servers.
- Connect configured enabled stdio servers.
- List MCP tools and convert their input schemas into Topchester tool definitions.
- Execute discovered MCP tools via `tools/call`.
- Format text MCP results into normal Topchester tool result output.
- Preserve existing static tools and profile behavior.
- Add focused unit/integration tests with a local test MCP server fixture.
- Document V0 behavior and limitations.

Out of scope:

- Remote transports.
- OAuth.
- MCP resources, resource templates, or prompts.
- Dynamic CLI commands such as `topchester mcp add/list`.
- Marketplace or packaged server discovery.
- Live settings file watching.
- Reconnect after server crash beyond returning a clear error.
- Binary/image/audio rich rendering.
- A new dedicated MCP approval UI, unless implementation discovers that existing hooks/profile gates are insufficient for a safe V0.

## Current State

Topchester's tool registry is static and type-derived:

- `src/agent/tools/registry.ts` exports `toolRegistry`, `ToolName`, `ToolCall`, `ToolResult`, and lookup helpers.
- `src/agent/profiles.ts` uses static `ToolName` sets for profile allow/deny behavior.
- `src/agent/tools/parser.ts` and `src/agent/tools/xml-parser.ts` reject tool names not present in the static registry.
- `src/agent/tools/executor.ts` validates tool names through `isToolName()` and executes the static definition.
- `src/agent/runtime/index.ts` currently builds tools once per turn with `getProfileToolDefinitions(permissions)`.
- `src/agent/tools/ai-sdk-tools.ts` converts a list of Topchester `ToolDefinition`s into an AI SDK tool set.
- `src/config/index.ts` currently accepts `tools.bash` config but has no MCP config shape.

This means MCP cannot be implemented only by adding an executor. Discovered MCP tools must be visible to all code paths that validate model tool names: native tool calls, text JSON fallback, text XML fallback, permissions, hooks, runtime formatting, and execution.

## Recommended Approach

Introduce a runtime-scoped tool catalog:

```text
Static Topchester tools
  + discovered MCP tool definitions for this runtime/session
  -> active tool catalog
  -> model tool schemas
  -> parser validation
  -> executor lookup
  -> hooks and runtime formatting
```

The catalog should keep static tool names strongly typed where practical, but it must also support dynamic MCP tool names as strings. Avoid widening every internal type too early; add small adapter boundaries first.

MCP support should live behind a small manager layer:

```text
src/agent/mcp/config.ts       config-derived types/helpers if needed
src/agent/mcp/manager.ts      connect/list/close stdio clients
src/agent/mcp/tools.ts        convert MCP tool defs to Topchester ToolDefinition
```

Exact filenames can change during implementation, but keep MCP protocol handling separate from `runtime/index.ts`.

## Config Shape

Suggested V0 shape:

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
      "enabledTools": ["add", "echo"],
    },
  },
}
```

Fields:

- `type`: only `"stdio"` in V0.
- `command`: executable to spawn.
- `args`: optional argv list.
- `env`: optional extra environment variables.
- `cwd`: optional workspace-relative working directory, if needed; omit this in the first slice if it adds path risk.
- `enabled`: optional boolean, default true for explicitly configured entries.
- `timeoutMs`: optional positive integer for startup/list/call timeout.
- `enabledTools`: optional MCP server tool-name allowlist.

Do not support shell command strings in V0. Use `command` plus `args` so server startup is not a hidden shell execution path.

## Cross-Slice Rules

- Keep remote MCP out of V0.
- Do not start MCP servers for non-agent CLI commands.
- Do not respawn stdio MCP servers per tool call.
- Do not silently expose very large tool inventories.
- Do not bypass existing hook events.
- Do not log secret env values.
- Do not merge MCP tools into `toolRegistry` as global mutable state.
- Failed MCP startup should degrade clearly: the configured server should be reported as failed and its tools omitted.
- Non-zero or protocol-level MCP tool errors should become normal tool error results, not runtime crashes.
- Unsupported MCP result parts should be summarized clearly instead of discarded silently.

## Data Flow

1. Load Topchester config.
2. Build primary profile permission view.
3. Create an MCP manager for the active runtime/session.
4. Connect enabled stdio MCP servers.
5. Call `tools/list` for each connected server.
6. Convert discovered tools to dynamic `ToolDefinition<string, unknown>`.
7. Combine static tools and dynamic MCP tools into an active catalog.
8. Send active catalog definitions to the model.
9. Parse model tool calls against the same active catalog.
10. Run hooks for the selected tool name.
11. Execute static tools through existing definitions or MCP tools through `client.callTool`.
12. Format result into the next prompt.
13. Close MCP clients on runtime/session cleanup.

## Edge Cases

- Server command is missing or exits during initialize.
- Server connects but `tools/list` fails.
- Server exposes duplicate tool names after sanitization.
- Server exposes a tool with invalid or non-object `inputSchema`.
- Server exposes too many tools.
- Server tool name contains spaces, punctuation, slashes, or non-ASCII characters.
- `enabledTools` references a tool that is not listed.
- Tool call arrives for a disconnected MCP server.
- Tool call times out or aborts.
- Tool returns image/audio/resource content in V0.
- MCP server writes noisy stderr.
- Environment variables in config are sensitive and must not be included in debug summaries.

## Files To Add

Likely additions:

- `src/agent/mcp/manager.ts`
- `src/agent/mcp/tools.ts`
- `src/agent/mcp/types.ts`
- `test/mcp-stdio.test.ts`
- `test/fixtures/mcp/stdio-server.ts` or an inline test helper script

## Files To Change

Likely changes:

- `package.json`
- lockfile
- `src/config/index.ts`
- `src/agent/tools/types.ts`
- `src/agent/tools/registry.ts`
- `src/agent/tools/parser.ts`
- `src/agent/tools/xml-parser.ts`
- `src/agent/tools/executor.ts`
- `src/agent/tools/ai-sdk-tools.ts`
- `src/agent/profiles.ts`
- `src/agent/runtime/index.ts`
- `src/agent/runtime/model.ts`
- `src/agent/runtime/format.ts`
- `src/agent/tools.ts`
- `docs/MODEL_CONFIG.md`
- `docs/cli.md`
- `docs/hooks.md`
- focused tests under `test/`

## Slices

### Slice 1: Config Contract And Dependency

Status: `[x]` Completed on 2026-06-03

Goal: Add the V0 config shape and MCP SDK dependency without changing runtime behavior.

Why here: Config parsing and package availability are the lowest-risk foundation. Runtime work should not begin until invalid MCP config fails early and clearly.

This slice should implement:

- Add `@modelcontextprotocol/sdk`.
- Add `mcp` to `topchesterConfigSchema` and `rawTopchesterConfigSchema`.
- Validate stdio config with `command`, optional `args`, optional `env`, optional `enabled`, optional `timeoutMs`, optional `enabledTools`.
- Keep unknown MCP transport types invalid.
- Ensure config layering behavior is documented, especially object merge semantics for per-server config.
- Add config tests for valid stdio config, invalid transport, invalid command, invalid timeout, and enabledTools validation.

Expected output:

- Topchester accepts valid `mcp` config and rejects invalid MCP config.
- No MCP servers start yet.

Verification:

```bash
pnpm test test/config.test.ts
pnpm typecheck
mise run local-ci
```

Evidence on 2026-06-03:

- `pnpm test test/config.test.ts` passed: 35 tests.
- `pnpm typecheck` passed.
- `mise run local-ci` passed.

Dependencies: none.

### Slice 2: Stdio MCP Manager

Status: `[x]` Completed on 2026-06-03

Goal: Build a small manager that can connect configured stdio MCP servers, list tools, track status, and close clients.

Why here: The protocol boundary should be proven before touching Topchester's model-visible tool catalog.

This slice should implement:

- Add a manager that accepts workspace root, MCP config, logger, and abort signal.
- Start stdio servers with `StdioClientTransport` using argv, not shell strings.
- Use workspace root as default cwd.
- Merge `process.env` with configured `env`, but never log env values.
- Connect with timeout.
- Call `tools/list` with timeout.
- Store client, raw tool definitions, and status per server.
- Close clients on cleanup.
- Summarize server stderr safely in logs if needed.
- Add a focused fake stdio MCP server fixture for tests.

Expected output:

- Tests can connect to a fake MCP server and list a tool.
- Startup failures produce a failed status and no tools.
- Closing the manager terminates clients.

Verification:

```bash
pnpm test test/mcp-stdio.test.ts
pnpm typecheck
mise run local-ci
```

Evidence on 2026-06-03:

- `pnpm test test/mcp-stdio.test.ts` passed: 5 tests.
- `pnpm typecheck` passed.
- `mise run local-ci` passed.

Dependencies: Slice 1.

### Slice 3: Runtime Tool Catalog

Status: `[x]` Completed on 2026-06-03

Goal: Add an active per-runtime tool catalog that combines static Topchester tools with dynamic MCP tools.

Why here: Current static `toolRegistry` validation rejects unknown names. MCP tools need a shared catalog before execution can work across native and text fallback paths.

This slice should implement:

- Add a `ToolCatalog` or similar runtime object with:
  - `definitions()`
  - `has(name)`
  - `get(name)`
  - `isParallelSafe(name)`
  - optional metadata for MCP server/tool mapping.
- Keep static registry helpers for static tools.
- Update parser functions to accept an active catalog or tool-name predicate.
- Update XML parser similarly, or explicitly document MCP text-XML unsupported until a later slice if that is too invasive.
- Update `toAiSdkToolSet` to work with dynamic definitions.
- Update profile permission checks to allow dynamic names without widening all static types unsafely.
- Ensure subagent profiles do not automatically receive MCP tools unless deliberately allowed.

Expected output:

- Static tools behave unchanged.
- A synthetic dynamic tool can be passed to the model tool set, parsed, and looked up by executor tests.

Verification:

```bash
pnpm test test/tools.test.ts test/agent-runtime.test.ts
pnpm typecheck
mise run local-ci
```

Evidence on 2026-06-03:

- `pnpm test test/tools.test.ts test/agent-runtime.test.ts` passed: 107 tests.
- `pnpm typecheck` passed.
- `mise run local-ci` passed.

Dependencies: Slice 1. Slice 2 is useful but not strictly required if this slice uses synthetic dynamic tools.

### Slice 4: MCP Tool Conversion And Execution

Status: `[x]` Completed on 2026-06-03

Goal: Convert listed MCP tools into Topchester tool definitions and execute them through the active catalog.

Why here: Once catalog plumbing exists, MCP execution can be implemented as a dynamic tool definition rather than a special case throughout runtime.

This slice should implement:

- Sanitize server and tool names into stable Topchester names.
- Detect sanitized-name collisions and fail the conflicting server/tool clearly.
- Convert MCP `inputSchema` into a Zod-compatible or JSON-schema-backed tool args schema accepted by the AI SDK path.
- If Topchester's current `ToolDefinition.argsSchema` cannot represent JSON Schema directly, add the smallest adapter needed.
- Implement MCP dynamic tool `execute()` by calling `client.callTool({ name, arguments })`.
- Apply `enabledTools` filtering before exposure.
- Add a default maximum exposed tools cap for servers without allowlists.
- Format MCP result text parts into `ToolResult.content`.
- Summarize unsupported result parts.
- Add executor/runtime tests that call a fake MCP tool and feed the result back into the normal prompt loop.

Expected output:

- A configured fake stdio MCP server exposes a model-visible tool such as `mcp_fixture_echo`.
- A model/native or parser-produced call to that tool executes via MCP and returns text.

Verification:

```bash
pnpm test test/mcp-stdio.test.ts test/tools.test.ts test/agent-runtime.test.ts
pnpm typecheck
mise run local-ci
```

Evidence on 2026-06-03:

- Added MCP tool-name sanitization, enabledTools filtering, exposure cap checks, and conversion from listed MCP tools to dynamic Topchester tool definitions.
- Added MCP dynamic execution through `client.callTool`, text-result formatting, unsupported part summaries, and tool-error result handling.
- Added focused fake-stdio execution tests through `executeToolCall` and the active tool catalog.
- Added runtime-loop coverage proving a fake MCP stdio tool is model-visible, executes, and feeds its result back into the normal next prompt.
- `pnpm test test/mcp-stdio.test.ts test/tools.test.ts test/agent-runtime.test.ts` passed: 116 tests.
- `pnpm typecheck` passed.
- `mise run local-ci` passed.

Dependencies: Slices 2 and 3.

### Slice 5: Runtime Integration, Hooks, And Status

Status: `[x]` Completed on 2026-06-03

Goal: Wire MCP manager lifecycle into the real agent runtime and make MCP behavior visible enough for debugging.

Why here: The core protocol and dynamic tool execution should already be tested before runtime lifecycle and UX are changed.

This slice should implement:

- Initialize MCP manager when an agent turn/session needs tool definitions.
- Connect/list before the first model call that should see MCP tools.
- Reuse the manager across the active runtime/session where practical.
- Close the manager when the runtime/session ends or aborts.
- Include MCP tools in `PreToolUse` and `PostToolUse` hook payloads using their model-facing names.
- Add concise logs for server status and exposed tool count.
- Add a TUI/session-visible status only if existing runtime event paths make that cheap; otherwise leave status in logs/docs for V0.
- Ensure MCP startup failure does not prevent the turn unless a future `required` config field is added.

Expected output:

- Real agent runtime can expose and call fake MCP stdio tools.
- Hooks can match MCP tool names.
- Failed server startup is diagnosable without crashing the agent turn.

Verification:

```bash
pnpm test test/mcp-stdio.test.ts test/agent-runtime.test.ts test/hooks.test.ts
pnpm typecheck
mise run local-ci
```

Evidence on 2026-06-03:

- `pnpm test test/mcp-stdio.test.ts test/agent-runtime.test.ts test/hooks.test.ts` passed: 24 tests.
- `pnpm typecheck` passed.
- `mise run local-ci` passed.

Dependencies: Slices 2, 3, and 4.

### Slice 6: Docs And V0 Guardrails

Status: `[x]` Completed on 2026-06-03

Goal: Document the V0 contract, limitations, and safety expectations.

Why here: MCP config is user-facing and security-sensitive. The docs should ship with the implementation, not after it.

This slice should implement:

- Update `docs/MODEL_CONFIG.md` with config shape and load-order behavior.
- Update `docs/cli.md` with MCP V0 behavior and limitations.
- Update `docs/hooks.md` to mention MCP tool names in hook matchers.
- Document that V0 supports stdio tools only.
- Document that resources, prompts, remote transports, OAuth, hot reload, and rich result parts are out of scope.
- Warn that MCP servers are external programs and may have side effects.
- Recommend `enabledTools` for large or broad servers.

Expected output:

- A user can configure a local stdio MCP server from docs.
- A future agent can tell what is intentionally missing from V0.

Verification:

```bash
pnpm format-check
pnpm typecheck
mise run local-ci
```

Evidence on 2026-06-03:

- `pnpm format-check` passed.
- `pnpm typecheck` passed.
- `mise run local-ci` passed.

Dependencies: Slices 1 through 5.

### Slice 7: Final Verification And Cleanup

Status: `[x]` Completed on 2026-06-03

Goal: Run the broader repo checks and remove temporary test scaffolding or stale assumptions.

Why here: Dynamic tool plumbing can have wide effects on parsing, profiles, hooks, and runtime formatting.

This slice should implement:

- Run full check.
- Review logs/tests for accidental secret/env output.
- Confirm static tools still work.
- Confirm text JSON fallback can call dynamic MCP tools, or record unsupported fallback behavior explicitly.
- Confirm subagents do not get MCP tools unless intended.
- Update this plan with actual passed commands and any changed decisions.

Expected output:

- Green repo checks.
- The plan records final verification and remaining follow-up work.

Verification:

```bash
pnpm check
```

Evidence on 2026-06-03:

- `pnpm check` passed: typecheck, format-check, lint, and 560 tests.
- `mise run local-ci` passed.
- Follow-up audit added focused coverage for sanitized-name collisions, native dynamic parsing, and unsupported MCP result summaries.
- Static tools still pass the existing full test suite.
- Text JSON fallback can call dynamic MCP tools through the active catalog.
- Subagent profiles do not receive MCP tools by default; only the primary profile includes dynamic MCP definitions.
- MCP config env values are passed to server processes but not logged by the manager; tests assert a configured secret value is not included in failed-startup status.

Dependencies: Slices 1 through 6.

## Testing Plan

Minimum focused tests:

- Config schema accepts valid stdio config and rejects invalid MCP config.
- Fake stdio MCP server can connect and list tools.
- Failed stdio server records failure and exposes no tools.
- Tool-name sanitization is stable and collision-safe.
- `enabledTools` filters listed tools.
- Active catalog includes static plus MCP tools.
- Native tool conversion includes MCP tools.
- Text JSON parser accepts MCP tool names from the active catalog.
- Executor calls fake MCP tool and formats text result.
- Unsupported result parts are summarized.
- Hooks receive MCP tool calls.
- Subagent profile behavior is explicit.

Final verification:

```bash
pnpm check
```

## Resolved V0 Questions

- V0 does not add a dedicated MCP approval prompt. Explicit config plus normal `PreToolUse` and `PostToolUse` hooks are the V0 control points.
- `enabledTools` is optional until a server exceeds the exposure cap. Broad servers should still configure it.
- MCP tools are not available to subagents by default. The primary profile is the only profile that receives dynamic MCP definitions in V0.
- V0 defaults stdio MCP server cwd to the workspace root and does not add a separate `cwd` config field.
- V0 does not include `topchester mcp list`; status is log-only.
- MCP result `_meta` is omitted from prompt output. Text content is included, and unsupported result part types are summarized.
