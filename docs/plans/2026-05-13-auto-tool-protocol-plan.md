# Auto Tool Protocol Plan

## Summary

Implement Topchester tool calling so users only configure provider and model. Topchester should decide how to transport tool calls internally.

The target state:

- Build native tool schemas from existing `ToolDefinition.argsSchema`.
- Try native `tools` for OpenAI-compatible providers by default.
- For OpenRouter, send provider options internally where useful, such as `require_parameters: true`, so routing does not silently choose a non-tool-capable upstream.
- If native tools are rejected or do not produce structured calls, fall back automatically to text tool protocols.
- Record which path was used in logs and smoke reports.

The user should not need to write tool schemas, tool protocol sections, OpenRouter routing details, or model-specific parser choices in normal config.

## Decisions

- Keep the normal config UX model-only: users choose providers, API keys, and model assignments.
- Topchester owns the tool registry and should derive all model-facing tool schemas from that registry.
- Prefer native OpenAI-compatible `tools` when the configured provider can accept them.
- Keep text JSON tool parsing as a fallback because it is the current runtime contract and is useful for weaker or local models.
- Add XML-style text tool parsing as a compatibility fallback because some OpenRouter free models emitted XML-ish tool calls in smoke artifacts.
- Treat protocol selection as runtime behavior, not required user config.
- Add optional advanced overrides for debugging or provider quirks, not as a required path.
- Keep tool execution sequential in V0 even if the provider supports parallel tool calls.

## Scope

Included:

- Tool schema conversion from Topchester's existing tool definitions.
- Native tool-call support through the current AI SDK OpenAI-compatible model gateway.
- Internal OpenRouter provider options that improve tool-capable routing.
- Automatic fallback from native tools to text JSON and text XML.
- Runtime logs that record selected protocol, fallback reason, and tool-call source.
- Smoke report fields that show protocol behavior per trial.
- Tests for schema conversion, protocol fallback, parser compatibility, and smoke report metadata.
- Documentation updates that explain that users do not configure tools.

Not included:

- Requiring user-authored tool protocol config.
- Separate native OpenAI, Anthropic, or Gemini provider adapters in the first pass.
- Parallel tool execution.
- Human approval UX changes.
- Rewriting all conversation history storage into provider-native message objects in the first slice.
- Removing the existing text JSON prompt contract before native parity is proven.

## Current State

Topchester already has the main pieces, but they are connected through a prompt-only tool protocol.

Useful files:

- `src/model/index.ts` creates an OpenAI-compatible AI SDK provider and calls `generateText(...)`.
- `src/agent/tools/types.ts` defines `ToolDefinition` with `description`, `prompt`, `argsSchema`, and `execute(...)`.
- `src/agent/tools/registry.ts` owns the list of available tools.
- `src/agent/tools/parser.ts` parses a JSON object from model text.
- `src/agent/tools/executor.ts` executes parsed tool calls and logs metadata.
- `src/agent/runtime.ts` runs the bounded tool loop and appends text-formatted tool results into the next prompt.
- `scripts/smoke/run-smoke.ts` records trial reports and checks expected tool calls.

The current model request is effectively:

```text
system prompt + conversation prompt -> model text -> parseToolCall(text)
```

The desired V0 request path is:

```text
system prompt + model messages + native tool schemas -> model structured tool calls
```

with fallback:

```text
system prompt + text tool instructions -> text JSON or XML -> parser -> executeToolCall(...)
```

## Competitor Findings

Local competitor checkouts have the same broad pattern:

- Pi, OpenCode, and Codex treat tool calls as first-class structured message parts.
- Cline supports native OpenAI-compatible tool calls, but also keeps XML-style tool formatting for compatibility.
- Kilo filters OpenRouter catalog results to models that advertise `tools`, because coding-agent operation depends on tool calling.

The practical lesson for Topchester: native tools should be the normal path, but compatibility text protocols are still worth keeping. The user-facing model should stay simple; the agent owns protocol selection.

## Implementation Shape

Add a small internal protocol layer:

```ts
type ToolProtocol = "native-openai-compatible" | "text-json" | "text-xml";

interface ToolProtocolAttempt {
  protocol: ToolProtocol;
  status: "used" | "skipped" | "failed" | "fallback";
  reason?: string;
}
```

