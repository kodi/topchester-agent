# Queued and Steering Messages V0 Plan

## Summary

Add V0 support for user messages submitted while the interactive TUI is already running an agent turn.

The target behavior is:

- ordinary busy-time submissions become queued follow-up prompts that run after the current turn completes
- `/queue <prompt>` explicitly queues a next-turn prompt
- `/steer <prompt>` best-effort injects guidance into the active turn at a safe checkpoint, falling back to the next-turn queue when it cannot be consumed

This plan exists because the feature crosses prompt editing, busy-state rendering, session persistence, slash-command routing, runtime tool-loop prompts, and regression coverage.

## Competitor Notes

Local competitor checkouts inspected on 2026-06-04:

- OpenCode has a serial prompt queue for interactive mode. Prompts submitted behind an active ordinary turn remain queued locally and are exposed for removal before they start.
- Codex separates queued follow-up user messages from pending steering messages. It drains one queued message after a turn becomes idle, while pending steers can be delivered during active work.
- Hermes exposes the clearest user contract with `busy_input_mode` values `queue`, `steer`, and `interrupt`; `/queue` becomes next-turn input and `/steer` injects into the next tool-result checkpoint.
- Pi exposes the same distinction through `sendUserMessage(..., { deliverAs: "steer" })` and `sendUserMessage(..., { deliverAs: "followUp" })`.

## Decisions

- V0 should default to queue-only for normal busy-time Enter submissions.
- A queued prompt is not persisted as a user message until it actually starts a turn.
- Queued prompts drain one at a time after the current turn returns to ready.
- Do not batch several queued prompts into one user message.
- Keep queued input TUI-local in V0. Do not persist queued drafts across process restarts.
- Keep queue state out of `TopchesterAgentRuntime` for V0. The runtime remains a single-turn stream API.
- Add `/queue <prompt>` as an explicit command that queues a next-turn prompt in the TUI.
- Add `/steer <prompt>` as best-effort active-turn guidance, not as a normal queued user turn when it is consumed.
- If steering is not consumed before the active turn completes, queue it as the next user turn so the user text is not lost.
- Do not add configurable `busy_input_mode` in V0. That can come after the queue and steer contracts are proven.
- Do not implement queued-message menus, removal, editing, or persistence in V0.
- Do not make non-interactive `topchester run` accept queued busy input. Non-interactive `/queue` and `/steer` should return interactive-only messages.
- If the user switches sessions with `/new`, `/fork`, or `/restore`, clear TUI-local queued prompts and pending steering with a visible notice. Do not carry queued input across sessions in V0.
- Queueing and steering must not bypass active approval modals. Modal input keeps priority over prompt input, and normal text, `/queue`, and `/steer` should wait until the modal is resolved.

## Scope

Included:

- TUI prompt submission while an agent turn is busy.
- TUI-local queued follow-up storage and draining.
- Visible compact pending queue status.
- `/queue <prompt>` and `/steer <prompt>` slash-command suggestions and TUI handling.
- Runtime option for pending steering text and safe injection after tool-result checkpoints.
- Fallback from unconsumed steering text to queued follow-up.
- Focused tests for queueing, draining, rendering, slash commands, and steering injection.
- Docs updates for the TUI behavior and commands.

Out of scope for V0:

- Persisting queued drafts in session files.
- Editing or deleting queued prompts.
- A queued prompt picker or management modal.
- Configurable busy input modes.
- Steering during startup agent checks or long slash commands.
- Steering into bash approval modals.
- Cross-session queued input.
- Subagent-specific steering.
- Web, app-server, or ACP protocol support.

## Current State

Relevant Topchester behavior:

- `src/tui/busy.ts` sets a `promptHint` while the agent is busy. This replaces the editor with text such as `press Esc to stop`.
- `src/tui/layout.ts` blocks prompt edit, paste, newline, and submit handlers when `promptHint` is set.
- `src/tui/layout.ts` currently appends a user chat row immediately inside `submitPromptValue()` before calling the shell-level submit handler.
- `src/tui/shell.ts` starts chat turns by calling `submitChatMessage()` from the `setSubmitMessage()` callback.
- `submitChatMessage()` persists the user message before calling `runtime.submitMessageStream()`.
- `TopchesterAgentRuntime.submitMessageStream()` owns exactly one model/tool loop and returns `status("ready")` when the turn completes, is stopped, or fails.
- Topchester already has a small pending-input precedent: skill activations without an inline instruction are queued and applied to the next normal user message.

