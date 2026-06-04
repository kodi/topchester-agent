# Fork Command Implementation Plan

## Summary

Add a Topchester `/fork` command that clones the active conversation into a new project-local session with a fresh session ID, switches the interactive TUI to that fork, and leaves the source transcript untouched.

This plan exists because `/fork` crosses storage, resume hydration, TUI state reset, slash-command dispatch, docs, and eventually CLI saved-session selection. The implementation should be sliced so the repo stays usable after each checkpoint.

## Reference Behavior

Codex CLI behavior checked on 2026-06-04:

- OpenAI docs describe `/fork` as cloning the current conversation into a new thread with a fresh ID, leaving the original transcript untouched so the user can explore a parallel approach.
- The same docs say `codex fork` opens a saved-session picker when the user wants to fork a saved session instead of the current one.
- The local Codex checkout at `/Users/kodi/data/github/codex` confirms the CLI shape: `codex fork` opens a picker, `codex fork --last` forks the latest saved session, and `codex fork <session-id>` targets a specific saved session.
- Codex models forked history as forked initial history, not as a child/subagent session. It keeps lineage separately from the active thread identity.

Reference URL:

- https://developers.openai.com/codex/cli/slash-commands#fork-the-current-conversation-with-fork

## Decisions

- Topchester `/fork` should fork the active TUI session only in V0.
- The forked session is a normal top-level user session, not a subagent child session.
- The forked session gets a fresh UUIDv7 `sessionId` and `rootSessionId` equal to the new session ID.
- The source session is not mutated when `/fork` succeeds. Do not persist `/fork` as a visible-only command in the source transcript.
- The forked transcript starts from the source session's persisted events. Existing event IDs and event timestamps may be copied as-is; new events append after the copied `lastEventId`.
- Metadata should record fork lineage with optional fields such as `forkedFromSessionId` and `forkedFromRootSessionId`.
- `/fork` should not copy child/subagent session directories in V0. Parent lifecycle references already persisted in the copied transcript can remain historical transcript rows, but the fork should not claim ownership of those child session logs.
- The TUI should switch to the new session immediately after a successful fork, clear the terminal like `/new`, render the cloned transcript, and print the new session ID in the exit banner.
- The TUI should add one system message after forking so the user can see that they are now in a forked session.
- Non-interactive `topchester run "/fork"` should return an interactive-only message until the CLI saved-session fork slice is implemented.
- Saved-session forking through a `topchester fork` CLI subcommand is useful but should come after the active-session `/fork` path is solid.
- Partial forks from an earlier message boundary are too expensive for this implementation and should not be built now. Revisit only after users ask for that workflow.
- Fork metadata should stay ID-only until Topchester has a real session naming feature. Do not add a generated title such as `Fork of <short-id>`.

## Scope

Included:

- Session-store helper to fork/copy one project-local session.
- Metadata lineage fields and validation.
- `/fork` slash-command suggestion and shared dispatcher behavior.
- TUI handling that switches from the current session to the forked session.
- Tests for storage, TUI switching, dispatcher behavior, and model-context preservation.
- Docs for `/fork` and any CLI fork behavior that ships.

Out of scope for V0:

- Forking a session from another workspace.
- Copying child/subagent session folders.
- Side conversations or ephemeral forks.
- Mid-turn forking while the agent is streaming.
- Forking only part of a transcript.
- Partial forks from an earlier message boundary.
- A saved-session picker UI.
- Archiving or naming forks.

## Current State

Topchester has project-local sessions under `.agents/topchester/sessions/`:

- `src/session/store.ts` creates UUIDv7 sessions, loads exact IDs or `latest`, resolves the newest session, creates subagent child sessions, validates event consistency, and rehydrates persisted events into TUI messages.
- `src/session/events.ts` stores metadata with `sessionId`, `rootSessionId`, optional `parentSessionId`, optional `parentToolCallId`, `source`, optional title/profile fields, workspace root, timestamps, and `lastEventId`.
- `source` currently accepts only `"user"` and `"subagent"`.
- `rehydrateSession()` filters visible-only slash command rows out of future model context and restores task-plan UI state.
- The TUI startup path uses `--resume <session>` by loading the session, rehydrating events, and passing `initialMessages` plus `initialTaskPlan` into `TopchesterTuiShell`.
- `/new` is handled directly in `src/tui/shell.ts`. It creates a new session, clears terminal state, persists startup rows into the new session, and avoids persisting `/new` into the new transcript.
- Other slash commands are persisted as visible-only user messages through `slashCommandToSessionPayload()`.
- `src/agent/commands.ts` is the shared slash-command dispatcher for non-interactive runs and runtime command execution. It currently returns explanatory text for `/new`.

