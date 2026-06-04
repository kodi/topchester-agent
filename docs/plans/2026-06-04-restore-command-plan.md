# Restore Command Implementation Plan

## Summary

Add a Topchester `/restore` command that opens a full-screen session picker in the interactive TUI. The picker should replace the chat transcript area, keep the prompt area visible, and list previous project-local user sessions as one-line rows with a date and a truncated first user prompt. Selecting a row switches the active TUI session to that saved session using the same rehydrate path as `--resume`.

This plan exists because `/restore` crosses session listing, transcript summarization, TUI input routing, full-screen picker rendering, active session replacement, docs, and regression coverage. `/fork` already works; `/restore` should reuse its session-switching discipline without copying any events.

## Decisions

- `/restore` is interactive-only in V0.
- The command opens a full-screen picker in the thread area instead of appending a chat modal message.
- The prompt box and status line remain visible while the picker is open.
- The picker lists project-local top-level user sessions only. Exclude `source: "subagent"` child sessions from the default list.
- Exclude the current active session from the selectable previous-session list in V0. If every valid session is the current session, show an empty state.
- Sort sessions by `metadata.updatedAt` descending, with `sessionId` as a deterministic tie-breaker.
- Display date from `updatedAt` because `/restore` is about returning to recently active work.
- Display each row as a single line: formatted date, short session id, truncated first user prompt.
- The first prompt should be the first persisted user message that is not a visible-only slash command.
- If a session has no normal user prompt, display a stable placeholder such as `(no user prompt)`.
- Selecting a session switches the current TUI to that session and appends future events to the restored session log.
- Canceling the picker leaves the active session, transcript, task plan, prompt draft, and pending skill activations unchanged.
- Do not create a new session, fork a session, mutate the source session, or write a `/restore` command row when the picker opens.
- After a successful restore, add one visible system notice to the restored session so the user can see which session is active.
- Keep CLI saved-session restore as the existing `topchester --resume <session-id>` path. Do not add a `topchester restore` CLI subcommand in V0.

## Scope

Included:

- Session-store helper to list restorable project-local session summaries.
- First user prompt extraction from existing session events.
- `/restore` slash-command suggestion and shared dispatcher behavior.
- TUI full-screen picker state that replaces the transcript area while keeping the prompt area visible.
- TUI session switch that rehydrates the selected session and appends future messages to it.
- Tests for session listing, row truncation, picker navigation/cancel, active session switching, and model-context preservation.
- Docs for `/restore` in the TUI and sessions docs.

Out of scope for V0:

- Searching or filtering sessions.
- Renaming sessions.
- Deleting, archiving, pinning, or grouping sessions.
- Showing child/subagent sessions in the default picker.
- Cross-workspace session restore.
- Previewing the full transcript before selecting.
- Restoring from malformed sessions.
- A non-interactive `topchester restore` command.
- A saved-session picker for `topchester fork`.

## Current State

Topchester sessions are project-local under `.agents/topchester/sessions/<session-id>/` with `metadata.json` and `events.jsonl`.

Relevant existing behavior:

- `src/session/store.ts` has `loadSession()`, `loadSessionForAppend()`, `resolveLatestSessionId()`, `forkSession()`, `listChildSessions()`, and `rehydrateSession()`.
- `resolveLatestSessionId()` already scans session folders and sorts by `updatedAt`, but it returns only one ID and fails on malformed metadata.
- `loadSession()` validates workspace, metadata consistency, event consistency, and exact UUIDv7 session IDs.
- `rehydrateSession()` reconstructs visible chat messages, filters visible-only slash command rows out of model context, restores task-plan state, and ignores internal status/knowledge/subagent lifecycle rows as appropriate.
- `/fork` is already implemented in `src/tui/shell.ts` as a control command that switches `this.session`, rehydrates messages, clears transient TUI state, and causes future appends to go to the new fork.
- `src/agent/commands.ts` already includes `/fork` and `/new` in slash suggestions and returns interactive-only messages for commands that are TUI-only in non-interactive runs.
- `src/tui/layout.ts` currently has inline chat modal support by rendering a `kind: "modal"` message inside the transcript and replacing the prompt footer with modal help. That does not satisfy `/restore`, because `/restore` must keep the prompt visible and replace the whole chat area.
- `docs/features/sessions.md`, `docs/cli.md`, and `docs/tui.md` are the likely docs surfaces for restore behavior.