## Recommended Approach

Keep two layers:

```text
TUI shell queue
  - owns next-turn queued prompts
  - decides whether a submitted prompt starts now or waits
  - persists user messages only when a queued prompt starts

Runtime steering slot
  - receives user steering text while one turn is active
  - appends steering to the next continuation prompt after a tool result
  - exposes unconsumed steering so the TUI can queue it as a follow-up
```

This keeps the normal runtime contract stable and lets the queue behavior ship before steering gets more sophisticated.

## Data Flow

Normal idle prompt:

```text
Enter
  -> ChatLayout submits prompt
  -> TopchesterTuiShell sees no chat turn running
  -> submitChatMessage()
  -> persist user message
  -> runtime.submitMessageStream()
```

Busy-time queued prompt:

```text
Enter while chatRunning
  -> ChatLayout submits prompt without appending a real user row
  -> TopchesterTuiShell pushes text into queuedChatMessages
  -> TUI renders queued count
  -> current submitChatMessage() completes
  -> shell drains exactly one queued prompt through submitChatMessage()
```

Busy-time steer:

```text
/steer <prompt> while chatRunning
  -> shell appends text to pendingSteeringBuffer
  -> runtime consumes steering after the next tool result
  -> continuation prompt includes steering guidance
  -> if turn completes before consumption, shell queues the text as a follow-up
```

## Runtime Steering Shape

Add a minimal object passed through `AgentRuntimeSubmitMessageOptions`, for example:

```ts
export interface RuntimeSteeringBuffer {
  drain(): string | undefined;
  hasPending(): boolean;
}
```

The TUI owns the mutable buffer instance for the active turn. The runtime receives only a drain-capable view and calls `drain()` after tool results are available and before it builds the next `nextPrompt`. After the stream exits, the shell checks the same buffer for unconsumed text and queues any remainder as a follow-up.

Preferred V0 injection wording:

```text
User steering received while this turn was running:
<text>

Continue the user's original request, applying this steering if it is still relevant.
```

Important constraints:

- Only drain after a tool result has been emitted or there is another model prompt to send.
- Do not inject steer text into the persisted conversation as a visible user row when consumed.
- If multiple steering prompts arrive before a drain, join them with blank lines in arrival order.
- If steering is still pending when the turn exits, return it to the TUI so it can become a queued follow-up.

## TUI Queue Shape

Add shell-owned state:

```ts
private chatRunning = false;
private queuedChatMessages: string[] = [];
private activeSteeringBuffer: RuntimeSteeringBuffer | undefined;
```

`ChatLayout` should support a submit result or submit mode that lets the shell prevent an immediate visible user row when the prompt is only queued. One likely shape:

```ts
type SubmitMessageResult = "submitted" | "queued" | void;
setSubmitMessage((message) => SubmitMessageResult);
```

Then `submitPromptValue()` can:

- expand pasted content
- clear the editor
- call the submit handler
- append `userMessage(message)` only when the handler did not return `"queued"`

Alternatively, split the current `submitPromptValue()` into "take draft" and "append visible user row" helpers so the shell can decide. Prefer the smallest change that keeps existing tests readable.

## UI Behavior

- While busy, keep the editor active instead of replacing it with only `press Esc to stop`.
- Preserve Esc as the abort key.
- Render a compact pending queue line in the thread/status area, for example `queued: 1 follow-up`.
- Keep the busy spinner/activity line.
- Do not show queued prompts as normal user transcript messages until they start.
- After a queued prompt starts, it should look exactly like a normal user message and persist exactly like one.
- Empty prompts should not queue.
- Slash suggestions may remain available while busy, but only `/queue` and `/steer` should have special busy behavior in V0.

## Files To Change

Likely changes:

- `src/tui/layout.ts`
- `src/tui/shell.ts`
- `src/tui/busy.ts`
- `src/tui/status.ts` if queue count belongs in the footer
- `src/agent/commands.ts`
- `src/agent/runtime/index.ts`
- `src/agent/runtime/format.ts` if steering prompt text is factored there
- `docs/tui.md`
- `docs/cli.md` if slash-command docs are shared there
- `test/tui.render.test.ts`
- `test/commands.test.ts`

Possible new files:

- `src/agent/runtime/steering.ts`
- `test/runtime-steering.test.ts` or a focused block in `test/commands.test.ts`

## Cross-Slice Rules

- The repo must pass targeted tests after every slice.
- Do not persist queued input before it starts a real turn.
- Do not append consumed steering text as a normal user row.
- Do not make the runtime responsible for draining next-turn queued prompts.
- Keep one active chat turn at a time.
- Preserve existing Esc abort behavior.
- Preserve approval modal behavior; queued input should not answer approval prompts.
- Add regression tests that normal text, `/queue`, and `/steer` do not bypass an active approval modal.
- Clear TUI-local queued prompts and pending steering on `/new`, `/fork`, and `/restore`, with a visible notice.
- Avoid changing session event schemas unless a later slice proves it is necessary.

## Edge Cases

- User queues several prompts while one turn is running.
- User presses Esc after queueing one or more prompts.
- User queues a prompt and the current turn fails.
- User queues a prompt and exits before it drains.
- User enters `/queue` while idle.
- User enters `/queue` while busy.
- User enters `/steer` while idle.
- User enters `/steer` while busy but the model returns a final answer before another tool result.
- User enters several `/steer` commands before the runtime checkpoint.
- User pastes a large prompt while busy.
- User enters `/new`, `/fork`, or `/restore` while a queued prompt exists.
- Bash approval modal is active when the user types normal text.
- Startup agent check is busy but no chat turn exists.

## Testing Plan

Per-slice checks should stay focused. The final pass should run:

```sh
pnpm test
pnpm run check
```

If that is too slow during implementation, at minimum run:

```sh
pnpm exec vitest test/tui.render.test.ts test/commands.test.ts
pnpm run check
```

Record the exact commands and results in this plan as slices are completed.

## Slices

### Slice 1: Queue-Aware TUI Submission Contract

Status: `[x]` Complete

Goal: Let the shell decide whether a submitted prompt is visible immediately or queued for later.

Why here: The current layout appends a user row before the shell can inspect busy state, which would persist queued prompts too early.

This slice should implement:

- Adjust `ChatLayout.setSubmitMessage()` to allow a queue-aware result.
- Move immediate user-row append behind the submit-handler result.
- Keep idle prompt behavior unchanged.
- Keep prompt history and large-paste expansion behavior unchanged.
- Add tests that an idle prompt still appends and submits normally.
- Add tests that a handler returning `"queued"` clears the draft without appending a user row.

Expected output:

- `ChatLayout` can submit a prompt without creating a transcript row.
- Existing normal submission tests still pass.

Verification:

```sh
pnpm exec vitest test/tui.render.test.ts
```

Dependencies: none.

### Slice 2: TUI Follow-Up Queue and Drain

Status: `[x]` Complete

Goal: Queue normal prompts submitted during an active chat turn and drain them after the current turn completes.

Why here: Queue-only support is the lowest-risk product value and does not require runtime steering changes.

This slice should implement:

- Add `chatRunning` and `queuedChatMessages` to `TopchesterTuiShell`.
- When a normal prompt arrives while `chatRunning`, enqueue it and return `"queued"` to `ChatLayout`.
- Render compact queue status.
- After `submitChatMessage()` finishes, if the session is still valid and not exiting, start exactly one queued prompt.
- Repeat draining one prompt at a time.
- Decide and encode behavior for failures: preferred V0 is to continue draining only if the current turn ends with ready, not when it leaves `chat failed`.
- Clear queued prompts on `/new`, `/fork`, and `/restore`, and show a short visible notice when anything was dropped.
- Add tests for order preservation and no premature persistence.

Expected output:

- Users can type a follow-up while the agent is working.
- The follow-up starts as a normal user turn after the active turn completes.

Verification:

```sh
pnpm exec vitest test/tui.render.test.ts
```

Dependencies: Slice 1.

### Slice 3: Busy Editor UX

Status: `[x]` Complete

Goal: Keep the prompt editor usable while a chat turn is busy without losing Esc abort behavior.

Why here: Queueing works only if the busy UI no longer replaces the prompt with an inert hint.

This slice should implement:

- Change `BusyIndicator` or its options so chat turns can keep the editor visible.
- Preserve `press Esc to stop` as a hint in a status or notice line rather than as `promptHint`.
- Keep existing startup check and long slash-command busy hints unchanged unless queueing is deliberately supported there.
- Ensure prompt edit, paste, newline, and submit handlers work while chat is busy.
- Add render tests for busy editor plus queued count.

Expected output:

- During chat turns, the user sees spinner/activity plus an editable prompt.
- Esc still aborts the active turn.

Verification:

```sh
pnpm exec vitest test/tui.render.test.ts test/tui.prompt-history.test.ts
```

Dependencies: Slice 2.

### Slice 4: `/queue` Command

Status: `[x]` Complete

Goal: Add an explicit command for next-turn follow-up queueing.

Why here: `/queue` gives users a precise escape hatch and matches competitor behavior without the complexity of steering.

This slice should implement:

- Add `/queue <prompt>` and `/q <prompt>` suggestions if aliases are wanted.
- In the TUI, when idle, `/queue <prompt>` should start like a normal prompt or queue then immediately drain. Pick the simpler behavior and document it.
- In the TUI, when busy, `/queue <prompt>` should enqueue the prompt without appending a visible slash-command row.
- In non-interactive command dispatch, return an interactive-only message.
- Add command and TUI tests.

Expected output:

- `/queue` works in the TUI and does not pollute model context with a visible-only slash row.

Verification:

```sh
pnpm exec vitest test/commands.test.ts test/tui.render.test.ts
```

Dependencies: Slice 2.

### Slice 5: Runtime Steering Buffer

Status: `[x]` Complete

Goal: Add a runtime option that can consume steering text at safe model-loop checkpoints.

Why here: Steering requires runtime support, but it should build on the already-stable queue behavior for fallback.

This slice should implement:

- Add a small steering buffer interface or helper.
- Pass the buffer through `AgentRuntimeSubmitMessageOptions`.
- After each tool result is formatted and before the next model prompt, drain steering text and append a steering instruction to `nextPrompt`.
- Cover single-tool, parallel-tool, and task-tool result paths if they each build continuation prompts separately.
- Treat only continuation-prompt paths as steering injection sites. Do not inject into terminal paths that immediately return `assistantMessage`, `choice`, `status("ready")`, or error/failure output.
- Add an implementation checklist with the exact `submitMessageStream()` continuation sites changed, so future edits do not miss one model-loop path or accidentally alter a terminal path.
- Do not inject steering before the first model call.
- Do not consume steering if the current turn will return without another model prompt.
- Add focused runtime tests proving steering text reaches the next model prompt after a tool result.

Expected output:

- `/steer` can affect an active tool loop without creating a separate user turn.

Implementation checklist:

- Single-tool continuation path appends drained steering after `formatToolResultForPrompt(toolResult)` and `formatContinuationInstruction(...)`.
- Parallel safe-tool continuation path appends drained steering after the joined parallel tool results and continuation instruction.
- Multi-`task` continuation path appends drained steering after the joined task results and continuation instruction.
- Terminal paths that return assistant messages, choices, ready status, stopped hooks, approval cancellation, or failed output do not drain steering.
- The initial model prompt is built before any steering drain can occur.

Verification:

```sh
pnpm exec vitest test/commands.test.ts
```

Dependencies: Slice 2.

### Slice 6: `/steer` TUI Command and Fallback

Status: `[x]` Complete

Goal: Wire `/steer <prompt>` to active-turn steering and queue unconsumed text after completion.

Why here: The command should only ship after runtime steering has a tested consumption point.

This slice should implement:

- Add `/steer <prompt>` suggestion and TUI handling.
- If idle, treat `/steer <prompt>` as a normal user prompt or show a clear "nothing running" message. Preferred V0 is normal prompt, matching Pi and Hermes idle fallback.
- If busy, push text into the active steering buffer and show a compact notice.
- If active steering remains pending when `submitChatMessage()` exits, move it into `queuedChatMessages`.
- If Esc aborts the turn, drop pending steering or restore it to the prompt. Preferred V0 is to restore/drop visibly, not silently run it.
- Clear pending steering on `/new`, `/fork`, and `/restore`, with the same visible dropped-input notice used for queued follow-ups.
- Add tests for consumed steer and fallback-to-queue.

Expected output:

- Users can steer active tool loops and never lose unconsumed steering text.

Verification:

```sh
pnpm exec vitest test/commands.test.ts test/tui.render.test.ts
```

Dependencies: Slice 5.

### Slice 7: Docs and Final Verification

Status: `[x]` Complete

Goal: Document the V0 user contract and run the broader repo checks.

Why here: Queue/steer behavior is user-facing and should be discoverable from the TUI docs.

This slice should implement:

- Update TUI slash-command docs with `/queue` and `/steer`.
- Document busy-time Enter behavior.
- State that queued prompts are TUI-local and not persisted until they start.
- State V0 limitations: no queued prompt management, no persisted queue, no configurable busy mode.
- Run final verification and record the results in this plan.

Expected output:

- Docs match shipped behavior.
- The plan has completed statuses and verification notes.

Verification:

```sh
pnpm test
pnpm run check
```

Dependencies: Slices 1 through 6.

## Open Questions

- Should idle `/queue <prompt>` run immediately or always enqueue then drain? Preferred V0: run immediately because the observable result is the same and avoids queue state churn.
- Should idle `/steer <prompt>` run immediately or warn that nothing is running? Preferred V0: run immediately, matching competitor fallback behavior.
- Should queued prompts continue draining after a turn fails with `chat failed`? Preferred V0: stop draining on failure so the user can inspect before more work starts.
- Where should the queue count render: thread notice line, status line, or prompt border? Preferred V0: thread notice line because it avoids widening the status format.

## Progress Log

- 2026-06-04: Plan created. No implementation started.
- 2026-06-04: Slice 1 complete. `pnpm exec vitest test/tui.render.test.ts` passed, then `mise run local-ci` failed on pre-existing `docs/reference/changelog.md` formatting. Ran `pnpm run format`; reran `mise run local-ci` and it passed.
- 2026-06-04: Slice 2 complete. `pnpm exec vitest test/tui.render.test.ts` passed. First `mise run local-ci` surfaced one lint warning in a new test; fixed it and reran `mise run local-ci`, which passed with 0 warnings.
- 2026-06-04: Slice 3 complete. `pnpm exec vitest test/tui.render.test.ts test/tui.prompt-history.test.ts` passed, then `mise run local-ci` passed.
- 2026-06-04: Slice 4 complete. `pnpm exec vitest test/commands.test.ts test/tui.render.test.ts` passed, then `mise run local-ci` passed.
- 2026-06-04: Slice 5 complete. `pnpm exec vitest test/commands.test.ts` passed. First `mise run local-ci` failed on formatting in `src/agent/runtime/index.ts`; ran `pnpm run format` and reran `mise run local-ci`, which passed.
- 2026-06-04: Slice 6 complete. `pnpm exec vitest test/commands.test.ts test/tui.render.test.ts` passed, then `mise run local-ci` passed.
- 2026-06-04: Slice 7 complete. Docs and this plan were updated; `mise run local-ci` passed. Final verification: `pnpm test` initially found one stale docs assertion, which was updated; rerun `pnpm test` passed. `pnpm run check` initially found formatting in `test/cli.integration.test.ts`, which was fixed with `pnpm run format`; rerun `pnpm run check` passed. Completion audit added explicit modal-priority coverage for normal text, `/queue`, and `/steer`; final `pnpm test` passed with 28 files and 635 tests, final `pnpm run check` passed, and final `mise run local-ci` passed on the completed worktree.
