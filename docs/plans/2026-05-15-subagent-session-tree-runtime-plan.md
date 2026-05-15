# Subagent Session Tree Runtime Plan

## Summary

Topchester's runtime is currently shaped around one visible chat turn: the TUI sends a message, the runtime emits a flat list of events, optional callbacks let the TUI update incrementally, and the session log records those events. That is enough for a single agent loop, but subagents need a stronger contract: a parent run should be able to spawn child runs, stream their progress, persist their output as real sessions, and feed controlled results back into the parent model.

This plan promotes runtime events and sessions from a single flat chat stream into a session tree with streamed child runs. The first target is a `task`/`subagent` tool backed by a `SubagentManager`, with task-only parallelism before general multi-tool parallel execution.

## Decisions

- Child agents are real sessions, not hidden promises inside a tool call.
- The runtime event stream becomes the canonical in-process contract; session JSONL remains the durable source of truth.
- The parent model sees bounded child results as tool output; the TUI and session log can see streamed child events.
- Agent profiles define model slot, prompt additions, available tools, and permission constraints.
- Subagents inherit parent denies and cannot expand the parent's tool permissions.
- Parallel execution starts with `task` only. Mutating tools, git tools, and command tools stay sequential until the scheduler has explicit safety rules.
- Streaming child output is UI-visible by default, but model-visible child context remains summarized or final-result only.

## Scope

Included:

- Define event and session tree types.
- Refactor runtime execution to a first-class event stream.
- Persist child sessions and parent-child links.
- Add agent profiles and tool permission filtering.
- Add a `task`/`subagent` tool backed by `SubagentManager`.
- Add parallel execution for `task` calls only.
- Expand later to general multi-tool parallelism with per-tool scheduling rules.

Excluded for these slices:

- External app server or remote worker protocol.
- Full GUI session-tree explorer.
- Worktree-per-subagent isolation.
- MCP-hosted subagent workers.
- Making every tool parallel in the first subagent implementation.
- Replacing the existing model gateway.

## Current State

- `src/agent/runtime.ts` owns the main coding-agent loop. `submitMessage(...)` returns `Promise<AgentRuntimeEvent[]>`, accepts an optional `onEvent`, builds the model prompt, executes at most one selected tool call per loop iteration, appends tool results to the model context, and returns accumulated runtime events.
- `src/agent/events.ts` defines a flat `AgentRuntimeEvent` union for status, message, tool call, task plan, knowledge status, and choice events.
- `src/session/events.ts` defines append-only session metadata and JSONL event payloads. Metadata has `sessionId`, workspace path, timestamps, and `lastEventId`, but no parent/child session links.
- `src/agent/tools/types.ts` gives tools a narrow `ToolContext` with workspace, path env, logger, and task plan updater. There is no event sink, subagent manager, or permission view in the tool context.
- `src/tui/shell.ts` already consumes runtime events incrementally through `onEvent`, so the TUI does not need to wait for the full turn before rendering. That is useful, but the callback is still an adapter around a flat turn result rather than the runtime's primary interface.
- `docs/ARCHITECTURE.md` explicitly keeps the runtime boundary as a typed command/event boundary and says a scoped event hub can be added around the runtime/session boundary when plugins, background tasks, or multiple clients need fanout.
- `docs/SESSIONS.md` says session JSONL is the project-local source of truth and warns to keep model-facing roles separate from UI/runtime events. The subagent design should preserve that separation.

## Competitor Findings

Local competitor checkouts support the same direction:

- OpenCode and Kilo implement a `task` tool that creates or resumes child sessions with `parentID`, stores task metadata, supports `subagent_type`, derives permissions from parent context, runs the child prompt, and returns a bounded task result to the parent.
- OpenCode profiles distinguish primary and subagent modes. Built-in subagents such as general/explore/scout have their own prompts, model choices, and permissions.
- OpenCode's subagent permissions start from parent/session denies and default-deny recursive task and todo-write style tools unless explicitly allowed.
- Pi models runtime as streamed events with message start/update/end and tool execution start/update/end. It supports sequential and parallel tool execution while preserving assistant source order for model-visible tool results.
- Codex app-server protocol models threads with `sessionId`, `forkedFromId`, source, nickname, and role. Its subagent tools create explicit child-thread edges instead of treating child work as invisible tool internals.