## Recommended Approach

Implement `/restore` as a session-picker overlay, not as a transcript modal message:

```text
/restore submitted
  -> listSessionSummaries(workspaceRoot, { excludeSessionId: activeSessionId })
  -> ChatLayout enters session picker mode
  -> thread area renders picker rows instead of transcript
  -> prompt area remains visible
  -> Enter on selected row
  -> loadSessionForAppend(workspaceRoot, selectedSessionId)
  -> loadSession(workspaceRoot, selectedSessionId)
  -> rehydrateSession(events)
  -> set active SessionHandle
  -> reset transcript/task plan/status from rehydrated session
  -> append one restored-session notice to selected session only
```

This keeps data discovery testable in `src/session/store.ts` and keeps terminal interaction local to `src/tui/layout.ts` and `src/tui/shell.ts`.

## Session Summary Contract

Add a small public summary type near the other session store APIs:

```ts
export interface SessionSummary {
  sessionId: string;
  updatedAt: string;
  createdAt: string;
  firstUserPrompt?: string;
  title?: string;
  forkedFromSessionId?: string;
}

export interface ListSessionSummariesOptions {
  excludeSessionId?: string;
  includeSubagents?: boolean;
  limit?: number;
}

export async function listSessionSummaries(
  workspaceRoot: string,
  options: ListSessionSummariesOptions = {}
): Promise<SessionSummary[]>;
```

Implementation notes:

- Scan `getTopchesterSessionsPath(workspaceRoot)` for valid UUIDv7 folder names.
- Read metadata first and validate workspace consistency.
- Skip `source: "subagent"` unless `includeSubagents` is true.
- Skip `options.excludeSessionId` when provided.
- Load only enough events to find the first non-visible-only user message. A simple full `readEvents()` pass is acceptable for V0 if tests cover malformed and empty logs; optimize later if real session volume makes this slow.
- Ignore user messages with `meta.source === "slash_command"` and `meta.visibleOnly === true`.
- Return valid summaries sorted newest first by `updatedAt`, then `sessionId`.
- Decide whether one malformed session should fail the whole picker or be skipped with a warning before implementation. Preferred V0 behavior is to skip malformed sessions and return a skipped count only if the UI needs to surface it.

## TUI Picker Behavior

Add a layout-level picker mode with explicit state, for example:

```ts
interface SessionPickerItem {
  sessionId: string;
  updatedAt: string;
  firstUserPrompt?: string;
}

interface SessionPickerState {
  items: SessionPickerItem[];
  selectedIndex: number;
  scrollOffset: number;
  skippedCount?: number;
}
```

Expected interaction:

- `/restore` opens picker mode.
- `Esc` closes picker mode and restores the normal transcript.
- `Up` and `Down` move the selected row.
- Page Up, Page Down, Home, and End are nice-to-have but can be added in the same UI slice if small.
- `Enter` selects the active row and calls back into `TopchesterTuiShell`.
- Mouse wheel may scroll the picker if the existing terminal parser supports it cleanly.
- Normal prompt typing should not modify the prompt while the picker is open, except `Esc` and selection keys. The prompt remains visible as context and to satisfy layout continuity.
- If there are no restorable sessions, render an empty state and let `Esc` close it.

Rendering rules:

- Replace the whole transcript/thread area with the picker.
- Keep the prompt box, task-plan area, and status line rendered as they are today unless implementation proves the pinned task plan crowds the picker. If crowding is real, hide only the pinned task plan while picker mode is open.
- Each session row must fit on one terminal line.
- Truncate the first prompt to the available row width after reserving space for date and short session ID.
- Use a compact date such as `2026-06-04 12:34` or `Jun 04 12:34`; pick one and keep tests stable.
- Show the selected row with the existing user-selection styling or a simple `>` marker.
- Use only ASCII in the picker labels unless the surrounding TUI convention already requires a glyph.

## Restore Switch Behavior

Add restore handling next to `/new` and `/fork` in `src/tui/shell.ts`:

- Detect `/restore` before generic slash-command persistence.
- Require an active TUI session; if missing, show a visible command failure.
- If an agent turn or command is running, reject or delay opening the picker. Preferred V0 behavior is to reject with a short system message.
- Call `listSessionSummaries()` with the active session ID excluded.
- Open the picker without persisting `/restore` to the current session.
- On selection, load the selected session through `loadSessionForAppend()` and `loadSession()`.
- Rehydrate the selected session with `rehydrateSession()`.
- Set `this.session` to the selected session handle.
- Reset `sessionStartedAt` and clear pending skill activations.
- Clear task-plan notice timers and transient picker state.
- Reset app messages to the rehydrated transcript and set the restored task plan/status.
- Append one system notice to the selected session, such as `Restored session 019e9029.`
- Future user prompts, runtime events, slash command events, and exit banner should reference the restored session ID.

Do not mutate the session that opened `/restore` unless it is also the selected restored session, which V0 avoids by excluding the active session.

## Files To Change

Likely changes:

- `src/session/store.ts`
- `src/agent/commands.ts`
- `src/tui/shell-helpers.ts`
- `src/tui/shell.ts`
- `src/tui/layout.ts`
- `src/tui/messages.ts` only if shared truncation/render helpers need to move
- `docs/features/sessions.md`
- `docs/tui.md`
- `test/session.test.ts`
- `test/commands.test.ts`
- `test/tui.render.test.ts`
- `test/tui.prompt-history.test.ts` only if picker input routing can conflict with prompt history

## Cross-Slice Rules

- Do not change existing `--resume` behavior while adding `/restore`.
- Do not fork or copy sessions during restore.
- Do not persist `/restore` as a visible-only command row just for opening the picker.
- Do not include subagent child sessions in the default picker.
- Keep all session IO workspace-local.
- Keep old sessions readable.
- Keep first-prompt extraction separate from TUI rendering so it can be tested without terminal snapshots.
- Reuse the existing `rehydrateSession()` path instead of inventing another transcript reconstruction path.
- Keep row rendering width-aware and single-line at narrow terminal widths.

## Edge Cases

- No sessions directory exists.
- Only the current session exists.
- Session has no user messages.
- Session starts with visible-only slash command messages before the first real user prompt.
- First user prompt is multiline.
- First user prompt is very long.
- Session metadata has equal `updatedAt` values.
- A subagent child session has a recent `updatedAt`; it should not appear by default.
- Session was forked; it should appear as a normal user session.
- Session metadata is malformed.
- Session event log is malformed.
- Selected session is deleted between listing and selection.
- Selected session fails rehydrate/load.
- User cancels picker with an existing prompt draft visible.
- User exits immediately after restore; exit banner should mention the restored session ID.
- Terminal is narrow enough that date, short ID, and prompt compete for space.

## Testing Plan

Per-slice tests should be focused. Final verification should include:

```bash
pnpm test -- test/session.test.ts test/commands.test.ts test/tui.render.test.ts test/tui.prompt-history.test.ts
pnpm check
```

Manual TUI check after implementation:

1. Start a workspace with at least three sessions.
2. Run `/restore`.
3. Confirm the thread area is replaced by a session list and the prompt remains visible.
4. Confirm each row shows date plus one-line truncated first prompt.
5. Press `Esc` and verify the current transcript is unchanged.
6. Run `/restore` again, select another session, submit a new prompt, then exit.
7. Confirm the exit banner and session log use the restored session ID.