Expose it through logs, debug traces, and smoke reports. Config may support optional advanced overrides, but normal setup should not require or explain protocol selection.

The model gateway should support two agent-facing paths:

1. Native tool request:
   - accepts a set of Topchester tools,
   - passes AI SDK `tools`,
   - captures structured tool calls,
   - returns normalized `ModelToolCall[]`.

2. Text request:
   - current `generateText(...)` behavior,
   - current JSON parser plus new XML parser,
   - used when native tools are not usable or do not produce structured calls.

Suggested internal result shape:

```ts
interface ModelToolCall {
  id: string;
  tool: string;
  args: unknown;
  source: "native" | "text-json" | "text-xml";
}

interface ModelAgentResult extends ModelTextResult {
  toolCalls: ModelToolCall[];
  toolProtocol: ToolProtocol;
  protocolAttempts: ToolProtocolAttempt[];
}
```

## Cross-Slice Rules

- Users should not need to configure tool schemas or protocol choice.
- Existing JSON tool-call behavior must keep working until native parity is proven by tests and smoke runs.
- Logs should include protocol metadata but not full tool argument payloads when they may contain file contents.
- Runtime should validate all native tool args against the existing Zod schemas before executing.
- Native tool calls and text-parsed tool calls should feed the same `executeToolCall(...)` path.
- Keep sequential execution for file-edit safety in V0.

## Slice 1: Tool Schema Adapter

Status: `[x]` Implemented

Goal: Convert Topchester tool definitions into AI SDK tool schemas without changing runtime behavior.

Why here: Native tools need a single source of truth. The existing `ToolDefinition.argsSchema` should remain that source.

This slice should implement:

- Add a helper such as `src/agent/tools/ai-sdk-tools.ts`.
- Convert each registered `ToolDefinition` into an AI SDK tool definition.
- Use `description` as model-facing tool description.
- Use `argsSchema` as `inputSchema`.
- Keep execution optional at this layer if runtime still executes calls itself.
- Add tests that every registered tool can be converted.
- Add tests that invalid native args still fail through the existing Zod schema.

Expected output:

- A reusable adapter from `ToolDefinition[]` to AI SDK `ToolSet`.
- No user-visible behavior change.

Verification:

```sh
pnpm run typecheck
pnpm test -- test/tools.test.ts
```

Dependencies: None.

## Slice 2: Native Tool Gateway Result

Status: `[x]` Implemented

Goal: Let `ModelGateway` make an OpenAI-compatible native tool request and return normalized tool calls.

Why here: The runtime cannot switch protocols until the gateway can expose structured calls instead of only text.

This slice should implement:

- Add an agent-specific gateway method, such as `generateAgentStep(...)`, instead of overloading KB summarization calls.
- Pass `tools` and `toolChoice: "auto"` to AI SDK for OpenAI-compatible providers.
- Force sequential behavior for V0 by passing provider options equivalent to `parallel_tool_calls: false` where supported.
- Normalize AI SDK tool calls into `ModelToolCall[]`.
- Preserve `text`, `providerId`, `modelId`, and `purpose`.
- Record warnings or provider errors in `protocolAttempts`.
- Keep `generateText(...)` unchanged for KB and health paths.

Expected output:

- `ModelGateway` can return native tool calls for agent turns.
- Existing non-agent model calls stay unchanged.

Verification:

```sh
pnpm run typecheck
pnpm test -- test/model*.test.ts test/tools.test.ts
```

Dependencies: Slice 1.

## Slice 3: OpenRouter Internal Routing Options

Status: `[x]` Implemented

Goal: Improve OpenRouter native-tool reliability without asking users to configure routing details.

Why here: OpenRouter may route a model request to upstream providers with different capabilities. Tool-capable requests should make that requirement explicit.

This slice should implement:

- Detect OpenRouter-like providers by provider id, base URL, or explicit internal provider capability.
- When native tools are attempted for OpenRouter, pass provider options such as `require_parameters: true`.
- Keep this internal and defaulted; do not require config.
- Allow this behavior to be disabled or forced through an optional advanced provider-level override if needed.
- Log when OpenRouter-specific routing options were applied.

