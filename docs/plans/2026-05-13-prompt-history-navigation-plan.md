# Prompt History Navigation Plan

## Summary

Add standard prompt history navigation to the interactive TUI:

- `Up` recalls the previous submitted prompt.
- Repeated `Up` walks older prompts.
- `Down` walks back toward newer prompts.
- `Down` from the newest recalled prompt restores the draft the user had before entering history.

This should feel like normal terminal-agent prompt history while preserving Topchester's existing modal, slash-suggestion, and chat-scroll behaviors.

## Decisions

- Keep V1 in memory only. Do not persist prompt history to disk yet.
- Store submitted slash commands and normal chat prompts in the same prompt history.
- Skip empty input and consecutive duplicate submissions.
- Cap the in-memory history at 100 prompts.
- Preserve the draft input while browsing history and restore it when navigating back past the newest history entry.
- Keep modal and slash suggestion `Up`/`Down` handling higher priority than prompt history.
- Move bare chat-thread scroll off `Up`/`Down` for the normal prompt state. Keep `PageUp`, `PageDown`, `Home`, `End`, and mouse wheel for thread scrolling.

## Scope

This plan covers keyboard navigation through previously submitted prompt text in one TUI process.

Out of scope for V1:

- Persisting prompt history across process restarts.
- A visible history picker or fuzzy search UI.
- Per-session history import from `.agents/topchester/sessions/`.
- Multiline prompt editing semantics beyond what the existing `Input` component supports.
- Custom keybinding configuration.

## Current State

Topchester currently uses `src/tui/layout.ts` as the prompt/input boundary. `ChatLayout` owns a `@earendil-works/pi-tui` `Input`, appends user messages on submit, clears the input, and routes submitted text to either `submitCommand` or `submitMessage`.

Keyboard precedence today:

1. `Esc` cancels an active operation.
2. Active chat modals use `Up`/`Down` to choose an action.
3. Slash command suggestions use `Up`/`Down` to choose a suggestion.
4. Bare `Up`/`Down` scroll the chat thread by 3 lines.
5. Remaining input reaches `Input.handleInput(...)`.

The important conflict is step 4. In normal prompt mode, bare `Up`/`Down` are already consumed by chat scrolling, so prompt history cannot work unless the scroll binding changes or becomes conditional.

Existing tests in `test/tui.render.test.ts` already cover prompt rendering, user submission, slash suggestions, modal navigation, and chat scrolling. The new behavior should extend those tests instead of adding a separate test harness.

## Competitor Notes

Local checkout findings:

- OpenCode documents `history_previous: up` and `history_next: down` in `/Users/kodi/data/github/opencode/packages/web/src/content/docs/keybinds.mdx`.
- OpenCode's app prompt history helper in `/Users/kodi/data/github/opencode/packages/app/src/components/prompt-input/history.ts` stores a bounded history, deduplicates consecutive entries, saves the current draft before history navigation, and restores that draft when moving back down.
- OpenCode only allows history navigation at prompt boundaries through `canNavigateHistoryAtCursor(...)`, avoiding accidental history replacement while editing in the middle of text.
- Pi's TUI editor has explicit history support in `/Users/kodi/data/github/pi/packages/tui/src/components/editor.ts`: it adds submitted text to history, navigates with arrow keys, and caps history at 100.
- Pi's interactive help says cursor keys move the cursor or browse history, with `Up` browsing history when empty.

Topchester's prompt is currently single-line and rendered through a narrower `Input` component, so V1 can use the simpler rule: in normal prompt mode, `Up`/`Down` navigate prompt history; chat scrolling stays on page keys and wheel.

## Implementation Shape

Keep the feature close to the TUI input boundary:

- Add a small prompt-history state object or helper owned by `ChatLayout`.
- Record submitted prompt text in one place, just before clearing the input.
- Track `historyIndex`, where `-1` means the user is editing the live draft and `0` means the most recent history entry.
- Save the live draft when entering history from `historyIndex === -1`.
- Reset history browsing when the user submits, types normal input, completes a slash suggestion, or otherwise edits the prompt.
- Prefer focused tests for history helper behavior if the logic grows beyond a few lines; otherwise keep tests at the `ChatLayout.handleInput(...)` level.

Likely code locations:

- `src/tui/layout.ts` for wiring history into `ChatLayout`.
- `src/tui/keys.ts` only if the feature needs additional key helpers.
- `test/tui.render.test.ts` for behavior coverage.
- `docs/cli.md` for the implemented key behavior.

## Slices

### Slice 1: Prompt History Contract

Status: `[ ]` Not started

Goal: Define the small, testable history behavior before changing key routing.

Why here: The current key handling has multiple consumers of `Up`/`Down`; a precise contract avoids breaking modals or slash suggestions.

This slice should implement:

- Add prompt-history helper logic, either as a small private class in `layout.ts` or a new focused module under `src/tui/`.
- Support add, previous, next, draft save/restore, consecutive duplicate skipping, empty skipping, and a max size of 100.
- Add focused tests for oldest/newest boundaries and draft restore.

Expected output:

- History behavior is covered without yet changing the user-visible key handling.
- The helper has no session, KB, or runtime dependency.