The useful pattern is not "add a task helper." It is "make child work first-class in the runtime/session model, then expose it through a task tool."

## Target Runtime Shape

Parent run flow:

```text
user message
  -> parent session turn
  -> parent model step
  -> task tool call A and task tool call B
  -> child session A streams events
  -> child session B streams events
  -> parent receives bounded task results in deterministic order
  -> parent model summarizes and continues
  -> parent session records final visible answer
```

The event stream should carry enough information for the TUI to render this shape without coupling the TUI to model internals:

```ts
type RuntimeEvent =
  | ParentMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | SubagentStartedEvent
  | SubagentEventForwardedEvent
  | SubagentCompletedEvent
  | SubagentFailedEvent;
```

The durable session tree should carry enough information for resume, inspection, and future UI tree views:

```ts
type SessionMetadata = {
  sessionId: string;
  rootSessionId?: string;
  parentSessionId?: string;
  parentToolCallId?: string;
  source: "user" | "subagent";
  agentProfileId?: string;
  title?: string;
};
```

Model-visible messages stay separate from runtime/session events. A subagent can stream hundreds of UI events, but the parent model should usually receive one tool result that contains the final answer, status, child session id, and optional concise findings.

## Cross-Slice Rules

- Keep every slice shippable and reviewable on its own.
- Keep existing sessions readable; add optional metadata fields or versioned migrations rather than breaking old JSONL.
- Keep `submitMessage(...)` as a compatibility wrapper while introducing the event-stream API.
- Keep TUI rendering as a consumer of runtime events, not the owner of runtime state.
- Do not add a global event bus. If fanout is needed, keep it scoped to a runtime run or session tree.
- Always preserve deterministic model-visible tool-result order, even when UI events stream in completion order.
- Pass cancellation from parent runs into child runs.
- Child profiles may reduce permissions, but never increase them beyond the parent context.
- Add docs when CLI/TUI behavior or persisted session shape changes.

## Files To Change

Likely additions:

- `src/agent/profiles.ts`
- `src/agent/subagents.ts`
- `src/agent/runtime-stream.ts` or equivalent internal stream helper
- `src/agent/tools/task.ts`
- focused tests for runtime streaming, session tree persistence, profiles, permissions, and task tool behavior

Likely updates:

- `src/agent/events.ts`
- `src/agent/runtime.ts`
- `src/agent/tools/types.ts`
- `src/agent/tools/registry.ts`
- `src/model/index.ts`
- `src/session/events.ts`
- `src/session/store.ts`
- `src/tui/shell.ts`
- `src/tui/messages.ts`
- `src/tui/layout.ts`
- `src/cli/run.ts`
- `docs/ARCHITECTURE.md`
- `docs/SESSIONS.md`

## Testing Strategy

- Type-level tests for event/session schemas and backwards compatibility with old session metadata.
- Unit tests for stream ordering, `submitMessage(...)` compatibility, and abort propagation.
- Unit tests for child session creation, persistence, and rehydration.
- Unit tests for profile resolution and permission filtering.
- Fake-model tests for `task` tool execution and child result injection into parent context.
- TUI render tests for streamed child events, completed child task blocks, and failed child task blocks.
- Smoke tests with fake API before live API runs.
- Full `pnpm check` after each slice that changes runtime or shared type contracts.

## Slice 1: Define Event And Session Tree Types

Status: [x] Done

Goal:

Introduce the durable and in-memory type contracts required for session trees without changing runtime behavior.

Implementation:

- Extend `AgentRuntimeEvent` with subagent lifecycle events:
  - `subagent_started`
  - `subagent_event`
  - `subagent_completed`
  - `subagent_failed`
- Add optional session tree fields to session metadata:
  - `rootSessionId`
  - `parentSessionId`
  - `parentToolCallId`
  - `source`
  - `agentProfileId`
  - `title`
- Add session event payloads for child-session lifecycle references.
- Keep old session metadata readable by defaulting `source` to `user` and `rootSessionId` to `sessionId`.
- Add helper predicates and constructors so later slices do not hand-build these events.
- Update `docs/SESSIONS.md` with the new optional metadata fields and backwards compatibility rule.

Verification:

- Focused session schema tests.
- Existing TUI render tests still pass without child events.
- `pnpm check`.

