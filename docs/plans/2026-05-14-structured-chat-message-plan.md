# Structured ChatMessage Tool Rows Plan

## Summary

Move TUI chat rendering away from guessing message meaning from plain text and toward a structured `ChatMessage` union that keeps tool calls as tool calls until render time.

The immediate driver is `src/tui/messages.ts` treating any system line that starts with text such as `read_file: ` or `edit_file: ` as a tool row. That is only a display heuristic today, not the runtime execution path, but it is still the wrong contract: a rendered line of text should not decide whether a message is a tool call.

Target shape:

```ts
type ChatMessage =
  | { kind: "system"; text: string; modelContext?: boolean }
  | { kind: "user"; text: string; modelContext?: boolean }
  | { kind: "agent"; text: string; meta?: string; modelContext?: boolean }
  | { kind: "tool_call"; call: ToolCall; label: string; resultSummary?: string }
  | { kind: "modal"; ... };
```

## Decisions

- Tool-call identity must come from event/message structure, not from matching display text.
- Existing runtime execution semantics stay unchanged. `AgentToolCallEvent.call` is already structured and remains the source of truth for executed tools.
- Existing session `tool_call` events remain valid. Old events that only have `label` and `call` should rehydrate into `ChatMessage.kind === "tool_call"` with no migration.
- `label` remains the compact visible row text for now, so this migration can avoid rebuilding every tool label formatter in the first slice.
- `resultSummary` is optional. It can be introduced where the runtime already knows structured edit/create summaries, but rendering must not require it for old sessions.
- Model context stays explicit. Tool-call rows should not become model-facing chat turns just because they are visible in the TUI.

## Scope

Covered:

- `ChatMessage` type and helpers in `src/tui/messages.ts`.
- Runtime-event to TUI-message conversion in `src/tui/runtime-events.ts`.
- Session rehydration and persistence conversion in `src/session/store.ts` and `src/tui/shell.ts`.
- Conversation-turn filtering in TUI and non-interactive resume paths.
- Focused render/session tests plus TUI documentation for compact tool rows.

Out of scope:

- Changing how model tool calls are parsed or executed.
- Changing the `AgentRuntimeEvent` event model beyond optional display metadata.
- Adding new tool result history or full `tool_result` persistence.
- Redesigning tool labels or replacing the current compact row copy.

## Current State

- `AgentToolCallEvent` is structured: it has `type: "tool_call"`, `call: ToolCall`, and `label: string`.
- `runtimeEventToSessionPayload(...)` persists tool calls as `kind: "tool_call"` with both `label` and `call`.
- `renderRuntimeEvent(...)` flattens tool calls to `systemMessage(event.label)`.
- `rehydrateSession(...)` also flattens persisted `tool_call` events to `{ kind: "system", text: event.label }`.
- `renderChatMessage(...)` later infers tool-call styling from `isToolCallLine(line)`.
- `ChatLayout.getConversationTurns()` and `cli/run.ts` only include user and agent messages today, so tool rows are not model context in practice.

## Recommended Approach

Add a first-class `tool_call` branch to the TUI message model and route all tool-call creation through it.

The renderer should switch on `message.kind`:

- `system`: render as a normal system message with no tool-name regex.
- `tool_call`: render the compact muted tool row.
- `user`, `agent`, and `modal`: keep existing behavior.

The session layer should preserve the existing durable event shape and simply rehydrate `kind: "tool_call"` into the new TUI message kind. This keeps old sessions readable and avoids a storage migration.

`resultSummary` should be treated as a display enhancement, not a parsing dependency. A later slice may populate it directly from structured tool results, but no renderer should need to parse `label` to decide that a row is a tool row.

## Cross-Slice Rules

- Do not infer message kind from text prefixes.
- Do not include `tool_call` rows in model context unless a later design explicitly chooses a structured model-facing representation.
- Keep old session files valid.
- Preserve compact visible tool rows in the thread area.
- Keep user-facing wording plain and update `docs/tui.md` when visible TUI behavior changes.

## Files to Change

- `src/tui/messages.ts`
- `src/tui/runtime-events.ts`
- `src/session/store.ts`
- `src/tui/shell.ts`
- `src/tui/layout.ts`
- `src/cli/run.ts`
- `src/agent/events.ts` if `resultSummary` is promoted onto runtime events
- `src/agent/runtime.ts` if `resultSummary` is produced beside labels
- `test/tui.render.test.ts`
- `test/session.test.ts`
- `docs/tui.md`

## Slices

### Slice 1: Add Structured Tool ChatMessage

Status: `[ ]` Not started

Goal: Make the TUI message model capable of representing tool calls without changing behavior yet.

Why here: The type boundary has to exist before event rendering and session rehydration can stop flattening tool calls into system text.

This slice should implement:

- Import `ToolCall` into `src/tui/messages.ts`.
- Replace the broad `TextChatMessage` shape with explicit `system`, `user`, `agent`, and `tool_call` message interfaces.
- Add a `toolCallMessage(call, label, resultSummary?)` helper.
- Keep `systemMessage`, `userMessage`, `agentMessage`, and `modalMessage` helpers.
- Update TypeScript narrowing in `renderChatMessage(...)` and `getPrefix(...)`.

Expected output:

- `ChatMessage` can carry `{ kind: "tool_call", call, label, resultSummary? }`.
- Existing callers still compile after adapting to the more explicit union.

Verification:

- `pnpm check`

Dependencies:

- None.

### Slice 2: Render Tool Rows by Kind

Status: `[ ]` Not started

