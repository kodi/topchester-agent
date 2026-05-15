# TUI Streamed Reasoning Plan

## Summary

Add an opt-in interactive TUI feature that shows provider-exposed reasoning text while the agent is thinking. The feature is enabled only when `TOPCHESTER_STREAM_REASONING=1` is set for the interactive `topchester` TUI.

The target behavior is:

- If the configured model/provider streams reasoning deltas, show a dim, transient rolling tail in the thread area while work is active.
- If the configured model/provider exposes only a final reasoning summary, show that summary as transient text when it becomes available, without delaying the final answer.
- If no reasoning data is exposed, keep the current spinner text.
- Never write reasoning text into session history, model conversation history, JSON run output, or KB data.
- Preserve native tool calls, text JSON fallback, text XML fallback, usage metadata, and provider rejection handling.

This plan exists because the visible UI change is small, but the safe implementation crosses the model gateway, agent runtime, TUI busy state, and session persistence boundaries.

## Decisions

- Use `TOPCHESTER_STREAM_REASONING=1` as the V0 enable flag.
- Enable the feature only from the interactive TUI path. `topchester run` should not request or print streamed reasoning by default.
- Do not prompt the model to reveal hidden reasoning. Only render reasoning output that the provider/AI SDK marks as reasoning data, such as `reasoning-delta` or `reasoningText`.
- Prefer a separate transient callback path over adding reasoning to `AgentRuntimeEvent`. This keeps session persistence and JSON event output out of the data path by construction.
- Keep `AgentRuntimeEvent` for durable or user-visible completed events: messages, tool rows, task plans, choices, status, and KB status.
- Keep the existing spinner as the fallback display when reasoning is unavailable or delayed.
- Use `ui.muted(...)` for the reasoning text in the TUI.
- Render a capped rolling tail, not an unlimited transcript.
- Clear the reasoning display on final assistant message, tool call, choice, cancellation, error, and busy stop.

## Scope

Included:

- Model gateway support for optionally consuming `streamText(...).fullStream` during agent steps.
- Reasoning-delta and reasoning-summary callbacks from the model layer.
- Runtime plumbing that accepts an optional transient sink without changing session event schemas.
- TUI env-var gate and rendering through the existing busy/ephemeral line path.
- Tests that prove tool behavior remains intact and reasoning text is not persisted.
- Documentation for the env var and interactive-only behavior.

Not included:

- Making reasoning visible in `topchester run`.
- Persisting reasoning text for resume, audit, or debugging.
- Adding a slash command or config-file setting for this feature.
- Parsing plain assistant text, `<think>` tags, or markdown as reasoning.
- Showing reasoning from startup health checks, KB sync, or slash commands.
- A multi-line reasoning panel. V0 should use the existing ephemeral line surface.

## Current State

- `src/model/index.ts` exposes `ModelGateway.generateAgentStep(...)`, which currently uses non-streaming `generateText(...)` for native tool calls and text fallback calls.
- `src/model/index.ts` also exposes `streamText(...)`, but that helper only yields normal text and is not used for tool-capable agent turns.
- AI SDK v6 exposes `fullStream` events, including `reasoning-start`, `reasoning-delta`, and `reasoning-end`. It also exposes final `reasoningText`.
- `src/agent/runtime.ts` calls a local `generateAgentStep(...)` shim during each tool-loop iteration. That shim passes the full tool registry to gateways that support `generateAgentStep(...)`.
- `src/tui/shell.ts` starts a `BusyIndicator` for chat turns and applies runtime events as they arrive.
- `src/tui/busy.ts` owns the spinner text and writes to `ChatLayout.setEphemeralLine(...)` every 80ms.
- `src/tui/layout.ts` renders `ephemeralLine` in the thread area. It is not part of `getConversationTurns()`.
- `src/session/events.ts` has no ephemeral event type. That is good: reasoning should not be added there.
- `src/tui/shell.ts` persists only payloads returned by `runtimeEventToSessionPayload(...)`.
- `docs/tui.md` documents the existing busy-state behavior.

## Behavior To Preserve

- Normal agent turns must continue to use the existing bounded tool loop.
- Native OpenAI-compatible tools must still be tried first when protocol is `auto`.
- If native tools are rejected, the same turn must continue through text JSON/XML fallback as it does today.
- Tool calls must still be parsed, validated, executed, logged, displayed as compact tool rows, and fed back into the next model prompt.
- Token usage, cost extraction for OpenRouter, warnings, fallback reason, protocol attempts, and `openRouterRoutingApplied` must stay available in the final `ModelAgentResult`.
- Session logs must remain valid for resume. Old sessions must keep loading.
- If `TOPCHESTER_STREAM_REASONING` is unset, behavior should be indistinguishable from today except for internal refactors covered by tests.