Verification:

```sh
pnpm test test/tui.render.test.ts
```

Dependencies: None.

### Slice 2: Wire Up/Down In Normal Prompt Mode

Status: `[ ]` Not started

Goal: Make `Up`/`Down` recall previous prompts when the normal prompt is active.

Why here: This is the user-facing behavior, and it depends on the helper contract from Slice 1.

This slice should implement:

- Record submitted chat prompts and slash commands into prompt history.
- Handle `Up`/`Down` after modal and slash-suggestion handlers, but before chat-thread scrolling and raw `Input.handleInput(...)`.
- Restore the saved draft when navigating down past the newest history entry.
- Keep prompt history disabled while a `promptHint` is shown during startup or busy states, so hint-only input is not replaced by old text.
- Clear history-browsing state when normal input editing resumes.

Expected output:

- Submitting `first`, then `second`, then pressing `Up` shows `second`; pressing `Up` again shows `first`; pressing `Down` shows `second`; pressing `Down` again restores the draft.
- Slash commands such as `/kb status` can be recalled.
- Modal action navigation and slash suggestion navigation still use `Up`/`Down` as before.

Verification:

```sh
pnpm test test/tui.render.test.ts
```

Dependencies: Slice 1.

### Slice 3: Reconcile Chat Scrolling Keys

Status: `[ ]` Not started

Goal: Preserve thread scrolling without stealing normal prompt history keys.

Why here: The current `Up`/`Down` scroll behavior conflicts directly with prompt history.

This slice should implement:

- Remove or narrow bare `Up`/`Down` thread scrolling in normal prompt mode.
- Keep `PageUp`, `PageDown`, `Home`, `End`, and mouse wheel thread scrolling.
- Update existing chat-scroll tests to assert page keys and wheel still work.
- Remove test expectations that bare `Up`/`Down` scroll the thread while the prompt is active.

Expected output:

- Users get standard prompt history on bare arrows.
- Existing non-arrow scroll paths remain tested and documented.

Verification:

```sh
pnpm test test/tui.render.test.ts
```

Dependencies: Slice 2.

### Slice 4: Documentation and Final Verification

Status: `[ ]` Not started

Goal: Document the new prompt key behavior and run the broader check.

Why here: CLI/TUI behavior changes should be reflected in `docs/cli.md` after implementation details settle.

This slice should implement:

- Update `docs/cli.md` under `topchester` interactive behavior:
  - `Up`/`Down` browse submitted prompt history in normal prompt mode.
  - `PageUp`/`PageDown`, `Home`/`End`, and mouse wheel scroll chat history.
  - `Up`/`Down` still navigate slash suggestions and active modal choices when those UI states are active.
- Record actual verification commands and any findings in this plan's Working Notes.

Expected output:

- User-facing docs match the implemented key behavior.
- Plan remains useful as a handoff record.

Verification:

```sh
pnpm check
```

Dependencies: Slices 1-3.

## Cross-Slice Rules

- Do not change model-facing conversation history. Prompt history is only an input convenience.
- Do not persist prompt history in V1.
- Do not let prompt history add old prompts to the chat thread until the user presses Enter.
- Preserve modal and slash suggestion key precedence.
- Keep wording in docs plain and concrete.
- Leave unrelated TUI layout, footer, KB, and session behavior untouched.

## Testing Plan

Per-slice verification is listed above.

Final verification:

```sh
pnpm check
```

Manual checks after implementation:

- Submit two normal prompts, then use `Up`/`Down` to recall them.
- Type a draft, press `Up`, then press `Down` until the draft is restored.
- Submit `/kb status`, then recall it with `Up`.
- Start a slash command such as `/k` and confirm `Up`/`Down` still move through suggestions.
- Open a KB modal and confirm `Up`/`Down` still move through modal actions.
- Confirm `PageUp`, `PageDown`, `Home`, `End`, and mouse wheel still scroll the chat thread.

## Open Questions

1. Should resumed sessions seed in-memory prompt history from restored user messages?
   - V1 answer: no. Keep this as a follow-up after persisted-session UX is stable.
2. Should prompt history include modal action submissions such as `Create KB now`?
   - V1 answer: yes if they flow through the normal user-input submission path, but do not add hidden synthetic events.
3. Should non-consecutive duplicates be kept?
   - V1 answer: yes. Only skip consecutive duplicates, matching common shell and agent behavior.
4. Should `Ctrl-P`/`Ctrl-N` also browse history?
   - V1 answer: no. Add only if Topchester later introduces configurable keybindings or Emacs-style prompt shortcuts.

## Working Notes

- 2026-05-13: Plan created. Current Topchester consumes bare `Up`/`Down` for thread scrolling after modal and slash suggestion handlers, so the implementation must explicitly move normal prompt history ahead of thread scrolling and keep page keys/wheel for chat history.
- 2026-05-13: Local competitor checkouts support the expected behavior: OpenCode binds prompt history to `Up`/`Down` and preserves drafts, while Pi's editor stores submitted prompts and exposes arrow-key history browsing.

## Next Slice

Start with Slice 1: Prompt History Contract.