Goal: Remove `isToolCallLine(...)` as the authority for tool-row rendering.

Why here: Once `tool_call` messages exist, rendering can use the structured kind directly.

This slice should implement:

- Add a `renderToolCallMessage(...)` path in `src/tui/messages.ts`.
- Render compact tool rows with the same visible text as today.
- Keep edit/create summaries visually muted, preferably from `resultSummary` when present.
- Stop muting arbitrary system lines that merely start with a tool-looking prefix.
- Remove or sharply limit `isToolCallLine(...)`.

Expected output:

- A system message containing `read_file: README.md` renders as a normal system message.
- A `tool_call` message with label `read_file: README.md` renders as the compact muted tool row.

Verification:

- Focused render tests in `test/tui.render.test.ts`.
- `pnpm test -- test/tui.render.test.ts`

Dependencies:

- Slice 1.

### Slice 3: Preserve Tool Structure Through Runtime Events

Status: `[ ]` Not started

Goal: Convert live runtime tool events into structured TUI messages.

Why here: The live TUI path currently loses structure at `renderRuntimeEvent(...)`.

This slice should implement:

- Change `renderRuntimeEvent(event.type === "tool_call")` to return `toolCallMessage(event.call, event.label, event.resultSummary?)`.
- Decide whether `resultSummary` belongs on `AgentToolCallEvent` now or should wait for a later cleanup.
- If adding `resultSummary`, populate it where `formatToolCallMessage(...)` already has structured tool results.
- Keep label text compatible with existing UI expectations.

Expected output:

- Live tool rows are structured before rendering.
- Runtime tool execution order and labels remain unchanged.

Verification:

- Existing command/runtime tests that assert tool-call labels.
- `pnpm test -- test/commands.test.ts test/tui.render.test.ts`

Dependencies:

- Slice 1.
- Slice 2.

### Slice 4: Rehydrate And Persist Structured Chat Messages

Status: `[ ]` Not started

Goal: Keep tool calls structured across session resume and persistence helpers.

Why here: Resume currently recreates tool rows as system text, which would keep the old ambiguity alive for persisted sessions.

This slice should implement:

- Change `rehydrateSession(...)` so persisted `kind: "tool_call"` events become `ChatMessage.kind === "tool_call"`.
- Update `chatMessageToSessionPayload(...)` to persist `tool_call` chat messages back as `kind: "tool_call"`.
- Keep old session records with no `resultSummary` valid.
- Ensure session save warnings still use plain system messages.

Expected output:

- Resumed TUI sessions render old tool calls through the structured tool-row renderer.
- No event-log migration is required.

Verification:

- Session rehydration tests in `test/session.test.ts`.
- Resume-related TUI tests in `test/tui.render.test.ts`.
- `pnpm test -- test/session.test.ts test/tui.render.test.ts`

Dependencies:

- Slice 1.
- Slice 2.

### Slice 5: Guard Model Context And Non-Interactive Resume

Status: `[ ]` Not started

Goal: Make all conversation-turn builders intentionally ignore `tool_call` chat messages.

Why here: The current behavior is safe by omission, but the new union should make that choice explicit.

This slice should implement:

- Update `ChatLayout.getConversationTurns()` to return no turn for `tool_call`.
- Update `cli/run.ts` resume conversation loading to return no turn for `tool_call`.
- Keep `modelContext === false` behavior for user/agent/system-visible messages.
- Add tests that a resumed tool row does not become a model-facing user/system/assistant turn.

Expected output:

- Tool rows stay visible history, not model conversation content.
- TypeScript exhaustiveness makes future message kinds harder to leak into model context by accident.

Verification:

- Focused tests for TUI and non-interactive resume filtering.
- `pnpm test -- test/tui.render.test.ts test/session.test.ts`

Dependencies:

- Slice 4.

### Slice 6: Documentation And Cleanup

Status: `[ ]` Not started

Goal: Align docs and remove obsolete regex-based assumptions.

Why here: TUI behavior changes should update `docs/tui.md`, and cleanup should happen only after structured paths are covered by tests.

This slice should implement:

- Update `docs/tui.md` if compact tool-row wording or behavior needs clarification.
- Remove stale comments or tests that imply tool rows are system messages.
- Add a short test case that protects against system text prefix collisions.
- Run the repo-standard checks.

Expected output:

- Docs describe compact tool rows without implying they are plain system messages.
- The old regex hazard is covered by regression tests.

Verification:

- `pnpm check`

Dependencies:

- Slices 1 through 5.

## Testing Plan

Per-slice tests should stay focused on the touched boundary. Final verification should run:

```sh
pnpm check
```

Useful focused checks while implementing:

```sh
pnpm test -- test/tui.render.test.ts
pnpm test -- test/session.test.ts
pnpm test -- test/commands.test.ts
```

Manual sanity check:

- Start `topchester`.
- Trigger a simple tool call.
- Confirm the thread still shows compact tool rows.
- Confirm a normal system message that starts with `read_file: ` is not styled as a tool row.
- Resume a session with older persisted `tool_call` events and confirm rows render correctly.

## Open Questions

- Should `resultSummary` be added to `AgentToolCallEvent` and persisted session events now, or should it remain a TUI-only optional field until full `tool_result` persistence exists?
- Should `tool_call` rows eventually show an icon or `Tool` prefix, or keep the current bare compact label?
- Should system messages be included in `ChatMessage` at all for model context, or should visible system rows and model-facing system prompts be completely separate types in a later cleanup?

## Next Slice

Start with Slice 1.