## Recommended Approach

Implement a session-store fork primitive and keep TUI behavior as a thin consumer of that primitive:

```text
active TUI session handle
  -> forkSession(workspaceRoot, activeSessionId)
  -> new metadata with fresh sessionId/rootSessionId and fork lineage
  -> copied source events.jsonl
  -> load/rehydrate forked session
  -> TUI reset to cloned transcript
  -> subsequent user prompts append to fork only
```

This keeps the correctness-critical copy operation testable without terminal UI, and it lets a later `topchester fork` subcommand reuse the same storage function.

## Storage Contract

Add a helper near the other session primitives, likely:

```ts
export interface ForkSessionOptions {
  title?: string;
}

export async function forkSession(
  workspaceRoot: string,
  sourceSessionIdOrLatest: string,
  options: ForkSessionOptions = {}
): Promise<SessionHandle>;
```

Implementation notes:

- Load the source through `loadSession()` so the same workspace, ID, metadata, and event consistency checks apply.
- Generate a fresh session ID and folder under `getTopchesterSessionsPath(workspaceRoot)`.
- Create metadata with `source: "user"`, `rootSessionId` set to the new ID, `workspaceRoot`, `createdAt` and `updatedAt` set to the fork time, `lastEventId` copied from the source metadata, and lineage fields copied from the source.
- Copy the source `events.jsonl` exactly after successful validation. Do not append a synthetic `/fork` message to the copied transcript.
- If the source has zero events, create an empty events file and `lastEventId: 0`.
- Use exclusive file creation where practical so a collision cannot silently overwrite a session.
- Return a `SessionHandle` for the forked session.

Lineage metadata should be optional so older sessions continue to load:

```ts
forkedFromSessionId?: string;
forkedFromRootSessionId?: string;
```

Do not overload `parentSessionId`; that field already means subagent parentage.

## TUI Behavior

Add `/fork` as a TUI control command next to `/new`:

- Detect it before generic slash-command persistence.
- Require an active `this.session`; if missing, show a clear command failure.
- If an agent turn is currently running, reject the command with a short visible system message. V0 should only fork from an idle committed transcript.
- Call `forkSession(this.context.workspaceRoot, this.session.sessionId)`.
- Load and rehydrate the forked session, then set `this.session` to the fork handle.
- Clear transient task-plan notices and pending skill activations.
- Reset the app to the cloned messages and restored task plan.
- Clear the terminal like `/new`.
- Request render and run the normal lightweight readiness/project-instruction checks only if they are already part of the reset path and do not duplicate startup rows.

The source session must not receive any new event on successful `/fork`. After the switch, all future messages, tool calls, statuses, and exit banner references should point to the new session ID.

## CLI Shape

Ship this only after active-session `/fork` works:

```text
topchester fork
topchester fork --last
topchester fork <session-id>
```

Suggested V1 behavior:

- `topchester fork` can initially fail with a clear message if no picker exists yet, or it can alias `--last` if a product decision prefers low implementation cost.
- `topchester fork --last` forks `resolveLatestSessionId(workspaceRoot)`.
- `topchester fork <session-id>` forks that exact project-local saved session.
- After forking, open the interactive TUI on the forked session using the same rehydrate path as `--resume`.
- Missing, malformed, cross-workspace, or invalid source sessions should use the same startup error formatting as `--resume`.

Do not block the TUI `/fork` slice on a saved-session picker.

## Files To Change

Likely changes:

- `src/session/events.ts`
- `src/session/store.ts`
- `src/agent/commands.ts`
- `src/tui/shell.ts`
- `src/tui/layout.ts` only if slash suggestions or reset rendering need adjustment
- `src/cli.ts` for the later `topchester fork` subcommand
- `docs/cli.md`
- `docs/tui.md` if slash-command docs live there for the TUI
- `test/session.test.ts`
- `test/commands.test.ts`
- `test/tui.render.test.ts`

## Cross-Slice Rules

- Keep `/fork` separate from subagent child sessions.
- Do not mutate the source session on successful fork.
- Do not add copied visible-only command rows to future model context.
- Do not silently fork mid-turn partial state.
- Keep session IDs exact lowercase UUIDv7 strings.
- Keep all session IO workspace-local.
- Preserve old session readability by making metadata additions optional.
- Prefer the existing resume/rehydrate path over a second transcript reconstruction path.