Expected output:

- Native tool attempts through OpenRouter are less likely to silently route to a provider that ignores `tools`.
- User config remains model/provider-only.

Verification:

```sh
pnpm run typecheck
pnpm test -- test/model*.test.ts
```

Manual smoke check with a known tool-capable model:

```sh
mise run smoke-live config/gemini.jsonc 1 google/gemini-3-flash-preview 10000
```

Dependencies: Slice 2.

## Slice 4: Runtime Protocol Selection

Status: `[x]` Implemented

Goal: Make `TopchesterAgentRuntime` try native tools first, then fall back automatically to text protocols.

Why here: This is the product behavior users feel. They should not decide which protocol a model needs.

This slice should implement:

- Add an internal `auto` flow:
  1. Try native tools.
  2. If native request fails with unsupported tools or incompatible parameters, retry with text JSON.
  3. If native returns no structured tool calls but text looks like a tool call, parse text JSON or XML.
  4. If no tool call is present, treat text as the assistant answer.
- Validate all normalized tool args with `getToolDefinition(...).argsSchema`.
- Execute native and text calls through the existing `executeToolCall(...)`.
- Feed tool results back into the next model step in a format compatible with the chosen protocol.
- Keep the existing `MAX_TOOL_CALLS_PER_TURN` limit.
- Add debug logs for protocol attempt, fallback reason, and chosen source.

Expected output:

- Normal users get automatic native tools when possible.
- Existing text JSON behavior remains the fallback path.

Verification:

```sh
pnpm run typecheck
pnpm test -- test/runtime*.test.ts test/tools.test.ts
pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --trials 1
```

Dependencies: Slices 1 and 2.

## Slice 5: XML Text Tool Parser

Status: `[x]` Implemented

Goal: Add XML-style text tool parsing as a compatibility fallback for models that emit Cline-like tool calls.

Why here: Live OpenRouter free-model smoke artifacts showed XML-ish output such as `<tool_call>read_file ...</tool_call>`. Supporting this gives cheaper models a chance without weakening native-first behavior.

This slice should implement:

- Add parser support for a conservative XML-style format.
- Support either:
  - Cline-style `<read_file><path>data.txt</path></read_file>`, or
  - observed `<tool_call>read_file ...</tool_call>` shape.
- Parse only known tool names.
- Validate parsed args with the existing Zod schema.
- Reject ambiguous, nested, duplicate, or partially parsed calls.
- Add parser tests with examples from smoke artifacts.
- Keep JSON parsing preferred over XML when both appear.

Expected output:

- Models that emit simple XML-style tool calls can still use Topchester tools.
- Parser behavior remains bounded and testable.

Verification:

```sh
pnpm test -- test/tools.test.ts
pnpm run typecheck
```

Dependencies: None, but runtime adoption happens in Slice 4.

## Slice 6: Smoke Report And Log Metadata

Status: `[x]` Implemented

Goal: Make protocol behavior visible in logs and smoke reports.

Why here: Tool failures can otherwise look like model quality failures. Smoke output should say whether the model used native tools, text JSON, text XML, or no tools.

This slice should implement:

- Add runtime log fields:
  - `toolProtocol`
  - `protocolAttempts`
  - `toolCallSource`
  - `fallbackReason`
- Add smoke report fields per trial:
  - `toolProtocol`
  - `nativeToolCallCount`
  - `textJsonToolCallCount`
  - `textXmlToolCallCount`
  - `providerRejectedTools`
  - `fallbackReason`
- Preserve current required-tool assertions.
- Update artifact summary output enough to diagnose model/tool mismatch quickly.

Expected output:

- Smoke reports distinguish provider/protocol failure from model-task failure.