## Implementation Shape

Add a narrow transient callback contract. Suggested model-layer shape:

```ts
export interface ModelReasoningEvent {
  type: "delta" | "summary" | "clear";
  text?: string;
}

export type ModelReasoningSink = (event: ModelReasoningEvent) => void | Promise<void>;

export interface ModelAgentRequest extends ModelRequest {
  tools: readonly ToolDefinition<string, unknown>[];
  toolProtocol?: ToolProtocolOverride;
  onReasoning?: ModelReasoningSink;
}
```

When `onReasoning` is absent, keep using the current non-streaming implementation path.

When `onReasoning` is present, `ModelGateway.generateAgentStep(...)` should use streaming equivalents of the existing native and text fallback paths:

- Native path: call `streamText(...)` with `tools`, `toolChoice: "auto"`, existing provider options, and the abort signal.
- Text fallback path: call `streamText(...)` without tools, then parse the final text through `parseToolCallWithSource(...)`.
- Consume `result.fullStream` to forward only `reasoning-delta` chunks to `onReasoning`.
- Track whether at least one delta was seen.
- After the stream finishes, await the same final result fields used today: `text`, `toolCalls`, `usage`, `warnings`, `response`, and `reasoningText`.
- If no deltas were seen and `reasoningText` is present, emit a `summary` event before returning.
- Return the same `ModelAgentResult` shape as the non-streaming path.

The current `generateNativeAgentStep(...)` and `generateTextAgentStep(...)` should either share helpers with the streaming versions or be kept close enough that tests prove parity. Avoid a broad rewrite unless it removes real duplication.

## TUI Data Flow

```text
TOPCHESTER_STREAM_REASONING=1
  -> TopchesterTuiShell.submitChatMessage(...)
  -> runtime.submitMessage(..., { onReasoning })
  -> ModelGateway.generateAgentStep(..., onReasoning)
  -> AI SDK fullStream reasoning-delta events
  -> ReasoningTailBuffer
  -> BusyIndicator.setActivity(ui.muted(tail))
  -> ChatLayout ephemeral line
```

Key rule: this data flow must not pass through `AgentRuntimeEvent`, `SessionEventPayload`, `chatMessageToSessionPayload(...)`, or `runtimeEventToSessionPayload(...)`.

## Reasoning Tail Display

V0 should keep the current single ephemeral row. Add a small formatter/helper, likely in `src/tui/busy.ts` or a new `src/tui/reasoning-tail.ts`.

Recommended behavior:

- Normalize whitespace so rapid token deltas do not create noisy line breaks.
- Keep a capped tail by visible width or character count. A starting cap of roughly 200 to 300 visible characters is enough.
- Prefix with the spinner frame through `BusyIndicator`, the same as normal busy text.
- Style only the reasoning text with `ui.muted(...)`.
- Do not label it as "chain of thought"; use no extra label in V0 unless tests show the line is ambiguous.
- If the provider emits only a final summary, show that summary using the same cap.
- If no reasoning arrives, keep rotating through `Thinking...`, `Calling model...`, and `Writing response...`.

Important implementation detail: `BusyIndicator` currently rewrites the ephemeral line on every timer tick. Reasoning display should route through `BusyIndicator` or an owned transient display helper, not direct repeated calls to `app.setEphemeralLine(...)` from runtime callbacks.

## Edge Cases

- Provider has no reasoning support: no reasoning callback events are emitted; spinner remains unchanged.
- Provider emits empty or whitespace-only reasoning deltas: ignore them.
- Provider emits a huge reasoning stream: keep the full text for the current turn only, render it as wrapped dim thinking text, and do not store it in session history.
- Provider emits reasoning while also preparing a tool call: clear the reasoning tail when the tool-call event is applied.
- Native streaming call fails because tools are unsupported: preserve existing fallback behavior and then stream reasoning from the text fallback call if available.
- Abort while reasoning is visible: abort controller stops the model call, busy stop clears the ephemeral line, and the session gets only the existing stopped message/status behavior.
- Error while reasoning is visible: busy stop clears the line, and the persisted session gets only the existing chat-failed status.
- Final answer arrives immediately after a summary-only reasoning result: do not delay final answer just to make the summary readable.
- Non-interactive `topchester`: do not pass `onReasoning`, even if the env var is set.

## Files To Change

Likely implementation files:

- `src/model/index.ts` - optional streaming agent-step path and reasoning callback type.
- `src/agent/runtime.ts` - accept and pass a transient reasoning sink through `submitMessage(...)` and the local `generateAgentStep(...)` shim.
- `src/tui/shell.ts` - read `TOPCHESTER_STREAM_REASONING`, build the reasoning sink for interactive chat turns, and clear the display on durable events.
- `src/tui/busy.ts` - support reasoning activity overrides, clearing overrides, and muted/capped transient text.
- `src/tui/layout.ts` - likely no structural change, but tests may need small additions for ANSI-muted ephemeral content.
- `docs/tui.md` - document the env var and fallback behavior.

Likely test files:

- `test/model.test.ts`
- `test/commands.test.ts`
- `test/tui.render.test.ts`
- `test/session.test.ts` or an existing shell/runtime persistence test if one already covers event payload mapping.

Files that should not need a schema change:

- `src/session/events.ts`

If implementation requires adding a session event kind for reasoning, stop and revisit the design before proceeding.

## Slices

### Slice 1: Add The Transient Reasoning Contract

Status: `[x]` Completed

Goal: Define a small optional callback contract for provider-exposed reasoning without changing durable runtime events.

Why here: The contract should be explicit before model streaming or TUI rendering is changed.

This slice should implement:

- Add `ModelReasoningEvent` and `ModelReasoningSink` types in the model/runtime boundary.
- Extend `ModelAgentRequest` with optional `onReasoning`.
- Extend `AgentRuntime.submitMessage(...)` with an optional transient sink argument or options object.
- Keep `AgentRuntimeEvent` unchanged unless a later implementation proves a separate non-persisted event interface is clearer.
- Add tests or type-level coverage showing existing runtime callers still compile and legacy fake gateways still work.

Expected output:

- A compiled contract that can carry reasoning deltas from model gateway to runtime/TUI code.
- No behavior change when the callback is absent.
- No session schema change.

Verification:

```sh
pnpm test -- test/commands.test.ts
```

Dependencies: None.

### Slice 2: Stream Agent Steps Without Breaking Tool Protocols

Status: `[x]` Completed

Goal: Add streaming model-gateway paths that preserve the existing `ModelAgentResult` behavior while forwarding reasoning deltas when requested.

Why here: This is the risky runtime slice. It must prove that streaming reasoning does not break native tools or fallback tools.

This slice should implement:

- Keep the existing non-streaming path when `onReasoning` is absent.
- Add a streaming native agent-step path using AI SDK `streamText(...).fullStream`.
- Add a streaming text fallback path for text JSON/XML protocols.
- Forward only AI SDK reasoning events to `onReasoning`.
- Use final `reasoningText` only as a summary fallback when no streaming deltas arrived.
- Preserve `toolCalls`, `toolProtocol`, `protocolAttempts`, `providerRejectedTools`, `fallbackReason`, `warnings`, usage, cost extraction, and `openRouterRoutingApplied`.
- Preserve native-tool rejection fallback behavior when streaming native calls fail.

Expected output:

- `ModelGateway.generateAgentStep(...)` can stream reasoning when requested and still returns the same normalized agent result.
- Existing model tests pass with and without the callback.
- New tests cover at least one reasoning-delta stream and one native-tool fallback path with the callback present.

Verification:

```sh
pnpm test -- test/model.test.ts
```

Dependencies: Slice 1.

### Slice 3: Wire The Interactive TUI Env Gate

Status: `[x]` Completed

Goal: Enable the feature only for interactive TUI chat turns when `TOPCHESTER_STREAM_REASONING=1` is set.

Why here: The TUI should opt into the transient callback after the model path is proven safe.

This slice should implement:

- Add a small env reader, for example `isStreamReasoningEnabledByEnv()`.
- In `TopchesterTuiShell.submitChatMessage(...)`, pass the reasoning sink only when the env var is enabled.
- Do not pass the reasoning sink from `src/cli/run.ts`.
- Do not enable this for startup agent checks or slash commands.
- Ensure cancellation still uses the existing abort controller path.

Expected output:

- Interactive TUI chat turns request reasoning only with `TOPCHESTER_STREAM_REASONING=1`.
- Non-interactive run behavior stays unchanged.

Verification:

```sh
pnpm test -- test/commands.test.ts
```

Dependencies: Slice 2.

### Slice 4: Render A Muted Rolling Reasoning Tail

Status: `[x]` Completed

Goal: Show reasoning text through the existing ephemeral busy row without storing it.

Why here: The rendering layer needs to account for the busy timer that continuously rewrites the ephemeral line.

This slice should implement:

- Add a `ReasoningTailBuffer` or equivalent helper that accepts deltas, normalizes whitespace, and returns a capped tail.
- Route reasoning display through `BusyIndicator`, not direct competing writes to `ChatLayout.setEphemeralLine(...)`.
- Add a `BusyIndicator` method to set and clear an activity override safely.
- Apply `ui.muted(...)` to reasoning text.
- Clear the override when durable runtime events arrive that should replace the transient state: tool call, final assistant message, choice, status ready, cancellation, and error.
- Keep normal spinner activity when no reasoning has arrived.