Completed:

- Added runtime subagent lifecycle event types, factories, and a subagent-event predicate.
- Added optional session-tree metadata fields with backwards-compatible defaults for old metadata.
- Added durable subagent lifecycle payload schemas and payload constructors.
- Kept current TUI/session rehydration behavior neutral for child events until later rendering slices.
- Updated session docs with metadata fields and compatibility rules.

Verified:

- `pnpm test -- test/session.test.ts test/tui.render.test.ts`
- `pnpm typecheck`
- `pnpm check`
- `mise run local-ci`

## Slice 2: Refactor Runtime To A First-Class Event Stream

Status: [x] Done

Goal:

Make streaming the runtime's primary execution contract while keeping the existing `submitMessage(...)` behavior available to callers.

Implementation:

- Add a stream-oriented runtime method such as `submitMessageStream(...)` or `runTurn(...)` that returns an `AsyncIterable<AgentRuntimeEvent>`.
- Rebuild `submitMessage(...)` as a thin collector over the stream API.
- Replace ad hoc callback emission with one internal event sink that writes to:
  - the stream consumer
  - the session appender
  - optional compatibility callbacks
- Preserve existing single-agent loop behavior and tool execution order.
- Add abort-signal support through the stream path if it is not already complete.
- Update TUI shell consumption to use the stream API directly or keep the callback adapter only as a temporary compatibility layer.
- Update `docs/ARCHITECTURE.md` to describe runtime as a command/event stream boundary.

Verification:

- Fake-model runtime tests prove old `submitMessage(...)` results match streamed events.
- Abort tests prove no orphaned pending stream remains after cancellation.
- Existing CLI and TUI tests pass.
- `pnpm check`.

Completed:

- Added `submitMessageStream(...)` as the primary async runtime event stream.
- Rebuilt `submitMessage(...)` as a collector over the stream path with callback compatibility.
- Updated the TUI chat submission path to consume streamed events directly.
- Updated non-interactive `topchester run` prompt execution to persist and print streamed events as they arrive.
- Documented the runtime boundary as a typed event stream in `docs/ARCHITECTURE.md`.

Verified:

- `pnpm test -- test/commands.test.ts test/tui.render.test.ts test/cli.integration.test.ts`
- `pnpm typecheck`
- `pnpm check`
- `mise run local-ci`

## Slice 3: Add Child Session Persistence

Status: [x] Done

Goal:

Persist child sessions as first-class sessions linked to their parent, before adding an actual subagent tool.

Implementation:

- Add session-store APIs for creating child sessions:
  - parent session id
  - root session id
  - parent tool call id
  - agent profile id
  - title
- Add APIs to list child sessions for a parent and load a session tree.
- Record child lifecycle references in the parent event stream.
- Ensure child event JSONL files use the same append-only rules as parent sessions.
- Keep parent and child session logs separate so replay remains simple.
- Update session docs with examples of parent and child metadata.

Verification:

- Unit tests create a parent session, create children, append child events, and reload the tree.
- Backwards compatibility test loads an old metadata object with no parent fields.
- `pnpm check`.

Completed:

- Added `createChildSession(...)` with child metadata and parent `subagent_started` event recording.
- Added `listChildSessions(...)` and `loadSessionTree(...)` for direct-child and recursive tree loading.
- Kept parent and child logs separate while preserving root session inheritance across nested children.
- Updated session docs with child-session persistence behavior.

Verified:

- `pnpm test -- test/session.test.ts`
- `pnpm typecheck`
- `pnpm check`
- `mise run local-ci`

## Slice 4: Add Agent Profiles And Tool Permission Filtering

Status: [ ] Not started

Goal:

Define what kinds of agents can run and which tools each profile may use, so subagents are constrained before they can execute.

Implementation:

- Add `AgentProfile` definitions for the primary agent and initial subagent profiles.
- Include profile fields for:
  - id
  - display name
  - mode: `primary`, `subagent`, or `all`
  - prompt additions
  - model slot or model override
  - allowed tools
  - denied tools
  - permission defaults
- Extend `ToolContext` with a permission view and profile information.
- Filter the tool registry per profile before prompt generation and tool execution.
- Enforce permissions at execution time, not only in prompts.
- Make recursive task execution denied by default for subagents unless explicitly enabled later.
- Document how profile permissions compose with project/user configuration.