Verification:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --trials 1
pnpm run typecheck
```

Dependencies: Slice 4.

## Slice 7: Docs And Optional Overrides

Status: `[x]` Implemented

Goal: Document the no-config-required model and add optional advanced protocol overrides.

Why here: Users need to know they configure models, not tools. Developers still need a way to force a protocol when debugging smoke runs or working around a provider/model quirk.

This slice should implement:

- Update `docs/MODEL_CONFIG.md` to say tools are Topchester-managed.
- Update `scripts/smoke/README.md` to explain protocol metadata in reports.
- Add an optional advanced provider-level override, defaulting to `auto`:
  - `toolProtocol: auto`
  - `toolProtocol: native`
  - `toolProtocol: text-json`
  - `toolProtocol: text-xml`
- Keep normal examples free of `toolProtocol` unless the example is explicitly about debugging.
- Use this precedence if more than one override exists:
  - CLI or smoke override
  - model assignment override
  - provider override
  - Topchester `auto` default
- Treat model assignment override as optional follow-up work unless live smoke results prove provider-level override is too coarse.
- If useful, add CLI or smoke overrides with the same values:
  - `--tool-protocol auto`
  - `--tool-protocol native`
  - `--tool-protocol text-json`
  - `--tool-protocol text-xml`
- Keep all overrides optional and out of required config.

Expected output:

- Normal setup docs stay simple.
- Debugging protocol behavior is possible without teaching every user about protocol internals.
- Provider-level quirks can be handled without changing every model assignment.

Verification:

```sh
pnpm run typecheck
pnpm exec tsx scripts/smoke/run-smoke.ts --dry-run
```

Dependencies: Slices 4 and 6.

## Testing Plan

Unit tests:

- Tool schema adapter converts every registered tool.
- Native tool result normalization accepts valid calls and rejects invalid args.
- JSON parser remains compatible.
- XML parser accepts only conservative known-tool shapes.
- Runtime fallback chooses the expected next protocol for simulated provider failures.
- Runtime logs protocol metadata without leaking full edit payloads.

Smoke tests:

- Fake API path proves existing text JSON fallback still works.
- A fake native-tool provider path proves native calls execute through the same runtime.
- Live OpenRouter smoke confirms protocol metadata is present even when a model fails.
- A weak/free model smoke can fail task assertions, but should still reveal whether it emitted native calls, text JSON, text XML, or plain text.

Final confidence check:

```sh
pnpm run check
mise run smoke 1
mise run smoke-live config/gemini.jsonc 1 google/gemini-3-flash-preview 10000
```

## Files to Add

- `src/agent/tools/ai-sdk-tools.ts`
- `src/agent/tools/xml-parser.ts` or parser cases inside `src/agent/tools/parser.ts`
- New model/runtime tests if existing test files become too broad.

## Files to Change

- `src/model/index.ts`
- `src/agent/runtime.ts`
- `src/agent/tools/parser.ts`
- `src/agent/tools/registry.ts`
- `src/agent/tools/types.ts` if normalized tool-call metadata needs a shared type.
- `scripts/smoke/run-smoke.ts`
- `scripts/smoke/README.md`
- `docs/MODEL_CONFIG.md`

## Open Questions

- Should native tool execution happen inside AI SDK `execute` callbacks, or should Topchester capture tool calls and execute them in `TopchesterAgentRuntime`? V0 should likely keep execution in runtime so logs, events, KB dirty state, and smoke assertions stay in one place.
- Should provider capability be inferred from `type: openai-compatible`, or should Topchester keep a private provider-capability table keyed by provider id/base URL?
- Should the XML fallback support both Cline-style tags and the observed `<tool_call>` wrapper, or only the observed wrapper first?
- Should native tool-result history be represented as provider-native model messages immediately, or can V0 continue with text-formatted tool results after a native call? Full native history is cleaner but larger.

## Implementation Notes

- `src/agent/tools/ai-sdk-tools.ts` adapts registered Topchester tools into AI SDK tool schemas.
- `ModelGateway.generateAgentStep(...)` owns auto protocol selection, native OpenAI-compatible requests, text fallback, OpenRouter routing options, and normalized tool-call metadata.
- `TopchesterAgentRuntime` executes native, JSON, and XML tool calls through the existing tool executor and logs protocol metadata on model responses.
- `scripts/smoke/run-smoke.ts` records protocol fields per trial and supports `--tool-protocol` for debugging.
- `scripts/smoke/fake-api.ts` supports both text fallback and fake native tool-call responses for smoke coverage.
- `docs/MODEL_CONFIG.md` documents that tools are Topchester-managed and that protocol overrides are advanced-only.

## Next Slice

Run the full verification gates and use live smoke when provider keys are available.