## Edge Cases

- Source session has no events.
- Source session has copied visible-only slash command rows.
- Source session has a task plan event; the fork should restore the latest visible task plan.
- Source session has tool-call events with diffs.
- Source session has hook status events.
- Source session has subagent lifecycle events.
- Source metadata has a stale `updatedAt`; fork should still become the latest session because fork metadata is new.
- Source session is malformed; fork should fail before creating or should clean up the partial destination.
- The generated destination UUID collides with an existing folder.
- `/fork` is submitted while an agent turn, command, modal approval, or overlay is active.
- User exits immediately after forking; the exit banner should mention the forked session ID.

## Slices

### Slice 1: Session Fork Primitive

Status: `[x]` Completed

Goal: Add a reusable, tested storage helper that clones one validated project-local session into a new top-level session.

Why here: All later UI and CLI behavior depends on a correct copy primitive.

This slice should implement:

- Add optional fork lineage fields to `sessionMetadataBaseSchema`.
- Add `forkSession()` to `src/session/store.ts`.
- Load and validate the source session before writing the fork.
- Write fresh metadata and a copied `events.jsonl`.
- Return a `SessionHandle` for appending to the fork.
- Keep the source session unchanged.

Expected output:

- A forked session folder exists with a fresh UUIDv7 folder name.
- Metadata identifies the fork as a user session and records fork lineage.
- Event content matches the source transcript.
- Appending to the fork increments from the copied `lastEventId`.

Verification:

```bash
pnpm test -- test/session.test.ts
```

Dependencies:

- None.

### Slice 2: Slash Registry And Non-Interactive Contract

Status: `[x]` Completed

Goal: Make `/fork` visible and explicit in the shared slash-command surface without changing TUI switching yet.

Why here: It locks the product contract and avoids unknown-command behavior while the TUI implementation is still isolated.

This slice should implement:

- Add `/fork` to `slashCommandSuggestions`.
- Add a built-in `fork` slash command in `src/agent/commands.ts`.
- Return an interactive-only message from the shared dispatcher, similar to `/new`, until CLI saved-session forking ships.
- Update unknown-command helper text if needed so `/fork` appears in useful hints.
- Add command parser/dispatcher tests.

Expected output:

- `/fork` appears in slash suggestions.
- `topchester run "/fork"` does not try to fork a session; it returns a clear TUI-only message.

Verification:

```bash
pnpm test -- test/commands.test.ts
```

Dependencies:

- Slice 1 is not strictly required, but complete it first so the command name does not get ahead of the actual storage design.

### Slice 3: Active TUI Session Fork

Status: `[x]` Completed

Goal: Wire `/fork` in the TUI so the active session is cloned and the UI switches to the forked transcript.

Why here: This is the user-facing MVP and should reuse the already-tested storage primitive.

This slice should implement:

- Add `isForkSessionCommand()` or an equivalent local predicate near the existing `/new` handling.
- Handle `/fork` before generic slash-command persistence.
- Call `forkSession()` with the current active session ID.
- Rehydrate the forked events and reset the app to the cloned transcript and task plan.
- Append one system message in the forked session, for example `Forked session from <source-short-id>.`
- Clear prompt overlays, pending skill activations, transient task-plan notice timers, and any command busy state.
- Set `this.session` and `this.sessionStartedAt` to the fork.
- Ensure the terminal is cleared and the exit banner points at the fork.
- Preserve source session events exactly.

Expected output:

- Typing `/fork` in the TUI clones the current transcript into a new session and switches to that new session.
- The visible transcript keeps the cloned history and ends with one system notice that identifies the fork.
- Subsequent prompts append only to the fork.

Verification:

```bash
pnpm test -- test/tui.render.test.ts test/session.test.ts
```

Dependencies:

- Slice 1.
- Slice 2.

### Slice 4: Runtime Context And Resume Safety

Status: `[x]` Completed

Goal: Prove the forked transcript feeds the runtime the same model-visible context as resume, without leaking visible-only command rows or task-plan internals.

Why here: A fork that looks right in the UI but changes model context would be hard to catch manually.

This slice should implement:

- Add a focused test that creates a source session with normal user/assistant rows, visible-only slash commands, tool rows, task-plan events, and status rows.
- Fork it.
- Resume/submit a prompt against the forked session.
- Assert that only normal model-context messages enter the primary model prompt, matching current resume expectations.
- Assert source and fork diverge only after the fork receives a new prompt.