## Slices

### Slice 1: Session Summary Listing

Status: `[x]` Done

Goal: Add a reusable session-summary helper that returns restorable user sessions with first-prompt text.

Why here: The picker should be a thin UI over a tested session-store contract.

This slice should implement:

- Add `SessionSummary`, `ListSessionSummariesOptions`, and `listSessionSummaries()`.
- Scan project-local session folders.
- Validate metadata workspace consistency.
- Exclude active session by option.
- Exclude subagent sessions by default.
- Extract the first non-visible-only user prompt from events.
- Sort newest first by `updatedAt`, then `sessionId`.
- Add focused tests for sorting, filtering, first-prompt extraction, empty sessions, and malformed sessions.

Expected output:

- Storage tests can list restorable sessions without involving the TUI.
- The summary object contains all display data the picker needs.

Verification:

```bash
pnpm test -- test/session.test.ts
```

Completed in this slice:

- Added `SessionSummary`, `ListSessionSummariesOptions`, and `listSessionSummaries()` in `src/session/store.ts`.
- Summary listing now scans project-local UUIDv7 session folders, validates workspace metadata, skips malformed sessions, excludes active/subagent sessions by default, extracts the first non-visible-only slash-command user prompt, and sorts by `updatedAt` descending with `sessionId` as the tie-breaker.
- Added session-store tests for sorting, active/subagent filtering, fork metadata, empty sessions, first-prompt extraction, limits, missing storage, and malformed session skipping.

Verification record:

- 2026-06-04: `pnpm test -- test/session.test.ts` passed. Note: the repo test script ran the full Vitest suite for this command, reporting 25 files and 586 tests passed.
- 2026-06-04: `mise run local-ci` passed.

Dependencies:

- None.

### Slice 2: Slash Surface Contract

Status: `[x]` Done

Goal: Add `/restore` to the shared slash command surface without opening the TUI picker yet.

Why here: This locks command naming, suggestion text, and non-interactive behavior separately from terminal UI state.

This slice should implement:

- Add `/restore` to `slashCommandSuggestions`.
- Add a `restore` slash command to `src/agent/commands.ts`.
- Return an interactive-only message from non-interactive dispatch, similar to `/new` and `/fork`.
- Add `/restore` to unknown-command helper text if the helper remains short.
- Add parser/dispatcher tests.

Expected output:

- Typing `/restore` appears in slash suggestions.
- `topchester run "/restore"` reports that restore is available in the interactive TUI and does not mutate sessions.

Verification:

```bash
pnpm test -- test/commands.test.ts
```

Completed in this slice:

- Added `/restore` to `slashCommandSuggestions`.
- Added a `restore` slash command in `src/agent/commands.ts`.
- Non-interactive dispatch now reports that `/restore` opens a previous-session picker in the interactive TUI.
- Updated unknown-command helper text and command-surface tests.

Verification record:

- 2026-06-04: `pnpm test -- test/commands.test.ts` passed. Note: the repo test script ran the full Vitest suite for this command, reporting 25 files and 587 tests passed.
- 2026-06-04: `mise run local-ci` passed.

Dependencies:

- None.

### Slice 3: Full-Screen Picker Layout

Status: `[x]` Done

Goal: Add a layout-level session picker mode that replaces the transcript area while keeping the prompt footer visible.

Why here: The visual and input contract is the highest-risk part and should be proven before wiring real session switching.

This slice should implement:

- Add picker state to `ChatLayout`.
- Render picker rows instead of `renderThread()` output when picker mode is active.
- Keep `renderPrompt()` as the footer while picker mode is active.
- Add keyboard handling for Up, Down, Enter, and Esc.
- Add a callback or event hook so `TopchesterTuiShell` can respond to selected session IDs.
- Preserve prompt draft text across picker open/cancel.
- Add render tests for normal rows, narrow-width truncation, empty state, selection movement, cancel behavior, and prompt visibility.