Verification:

- Unit tests prove denied tools are absent from prompts and rejected at execution.
- Unit tests prove child profiles inherit parent denies.
- Existing tool tests pass under the primary profile.
- `pnpm check`.

## Slice 5: Add `task`/`subagent` Tool Backed By `SubagentManager`

Status: [ ] Not started

Goal:

Add the first real subagent execution path: a parent model can call `task`, the runtime creates a child session, streams child events, and returns a bounded child result to the parent model.

Implementation:

- Add `SubagentManager` as a runtime service, not as TUI state.
- Add a `task` tool with inputs similar to:
  - `description`
  - `prompt`
  - `subagent_type`
  - optional `task_id`
- Inject `SubagentManager` and event sink into `ToolContext`.
- When `task` runs:
  - resolve the requested agent profile
  - create a child session
  - emit `subagent_started`
  - run the child runtime with fresh context
  - forward child events as `subagent_event`
  - emit `subagent_completed` or `subagent_failed`
  - return a model-visible tool result containing child session id, status, and final response
- Keep child context fresh. The parent prompt should not be dumped into child context except for the task prompt, workspace/KB context, and configured profile prompt.
- Render child events in the TUI as nested task blocks.
- Update tool prompt docs so the model knows when to use `task`.

Verification:

- Fake-model test proves parent receives a single task result with child output.
- Runtime event test proves child events stream before final parent completion.
- TUI render test covers running, completed, and failed child task states.
- `pnpm check`.

## Slice 6: Add Parallel Execution For `task` Only

Status: [ ] Not started

Goal:

Allow independent task calls from one parent model step to run concurrently while preserving deterministic model-visible results.

Implementation:

- Add a small scheduler in the runtime loop.
- If a model step returns multiple tool calls and every call is `task`, run them concurrently.
- Stream child events in real completion/update order.
- Append model-visible task results back into the parent conversation in assistant source order.
- Add concurrency limits with a conservative default.
- Propagate parent cancellation to all running child tasks.
- Make failures local to the failed task unless cancellation or policy says the whole step must stop.
- If text-JSON model output cannot represent multiple task calls cleanly, add a temporary `task_batch` compatibility path or defer parallel task calls to native multi-tool model responses.

Verification:

- Fake-model test with two child tasks proves both start before either completes.
- Ordering test proves parent model receives results in source order.
- Failure test proves one failed task is represented cleanly.
- Cancellation test proves all running children stop.
- `pnpm check`.

## Slice 7: Expand To General Multi-Tool Parallelism

Status: [ ] Not started

Goal:

Generalize the scheduler beyond `task` after the event stream, session tree, and permission model are stable.

Implementation:

- Add per-tool scheduling metadata:
  - `parallelSafe`
  - `mutatesWorkspace`
  - `requiresExclusiveWorkspace`
  - optional resource keys such as file paths, shell process, or git state
- Default unknown tools to sequential.
- Allow read-only tools to run in parallel when their resource keys do not conflict.
- Keep write tools sequential until specific conflict rules exist.
- Add tool execution lifecycle events compatible with streaming updates:
  - execution started
  - execution update
  - execution completed
  - execution failed
- Preserve source-order insertion for model-visible tool results.
- Add docs for tool authors explaining how to mark execution mode safely.

Verification:

- Scheduler unit tests for read/read, read/write, write/write, and unknown-tool cases.
- Existing tool behavior remains unchanged when tools are not marked parallel-safe.
- TUI tests cover interleaved tool progress.
- `pnpm check`.

## Open Questions

- Should child sessions be visible in the default session list, or only when expanding a parent session?
- Should the first child profiles be read-only by default, with write-capable subagents introduced later?
- Should child tasks get a separate scratchpad/task-plan event stream, or should they reuse the existing task plan events inside their child session only?
- What should the default child concurrency limit be for local alpha: 2, 3, or config-driven?
- Should the `task` tool be named only `task`, only `subagent`, or should `subagent` be an alias for user-facing clarity?

## Next Slice

Start with Slice 1. It creates the type and persistence surface area needed by every later slice, but it does not change runtime behavior. That makes it the right first PR before the event-stream refactor.
