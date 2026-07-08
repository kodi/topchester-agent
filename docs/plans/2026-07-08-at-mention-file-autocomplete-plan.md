# @-Mention File Path Autocomplete Plan

## Summary

Give the interactive TUI the same `@file-path` affordance competitors have (Claude Code, Cursor CLI, Codex CLI): typing `@` followed by part of a path opens a fuzzy suggestion popup over workspace files and folders, arrow keys choose, `Tab`/`Enter` completes the workspace-relative path into the prompt at the cursor. The completed mention stays literal text in the submitted message; the model is taught via the system prompt that `@<workspace-relative-path>` refers to a real workspace file it should read with its existing tools.

This plan exists because prompt composition is currently path-blind: users must type exact paths by hand or ask the agent to find files, which wastes a turn.

## Decisions

- **Composition-only in V0.** Completing a mention inserts plain text like `@src/tui/layout.ts `. No file content is inlined into the model prompt. The agent already has `read_file`, `list_files`, `find_file`, and `grep`; a system prompt line tells it to treat `@path` mentions as workspace paths and read them when relevant. This avoids blowing context on large files and keeps the KB-centric flow intact (no bypass of the knowledge path — the agent still reads through tools).
- **Reuse `find_file` machinery, don't write a second walker.** File collection and fuzzy scoring live in `src/agent/tools/find-file.ts` (`collectWorkspaceFiles` via rg/fd/find with a Node fallback, `scoreFileMatch`, shared `ignoredDirectories`). The mention feature consumes exported versions of these rather than duplicating them.
- **`ChatLayout` stays IO-free.** The layout renders synchronously and does no filesystem work today. Mention suggestions come from a provider object injected through `ChatLayoutOptions`: the provider owns an async cached file index and exposes a synchronous `getSuggestions(query)` over the cache, kicking off a background refresh that calls `requestRender()` when fresh results land.
- **Mention trigger requires a boundary.** A mention token starts at an `@` that is at the start of the prompt or preceded by whitespace, and runs to the next whitespace. This keeps email addresses and mid-word `@` from opening the popup.
- **Directories complete with a trailing `/` and keep the popup open** so the user can drill into subfolders, matching competitor behavior. Files complete with a trailing space and close the popup.
- **Suggestions are workspace-relative paths only.** Absolute paths and paths outside the workspace are never suggested; the provider indexes from `workspaceRoot` down, honoring the shared ignore list.

## Scope

Covered:

- Mention token detection and completion insertion at any cursor position, including multi-line prompts.
- A cached workspace file index provider for the TUI with TTL-based refresh.
- Popup UI + key handling in `ChatLayout`, visually consistent with the slash suggestion box.
- Wiring in `TopchesterTuiShell`, one system prompt line, docs, and changelog.

Out of scope (explicitly):

- Inlining mentioned file contents into the model prompt (recorded as an open question).
- Mentions in `topchester run` / non-interactive mode.
- Quoting or escaping for paths containing spaces (V0 suggestions will include such paths but completion inserts them unquoted; noted below).
- Mentioning symbols, folders outside the workspace, or KB entries.

## Current State

- Slash suggestions are the only autocomplete: pure `getSlashCommandSuggestions(input)` in `src/agent/commands.ts`, rendered by `renderSlashSuggestions` and driven by `handleSlashSuggestionInput` in `src/tui/layout.ts`. Completion replaces the entire prompt value — unusable for mid-text mentions, but the popup rendering (`getVisibleSuggestionWindowStart`, box drawing, ↑↓/Tab handling) is the pattern to generalize.
- `src/agent/tools/find-file.ts` has everything needed for lookup: native collectors (rg → fd → find → Node walk), `ignoredDirectories`, and `scoreFileMatch` fuzzy scoring. None of the internals are exported yet.
- `handleInput` in `ChatLayout` dispatches in a fixed order (session picker → modal → cancel → slash suggestions → paste → newline → submit → scroll → vertical cursor → history → edit). Mention handling must slot in after slash suggestions and before paste/submit so `Tab`/`Enter`/`↑↓` are intercepted while the popup is open.
- Prompt history browsing uses ↑↓ (`handlePromptHistoryInput`); slash suggestions already steal ↑↓ when visible, and mentions must do the same to avoid fighting history.
- Render tests construct `ChatLayout` directly with a `FakeTerminal` (`test/tui.render.test.ts`), which works because the layout needs no filesystem — the provider injection must preserve that.

## Behavior To Preserve

- Slash command suggestions, prompt history, paste handling, and multi-line cursor movement behave exactly as today when no mention token is active.
- `ChatLayout` constructed without a mention provider (existing tests, static rendering path) behaves exactly as today.
- Submitted message text is whatever the user composed — no rewriting of mentions at submit time.