Expected output:

- Tests can open a picker with fake session summaries and verify the transcript is hidden.
- The prompt remains visible while the picker is active.
- Rows remain one line at narrow widths.

Verification:

```bash
pnpm test -- test/tui.render.test.ts test/tui.prompt-history.test.ts
```

Completed in this slice:

- Added `SessionPickerItem` and picker state to `ChatLayout`.
- Added public picker methods for handlers, open, close, and state inspection.
- Picker mode replaces the transcript area, keeps the normal prompt footer visible, suppresses slash suggestions while open, and consumes picker input before modal, scroll, prompt-history, or prompt-edit handlers.
- Added picker rendering for normal rows, empty state, deterministic compact updated-at text, one-line prompt normalization/truncation, keyboard navigation, selection callback, and cancel callback.
- Added prompt-history/input-routing coverage proving picker mode preserves the visible draft and blocks prompt edits while open.

Implementation decision:

- Picker row dates use deterministic `YYYY-MM-DD HH:mm` text derived from the persisted `updatedAt` string instead of environment-local timezone formatting. This keeps render tests stable across machines while still displaying the session's updated timestamp compactly.

Verification record:

- 2026-06-04: `pnpm test -- test/tui.render.test.ts test/tui.prompt-history.test.ts` passed. Note: the repo test script ran the full Vitest suite for this command, reporting 25 files and 592 tests passed.
- 2026-06-04: `mise run local-ci` passed.

Dependencies:

- Slice 1 for real item shape, though fake items are enough for most layout tests.

### Slice 4: Restore Command Wiring

Status: `[x]` Done

Goal: Wire `/restore` to open the picker and switch the active TUI session when the user selects a session.

Why here: This combines the already-tested storage summary and picker layout with the existing session rehydrate path.

This slice should implement:

- Add `isRestoreSessionCommand()` in `src/tui/shell-helpers.ts`.
- Handle `/restore` in `TopchesterTuiShell.submitSlashCommand()` before generic slash persistence.
- Call `listSessionSummaries()` and open the picker.
- On selection, load selected session for append, rehydrate events, reset app messages/task plan/status, and set `this.session`.
- Append a restore notice to the restored session only.
- Handle load failures after selection with a visible system message and keep the original active session.
- Add integration-style TUI tests proving future appends go to the restored session and the old session is not mutated by opening/canceling the picker.

Expected output:

- `/restore` opens the full-screen picker.
- Selecting a session switches active session state.
- Future prompts and exit banner use the restored session ID.

Verification:

```bash
pnpm test -- test/tui.render.test.ts test/session.test.ts
```

Completed in this slice:

- Added `isRestoreSessionCommand()` in `src/tui/shell-helpers.ts`.
- Added `/restore` handling in `TopchesterTuiShell.submitSlashCommand()` before generic slash-command persistence.
- Opening `/restore` now removes the just-submitted visible command row, lists project-local restorable summaries with the active session excluded, and opens the session picker without mutating the current session log.
- Selecting a session loads it for append, rehydrates it through the existing `rehydrateSession()` path, switches `this.session`, resets app messages/task plan/status, clears pending skill activations, and appends one restored-session system notice to the restored session.
- Selection failures close the picker, show a visible failure, and keep the original active session for future appends.
- Added integration-style TUI tests for open/cancel without mutation, successful restore with future appends and exit banner pointing to the restored session, and deleted-target failure preserving the active session.

Verification record:

- 2026-06-04: `pnpm test -- test/tui.render.test.ts test/session.test.ts` passed. Note: the repo test script ran the full Vitest suite for this command, reporting 25 files and 595 tests passed.
- 2026-06-04: `mise run local-ci` passed.

Dependencies:

- Slice 1.
- Slice 3.

### Slice 5: Docs And Final Verification

Status: `[x]` Done

Goal: Document `/restore` behavior and run the broader confidence pass.