Expected output:

- Forked sessions preserve resume model-context filtering.
- The source session remains an immutable snapshot after `/fork`.

Verification:

```bash
pnpm test -- test/tui.render.test.ts test/session.test.ts
```

Dependencies:

- Slice 3.

### Slice 5: Saved-Session CLI Fork

Status: `[x]` Completed

Goal: Add a non-slash CLI path for forking saved project-local sessions.

Why here: Codex exposes `codex fork` for saved sessions, but Topchester can ship active `/fork` first and reuse the storage helper later.

This slice should implement:

- Add `topchester fork <session-id>` and `topchester fork --last`.
- Decide whether bare `topchester fork` should show a message, alias `--last`, or wait for a future picker.
- Open the interactive TUI on the forked session using the same `loadSession` + `rehydrateSession` path as `--resume`.
- Share startup error formatting with `--resume`.
- Add focused CLI tests if the repo has a CLI harness for command parsing/startup.

Expected output:

- A user can fork a saved session without first resuming it.
- The newly opened TUI points at the forked session ID.

Verification:

```bash
pnpm test -- test/session.test.ts test/commands.test.ts
```

Add any existing CLI-focused test command if one is present when this slice is implemented.

Dependencies:

- Slice 1.
- Prefer after Slice 3 so storage semantics are already proven from the main user path.

### Slice 6: Docs And Final Check

Status: `[x]` Completed

Goal: Document the shipped behavior and run the repo-level confidence gate.

Why here: Users should know the difference between `/new`, `--resume`, `/fork`, and later `topchester fork`.

This slice should implement:

- Update `docs/cli.md` with `/fork` behavior.
- Update `docs/tui.md` if it owns slash-command interaction details.
- Document that `/fork` clones the current active session, leaves the source untouched, and does not copy child session logs in V0.
- Document the saved-session CLI fork only if Slice 5 ships.
- Record any final implementation decisions back into this plan.

Expected output:

- Docs describe exactly what shipped.
- The plan reflects completed slices and any behavior changes discovered during implementation.

Verification:

```bash
pnpm check
```

Dependencies:

- Slices 1 through 4 for the TUI MVP.
- Slice 5 only if saved-session CLI fork is implemented in the same batch.

## Final Verification

Run the narrow tests first while implementing:

```bash
pnpm test -- test/session.test.ts test/commands.test.ts test/tui.render.test.ts
```

Then run the repo gate:

```bash
pnpm check
```

Manual TUI smoke after implementation:

1. Start `topchester` in a test repo.
2. Submit one normal prompt or use a seeded fake model path.
3. Type `/fork`.
4. Confirm the transcript remains visible, the source session log is unchanged, and the exit banner prints the forked session ID.
5. Submit a new prompt after the fork.
6. Confirm only the fork receives the new events and `topchester --resume <source>` still opens the pre-fork transcript.

## Open Questions

- Should bare `topchester fork` wait for a real saved-session picker, or should it alias `--last` until a picker exists?
  - 2026-06-04 decision: bare `topchester fork` exits with a clear message until a saved-session picker exists. Use `topchester fork --last` for the newest saved session or `topchester fork <session-id>` for an exact session.
- Should `SessionStart` hooks receive an `isForked` flag in a later hooks-contract slice, or is `isResumed: true` enough for fork startup?
  - 2026-06-04 implementation note: saved-session CLI forks open through the existing resume hydration path. No new hook flag shipped in this slice.

## Implementation Notes

- 2026-06-04: Implemented `forkSession()` with optional metadata lineage fields, validated source loading, exact JSONL copy, fresh top-level UUIDv7 session identity, and append continuation from the copied `lastEventId`.
- 2026-06-04: Added `/fork` to slash suggestions and the shared dispatcher. Non-interactive `topchester run "/fork"` returns an interactive-TUI message.
- 2026-06-04: Added active TUI `/fork` handling. It clones the current session, switches the shell to the fork, restores the rehydrated transcript and task plan, clears transient UI state, and appends one fork notice to the fork only.
- 2026-06-04: Added runtime-context tests proving forked resume filtering matches existing resume behavior and that source sessions remain unchanged after forked prompts append.
- 2026-06-04: Added `topchester fork --last` and `topchester fork <session-id>`. Bare `topchester fork` is intentionally a clear failure until a picker ships.