## Implementation Shape

New module `src/tui/file-mentions.ts` (pure logic):

- `findActiveMention(value: string, cursor: number): { start: number; end: number; query: string } | undefined` — boundary-aware token detection around the cursor.
- `applyMentionCompletion(value, mention, path, isDirectory): { value: string; cursor: number }` — replaces `@query` with `@path/` (directory) or `@path ` (file), returns new cursor position.

New module `src/tui/file-mention-provider.ts`:

- `createFileMentionProvider({ workspaceRoot, logger?, onUpdate? })` returning an object with `getSuggestions(query, limit): FileMentionSuggestion[]` (synchronous, over cached index, scored with `scoreFileMatch`) and internal TTL-refresh (~10s) that triggers `onUpdate()` (wired to `requestRender`) when the index changes. Index includes directories as well as files, capped (~20k entries) to bound memory.
- Reuses `collectWorkspaceFiles` and `scoreFileMatch` from `find-file.ts` (exported in Slice 1).

`ChatLayout` changes:

- `ChatLayoutOptions` gains `mentionProvider?`. New `handleMentionSuggestionInput` slotted after `handleSlashSuggestionInput`. New `renderMentionSuggestions` sharing the box-drawing/window helpers with the slash popup (small extraction, not a rewrite). Popup shows when an active mention token exists under the cursor; `Esc` dismisses until the token changes.

Shell + prompt:

- `TopchesterTuiShell.render()` creates the provider with `context.workspaceRoot` and passes it into `ChatLayout`.
- `getChatSystemPrompt` gains one line (guarded by read-tool availability) explaining the `@path` convention.

## Cross-Slice Rules

- `ChatLayout` never touches the filesystem; all IO stays in the provider.
- Slash suggestion behavior is the black-box contract — `test/tui.render.test.ts` slash cases must pass unchanged in every slice.
- Repo checks run through mise tasks only (`mise run test`, `mise run lint`, `mise run typecheck`).
- Docs (`docs/features/tui.md`) and changelog land in the same change as the user-visible behavior (Slice 4), per repo policy.

## Slices

### Slice 1: Mention token parsing + shared lookup exports

Status: `[x]` Done

**Goal:** Pure, fully tested mention-token logic and exported reuse points in `find-file.ts`.

**Why here:** Everything else consumes these; they are testable without any TUI or IO.

This slice should implement:

- `src/tui/file-mentions.ts` with `findActiveMention` and `applyMentionCompletion` (multi-line values, cursor mid-token, `@` boundary rule, no-match cases).
- Export `scoreFileMatch` and `collectWorkspaceFiles` (and the `ignoredDirectories` set if needed) from `src/agent/tools/find-file.ts` without behavior change.
- `test/tui.file-mentions.test.ts` covering: `@` at prompt start, after whitespace, mid-word `@` ignored (email case), cursor inside vs. at end of token, completion of file vs. directory, cursor position after completion, multi-line prompts.

**Expected output:** New pure module + tests; `find-file.ts` diff is exports only.

**Verification:** `mise run test` and `mise run typecheck` pass; slash suggestion tests untouched.

**Dependencies:** None.

Completed in this slice:

- Added `src/tui/file-mentions.ts` with boundary-aware mention detection and completion insertion.
- Exported the existing `collectWorkspaceFiles`, `scoreFileMatch`, and shared ignore set from `src/agent/tools/find-file.ts`.
- Added `test/tui.file-mentions.test.ts` for start/whitespace mentions, email-style no-match, cursor-inside-token parsing, multi-line prompts, and file/directory completion.
- Added `topchester-kb` to the shared ignored directory set after PTY smoke showed generated KB cache paths in the popup.

Verification:

- `/Users/kodisha/.local/bin/mise exec -- pnpm test -- test/tui.file-mentions.test.ts` passed.
- `/Users/kodisha/.local/bin/mise exec -- pnpm typecheck` passed.

### Slice 2: Cached workspace file index provider

Status: `[x]` Done

**Goal:** An injectable provider with synchronous cached suggestions and async background refresh.

**Why here:** Isolates all IO and caching behind the interface Slice 3 consumes; provable with fixture directories before any UI exists.

This slice should implement:

- `src/tui/file-mention-provider.ts` as described in Implementation Shape: TTL cache, directory entries with an `isDirectory` flag, result limit parameter, `onUpdate` notification, in-flight refresh dedupe (never two concurrent walks), graceful empty results on walk failure.
- Scoring: reuse `scoreFileMatch`; empty query returns shallow entries first (top-level dirs/files) so bare `@` shows something useful immediately.
- Unit tests against a temp fixture tree: ignore list respected, fuzzy ranking sane (`layout` finds `src/tui/layout.ts` before deeper matches), directories flagged, cache serves synchronously after first refresh, `onUpdate` fires once per refresh with changes.