Why here: Users need to understand the difference between `/restore`, `--resume`, and `/fork`, and the final slice should catch cross-module drift.

This slice should implement:

- Update `docs/tui.md` with `/restore` picker behavior and controls.
- Update `docs/features/sessions.md` with `/restore` and the relationship to `--resume`.
- Update `docs/cli.md` only if slash-command documentation there mentions interactive-only commands.
- Record any implementation decisions that changed this plan.

Expected output:

- Docs describe the interactive restore picker, row contents, cancel behavior, and session-switching behavior.
- Final checks pass.

Verification:

```bash
pnpm test -- test/session.test.ts test/commands.test.ts test/tui.render.test.ts test/tui.prompt-history.test.ts
pnpm check
```

Completed in this slice:

- Updated `docs/tui.md` with `/restore` controls, picker row contents, cancel behavior, and session-switching behavior.
- Updated `docs/features/sessions.md` with `/restore` behavior and its relationship to `--resume` and `/fork`.
- Updated `docs/cli.md` to note that `/restore` is the interactive TUI picker path and that `topchester run "/restore"` is TUI-only.
- Updated `docs/reference/cli.md` to clarify that bare `topchester fork` is waiting for a fork-specific saved-session picker.
- Added CLI docs assertions for `/restore` documentation.

Verification record:

- 2026-06-04: `pnpm test -- test/session.test.ts test/commands.test.ts test/tui.render.test.ts test/tui.prompt-history.test.ts` passed. Note: the repo test script ran the full Vitest suite for this command, reporting 25 files and 595 tests passed.
- 2026-06-04: `pnpm check` passed.
- 2026-06-04: `mise run local-ci` passed.
- 2026-06-04: Final `mise run local-ci` rerun passed after updating this plan record.

Dependencies:

- Slices 1-4.

## Open Questions

1. Should malformed session folders be skipped in the picker with a warning, or should one malformed session fail `/restore` entirely?
   - 2026-06-04 decision: skip malformed sessions for the picker. Strict `loadSession()` and `--resume` behavior remains unchanged.
2. Should the active session be excluded, or included with a disabled/current marker?
   - 2026-06-04 decision: exclude the active session in V0.
3. Should date display use local time or raw ISO-like UTC text? The recommended V0 choice is local compact time for readability, but tests need a deterministic formatter seam.
   - 2026-06-04 decision: use deterministic `YYYY-MM-DD HH:mm` text from persisted `updatedAt` for V0 picker rows.
4. Should the picker support typing to filter in V0, or remain keyboard-selection only?
   - 2026-06-04 decision: keep V0 keyboard-selection only.
5. Should first prompt extraction treat a restored-session notice as a system row only, never as a title source? The recommended answer is yes.
   - 2026-06-04 decision: yes. First-prompt extraction only considers normal user messages and skips visible-only slash-command user messages.

## Progress Log

- 2026-06-04: Plan created after inspecting the completed `/fork` plan and implementation, session store primitives, TUI layout/modal behavior, and session/TUI docs.
- 2026-06-04: Completed Slice 1 session summary listing and verified with `pnpm test -- test/session.test.ts` plus `mise run local-ci`.
- 2026-06-04: Completed Slice 2 slash command surface and verified with `pnpm test -- test/commands.test.ts` plus `mise run local-ci`.
- 2026-06-04: Completed Slice 3 full-screen picker layout and verified with `pnpm test -- test/tui.render.test.ts test/tui.prompt-history.test.ts` plus `mise run local-ci`.
- 2026-06-04: Completed Slice 4 restore command wiring and verified with `pnpm test -- test/tui.render.test.ts test/session.test.ts` plus `mise run local-ci`.
- 2026-06-04: Completed Slice 5 docs and final verification with `pnpm test -- test/session.test.ts test/commands.test.ts test/tui.render.test.ts test/tui.prompt-history.test.ts`, `pnpm check`, and `mise run local-ci`.