Expected output:

- The TUI shows dim ephemeral reasoning text while the model streams supported reasoning output.
- The reasoning line is bounded and cleared reliably.
- Existing busy-state rendering still passes.

Verification:

```sh
pnpm test -- test/tui.render.test.ts
```

Dependencies: Slice 3.

### Slice 5: Prove Reasoning Is Never Persisted

Status: `[x]` Completed

Goal: Add persistence-focused coverage so future changes cannot accidentally write reasoning text into session history.

Why here: The main product constraint is data hygiene. It deserves an explicit slice instead of relying on implementation intent.

This slice should implement:

- Add a test with a fake model gateway that emits reasoning through the callback and then returns a final answer.
- Assert that session payloads include the user message and final assistant/tool/status events only.
- Assert that the reasoning text does not appear in `events.jsonl`, rehydrated messages, or `getConversationTurns()`.
- Confirm `runtimeEventToSessionPayload(...)` has no reasoning branch.

Expected output:

- Automated proof that streamed reasoning remains transient.

Verification:

```sh
pnpm test -- test/session.test.ts test/commands.test.ts
```

Dependencies: Slices 1-4.

### Slice 6: Docs And Final Verification

Status: `[x]` Completed

Goal: Document the env var and run the standard check.

Why here: TUI behavior changes should update `docs/tui.md`, and the final slice should catch integration errors across model, runtime, TUI, and session layers.

This slice should implement:

- Update `docs/tui.md` with `TOPCHESTER_STREAM_REASONING=1`.
- State that the feature is interactive-only, provider-dependent, transient, dim, and not saved in session history.
- Mention that unsupported providers continue showing the normal spinner.
- If implementation discovers any provider-specific limitations, add them to this plan under Working Notes and to docs only if user-facing.

Expected output:

- User-facing docs match the implemented behavior.
- Repo checks pass.

Verification:

```sh
pnpm check
```

Dependencies: Slices 1-5.

## Testing Plan

Per-slice tests are listed above. The final confidence pass should include:

```sh
pnpm test -- test/model.test.ts test/commands.test.ts test/tui.render.test.ts test/session.test.ts
pnpm check
```

Manual TUI checks after implementation:

```sh
TOPCHESTER_STREAM_REASONING=1 topchester
topchester
topchester run "Say hello"
```

Manual expectations:

- With a reasoning-capable provider in the interactive TUI, a dim transient reasoning tail appears while the model is working.
- With a provider that does not expose reasoning, the normal spinner remains.
- Without the env var, the normal spinner remains.
- `topchester run` does not print reasoning by default.
- After the turn, `.agents/topchester/sessions/<session>/events.jsonl` does not contain reasoning text.

## Open Questions

- Should V0 use a fixed character cap, a visible-width cap, or a small number of wrapped lines for the reasoning tail? Recommended default: fixed character cap first, then refine if it feels cramped.
- Should the line include a short label such as `thinking:`? Recommended default: no label, keep it visually quiet and dim.
- Do any configured providers expose final reasoning summaries but no deltas through the OpenAI-compatible path? Implementation should test the AI SDK behavior with the user's real provider before documenting provider-specific claims.

## Working Notes

- Implemented with a transient `ModelReasoningSink` path that stays outside `AgentRuntimeEvent` and session payload schemas.
- Streaming is used only when a reasoning sink is present. The default non-streaming agent-step path remains in place when `TOPCHESTER_STREAM_REASONING` is unset.
- Interactive TUI chat turns opt in through `TOPCHESTER_STREAM_REASONING=1`; `topchester run`, startup checks, and slash commands do not pass a reasoning sink.
- Verification completed with focused model/runtime/TUI coverage, `pnpm check`, and `mise run local-ci`.
- Follow-up UI adjustment: the TUI now keeps full provider reasoning visible as a dim non-persisted thinking row above the final answer instead of clearing it or showing a rolling tail after the answer.
- Added regression coverage for leading `plan_todo` JSON followed by prose, including literal newlines inside JSON strings. Completed-only `plan_todo` text is suppressed when no visible plan is open, and the appended final answer renders without raw JSON.
- Log-backed follow-up: `.agents/topchester/logs/topchester.log` showed OpenAI native tool mode returning `toolCalls: []` while putting text-JSON `plan_todo` in `text`. The model gateway now recovers leading text-JSON tool calls from native responses before returning final assistant text, even when native protocol is forced.