**Expected output:** Provider module + `test/tui.file-mention-provider.test.ts`.

**Verification:** `mise run test`; no `ChatLayout` changes yet.

**Dependencies:** Slice 1 (exports, scoring).

Completed in this slice:

- Added `src/tui/file-mention-provider.ts` with synchronous cached suggestions, TTL refresh, in-flight refresh dedupe, derived directory entries, result limits, and `onUpdate` notifications.
- Added `test/tui.file-mention-provider.test.ts` covering fixture indexing, shallow empty-query results, fuzzy ranking, ignored directories including `node_modules` and `topchester-kb`, cache reuse, and update notification behavior.

Verification:

- `/Users/kodisha/.local/bin/mise exec -- pnpm test -- test/tui.file-mention-provider.test.ts test/tui.file-mentions.test.ts` passed.
- `/Users/kodisha/.local/bin/mise exec -- pnpm typecheck` passed.

### Slice 3: ChatLayout popup UI and key handling

Status: `[x]` Done

**Goal:** The visible feature — popup renders while a mention token is active, ↑↓ choose, `Tab`/`Enter` complete at the cursor, `Esc` dismisses.

**Why here:** Consumes both prior slices; the largest-risk UI work happens once the contracts under it are hardened.

This slice should implement:

- `mentionProvider` in `ChatLayoutOptions`; layout stores latest suggestions per active query and re-queries on each render/input using `findActiveMention` against `promptValue`/`promptCursor`.
- `handleMentionSuggestionInput` after slash handling in `handleInput`: ↑↓ move selection (stealing from history, like slash does), `Tab` and `Enter` complete via `applyMentionCompletion` (directory completion keeps the popup open on the deeper query; file completion closes it; `Enter` submits only when no popup is open), `Esc` dismisses the popup for the current token without clearing the prompt (and still yields to `cancelPending`, which runs earlier in the dispatch order).
- `renderMentionSuggestions` above the prompt box, same box style and window-scrolling as slash suggestions (shared helper extraction), directories rendered with trailing `/`, footer hint `Tab complete · ↑↓ choose · Esc dismiss`.
- Mutual exclusion: slash popup wins when the prompt starts with `/` and matches slash suggestions; the mention popup can still open for `@` tokens typed inside a slash command's arguments when no slash suggestions are showing.
- Render/interaction tests in `test/tui.render.test.ts` with a fake synchronous provider: popup appears for `@lay`, completes to `@src/tui/layout.ts `, directory drill-down keeps popup open, Esc dismisses, Enter submits normally when popup closed, history ↑ still works with no active mention, existing slash tests unchanged.

**Expected output:** Working autocomplete inside `ChatLayout` behind an injected provider; no shell wiring yet.

**Verification:** `mise run test` (new render cases plus untouched slash cases) and `mise run lint`.

**Dependencies:** Slices 1 and 2.

Completed in this slice:

- Added optional `mentionProvider` support to `ChatLayoutOptions` while keeping layouts without a provider unchanged.
- Added mention popup rendering using the slash suggestion box style, with directory trailing slashes and `Tab complete · ↑↓ choose · Esc dismiss` footer.
- Added key handling after slash suggestions and before paste/submit: arrows select, `Tab`/`Enter` complete, directory completion keeps the popup active, file completion closes it, and `Esc` dismisses the current token.
- Added render/interaction coverage in `test/tui.render.test.ts` for popup display, file completion, directory drill-down, Esc dismissal, normal Enter submit without popup, and history arrows without active mentions.

Verification:

- `/Users/kodisha/.local/bin/mise exec -- pnpm test -- test/tui.render.test.ts test/tui.prompt-history.test.ts` passed.
- `/Users/kodisha/.local/bin/mise exec -- pnpm typecheck` passed.

### Slice 4: Shell wiring, system prompt line, docs

Status: `[x]` Done

**Goal:** Feature live in `topchester` TUI end to end, model aware of the convention, docs current.

**Why here:** Smallest slice last; it flips the feature on and satisfies the repo's docs-with-behavior rule.

This slice should implement:

- `TopchesterTuiShell.render()` (and `startNewSession`/restore paths if the layout is recreated there) constructs `createFileMentionProvider({ workspaceRoot: this.context.workspaceRoot })` with `onUpdate` wired to `tui.requestRender()`, passes it via `ChatLayoutOptions`.
- One line in `getChatSystemPrompt` (guarded by `canUseTool("read_file") || canUseTool("find_file")`): user-message tokens like `@src/file.ts` are workspace-relative paths the user picked deliberately; read or inspect them with tools when the request depends on them.
- Docs: add an "@-mention files" bullet/section to `docs/features/tui.md` Everyday controls (plain folk speak: "Type `@` plus part of a file name to search project files; Tab completes the path"), and a dated entry in `docs/reference/changelog.md`.
- Manual smoke: run the TUI in this repo, type `@shel`, confirm popup, complete, submit, confirm the agent reads the file.

**Expected output:** End-to-end feature; docs and changelog updated in the same change.

**Verification:** `mise run test`, `mise run lint`, `mise run typecheck`, plus the manual TUI smoke above. Record the exact commands here when they pass.

**Dependencies:** Slice 3.

Completed in this slice:

- Wired `createFileMentionProvider()` into `TopchesterTuiShell.render()` with `workspaceRoot`, logger, and `onUpdate` render requests.
- Added the `@src/file.ts` convention line to `getChatSystemPrompt()` when `read_file` or `find_file` is available.
- Updated `docs/features/tui.md`, `docs/reference/changelog.md`, and `test/tools.test.ts`.
- PTY smoke opened the real TUI, cancelled startup check, typed `@shel`, saw the `file mentions` popup select `@src/tui/shell.ts`, completed it with `Tab`, and exited without submitting an agent turn.

Verification:

- `/Users/kodisha/.local/bin/mise exec -- pnpm test` passed.
- `/Users/kodisha/.local/bin/mise run typecheck` passed.
- `/Users/kodisha/.local/bin/mise run lint` passed.
- `/Users/kodisha/.local/bin/mise run format-check` passed.
- `/Users/kodisha/.local/bin/mise run test` did not pass because the task runs unscoped `vitest run` and picked up mini-bench task/report workspaces outside `test/` with missing fixture dependencies and intentionally incomplete benchmark code. The product test script `pnpm test` scopes Vitest to `test/` and passed.

## Testing Plan

- Unit: token parsing/completion (Slice 1), provider caching/scoring/ignores (Slice 2) — pure and fixture-based, no TTY needed.
- Render/interaction: `ChatLayout` with `FakeTerminal` and a fake provider (Slice 3), following the existing slash suggestion test style.
- Contract guard: existing slash suggestion and prompt-history tests must pass unchanged in every slice.
- Manual: interactive TUI smoke in Slice 4 (autocomplete feel, no render flicker from background refresh, large-repo latency sanity).

## Files to Add

- `src/tui/file-mentions.ts`
- `src/tui/file-mention-provider.ts`
- `test/tui.file-mentions.test.ts`
- `test/tui.file-mention-provider.test.ts`

## Files to Change

- `src/agent/tools/find-file.ts` (exports only)
- `src/tui/layout.ts` (popup + key handling + options)
- `src/tui/shell.ts` (provider wiring)
- `src/agent/prompts.ts` (one convention line)
- `test/tui.render.test.ts` (new cases)
- `docs/features/tui.md`, `docs/reference/changelog.md`

## Open Questions

- **Content inlining:** should a follow-up expand small mentioned files directly into the model prompt (competitors attach content), or is tool-driven reading always enough? Deferred; if pursued, it becomes a new slice with a size cap and KB-flow review.
- **Paths with spaces:** V0 inserts them unquoted, which the model may misparse. If real-world friction shows up, add quoting (`@"path with spaces.md"`) as a follow-up slice `4.1`.
- **Hidden files:** the shared ignore list excludes `.git`, `.agents`, etc., but other dotfiles are included by the rg `--hidden` collector. Keep parity with `find_file` for now; revisit if the popup gets noisy.
- **Session picker / modal interplay:** popups already suppress the prompt footer; mention popup simply never shows in those states (provider still idles). Confirm no edge case during Slice 3 tests.

## Working Notes

- 2026-07-08: Implemented all four slices. PTY smoke initially showed `topchester-kb/l1-files/...` generated cache suggestions for `@shel`; added `topchester-kb` to the shared ignored directory set and verified the popup no longer lists those cache paths.
- 2026-07-08: `mise run test` currently differs from `pnpm test`; the mise task runs unscoped Vitest and traverses mini-bench workspaces/reports. Use `pnpm test` or adjust the mise task before treating `mise run test` as a product gate.

## Next Slice

All planned slices implemented. Follow-up candidates: quote paths with spaces, decide whether generated `jobs/` directories should also be ignored, and revisit content inlining only if tool-driven reads prove too indirect.
