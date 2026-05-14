# Edit File Tool Plan

## Summary

Implement a precise `edit_file` tool for Topchester's coding-agent loop.

The target outcome is a workspace-scoped write tool that can safely make targeted edits to existing UTF-8 files, produce a useful diff result, and feed Topchester's KB/session state so file changes are not invisible to the knowledge system.

This plan exists because `edit_file` is a core coding-agent capability. Topchester already has `read_file`, `grep`, and `find_file`; the prompt expects edit tools when available, but there is no actual write boundary yet.

## Decisions

- Add `edit_file`, not a generic `write_file`, as the first file mutation tool.
- Use exact text replacement as the V0 contract.
- Support multiple replacement blocks in one call for one file.
- Match every `old_text` against the same original file content, then apply replacements from the end of the file backward so offsets stay stable.
- Require every `old_text` to be non-empty, unique, and non-overlapping.
- Preserve the target file's BOM and line ending style.
- Return a compact unified diff plus changed-line metadata.
- Keep fuzzy matching out of V0. If added later, it must be opt-in and visibly riskier.
- Do not introduce a full `apply_patch` language first. It is powerful, but it is a larger parser, UI, and safety surface than Topchester needs for the first edit tool.

## Scope

Included:

- Existing-file targeted edits.
- Workspace path containment.
- Atomic-ish write flow using a temporary file and rename where practical.
- Per-file mutation queue so concurrent edits to the same file serialize.
- Tool result metadata for changed path, diff, content hash before/after, and first changed line.
- Tests for exact matching, duplicate matches, overlap rejection, line endings, BOM, path escape, and concurrent same-file calls.
- Prompt and docs updates so the model knows when to use `edit_file`.
- KB/session hooks that mark edited files dirty or stale after the tool succeeds.

Not included:

- Creating new files.
- Deleting or moving files.
- Multi-file patches in one tool call.
- Fuzzy matching or line-number anchored matching.
- Formatter/LSP integration.
- Human approval UI before writes.
- Strict KB blocking before edits.

## Current State

Topchester's tool layer lives under `src/agent/tools/`.

Current tools:

- `read_file` reads a UTF-8 file inside the workspace.
- `grep` searches workspace text with `rg` first, then `grep`.
- `find_file` finds fuzzy file-name matches.
- `toolRegistry` exposes those tools to parsing, execution, and prompt text.
- `executeToolCall(...)` logs tool calls and result metadata.
- `parseToolCall(...)` accepts only a single JSON tool call from the model.

Runtime shape:

- `TopchesterAgentRuntime.submitMessage(...)` currently lets the model make one tool call, executes it, then asks the model for a final answer.
- There is no multi-step agent loop yet.
- `ToolResult` currently carries `tool`, optional `path`, `content`, optional `command`, and optional `warning`.
- `docs/cli.md` says interactive mode lets the model use `read_file` and `grep`; it should be updated when `edit_file` ships.

KB shape to preserve:

- AGENTS.md states that agent and KB are one system.
- Normal coding paths should not bypass `topchester-kb/`.
- V0 drift enforcement is advisory, but edits must still become known runtime/session state and must not silently leave the KB contract behind.

## Competitor Findings

These were checked in the local checkouts named by `AGENTS.override.md`.

### Pi

Source checked:

- `/Users/kodi/data/github/pi/packages/coding-agent/src/core/tools/edit.ts`
- `/Users/kodi/data/github/pi/packages/coding-agent/src/core/tools/edit-diff.ts`
- `/Users/kodi/data/github/pi/packages/coding-agent/src/core/tools/write.ts`

Relevant pattern:

- Pi's `edit` tool accepts `path` plus `edits[]`.
- Each edit has exact `oldText` and `newText`.
- Multiple disjoint replacements in one file are encouraged.
- Edits match the original file, not the progressively edited file.
- It rejects empty, duplicate, and overlapping matches.
- It preserves BOM and line endings.
- It has a per-file mutation queue.
- It computes and renders a preview diff.

Topchester should borrow this core shape.

### OpenCode

Source checked:

- `/Users/kodi/data/github/opencode/packages/opencode/src/tool/edit.ts`
- `/Users/kodi/data/github/opencode/packages/opencode/src/tool/write.ts`
- `/Users/kodi/data/github/opencode/packages/opencode/src/tool/apply_patch.ts`
- `/Users/kodi/data/github/opencode/packages/opencode/src/tool/registry.ts`

Relevant pattern:

- OpenCode has `edit`, `write`, and `apply_patch`.
- `edit` replaces `oldString` with `newString`, with optional `replaceAll`.
- It asks for edit permission with diff metadata before writing.
- It preserves BOM and line endings, formats after write, publishes file edited/watcher events, and collects LSP diagnostics.
- `apply_patch` supports add/update/delete/move and returns per-file metadata.
- Registry switches some models to `apply_patch` and hides `edit`/`write` for those models.

Topchester should borrow diff metadata and file-change events, but defer model-specific tool switching and formatter/LSP work.

### Codex

Source checked:

- `/Users/kodi/data/github/codex/codex-rs/apply-patch/apply_patch_tool_instructions.md`
- `/Users/kodi/data/github/codex/codex-rs/apply-patch/src/lib.rs`

Relevant pattern:

- Codex uses a dedicated patch grammar with `Add File`, `Update File`, `Delete File`, optional move, and contextual hunks.
- The parser validates hunks and prints a concise summary like added/modified/deleted paths.
- Tests cover malformed patches, missing context, moves, deletes, write errors, and partial failure behavior.

Topchester should not start with this full grammar, but should keep the test discipline and summary format in mind for a later `apply_patch` or `patch_file` tool.

### Cline

Source checked:

- `/Users/kodi/data/github/cline/src/core/prompts/system-prompt/tools/replace_in_file.ts`
- `/Users/kodi/data/github/cline/src/core/prompts/system-prompt/tools/write_to_file.ts`
- `/Users/kodi/data/github/cline/src/core/task/tools/handlers/WriteToFileToolHandler.ts`
- `/Users/kodi/data/github/cline/src/integrations/editor/DiffViewProvider.ts`
- `/Users/kodi/data/github/cline/cli/src/utils/DiffComputer.ts`

Relevant pattern:

- Cline separates `replace_in_file` for targeted edits and `write_to_file` for whole-file writes.
- `replace_in_file` uses multiple SEARCH/REPLACE blocks and instructs the model to keep blocks small, complete, and ordered.
- It streams proposed content into a diff view, lets the user approve or reject, and reports final file content after edits or auto-formatting.
- It records strong failure messages when search blocks do not match.

Topchester should borrow small-block guidance and final-state feedback, but defer streaming approval UI.

### Kilo Code

Source checked:

- `/Users/kodi/data/github/kilocode/packages/kilo-docs/pages/automate/tools/apply-diff.md`
- `/Users/kodi/data/github/kilocode/packages/kilo-docs/pages/code-with-ai/features/fast-edits.md`
- `/Users/kodi/data/github/kilocode/packages/opencode/src/tool/edit.ts`
- `/Users/kodi/data/github/kilocode/packages/opencode/src/tool/apply_patch.ts`

Relevant pattern:

- Kilo treats diff-based edits as the fast/default path because whole-file writes are slower and risk truncated content.
- It documents a match precision slider; 100% exact matching is safest, lower fuzzy thresholds increase risk.
- Its `apply_diff` requires line markers for the currently implemented strategies.

Topchester should start with exact matching and avoid line-number dependence in the tool contract. Line numbers can be returned as output metadata, not trusted as the primary match key.

## Recommended Approach

Implement `edit_file` as a small Topchester-owned tool, not a shell wrapper.

Suggested tool call shape:

```json
{
  "tool": "edit_file",
  "args": {
    "path": "src/example.ts",
    "expected_current_hash": "sha256:current-file-hash-from-read_file",
    "edits": [
      {
        "old_text": "const enabled = false;\n",
        "new_text": "const enabled = true;\n"
      }
    ]
  }
}
```

`expected_current_hash` should be optional at first, but `read_file` should return or expose the current hash so future model calls can pass it. It is the pre-edit/current file hash, not a predicted post-edit hash. When provided and the file changed since reading, `edit_file` should fail before writing.

Execution flow:

1. Resolve `path` inside the workspace.
2. Reject directories, binary files, missing files, and path escapes.
3. Read the file as bytes, detect UTF-8 BOM and line ending style.
4. Normalize matching to LF while preserving output style.
5. Validate each edit.
6. Match all edits against the original normalized content.
7. Reject duplicate or overlapping matches.
8. Apply replacements from the end backward.
9. If content is unchanged, fail clearly.
10. Write through a temporary file in the same directory, then rename over the target.
11. Return diff and file metadata.
12. Emit runtime/session/KB dirty state for the changed file.

## Files to Add

- `src/agent/tools/edit-file.ts`
- `src/agent/tools/file-mutation-queue.ts`
- `test/edit-file-tool.test.ts` or new cases in `test/tools.test.ts`

## Files to Change

- `src/agent/tools.ts`
- `src/agent/tools/registry.ts`
- `src/agent/tools/types.ts`
- `src/agent/tools/read-file.ts`
- `src/agent/tools/executor.ts`
- `src/agent/prompts.ts`
- `src/agent/runtime.ts`
- `src/agent/events.ts`
- `src/knowledge/status.ts` or a new KB/session overlay module, depending on where dirty edit state lands
- `test/tools.test.ts`
- `test/commands.test.ts` or runtime tests if tool-call flow changes
- `docs/cli.md`
- `docs/plans/kb-implementation-checklist.md`

## Slices

### Slice 1: Edit Contract and Pure Apply Logic

Status: `[x]` Completed

Goal: Define and test the core edit algorithm without touching the real filesystem.

Why here: Matching/replacement correctness is the main safety boundary. It should be proven before wiring the tool into the runtime.

This slice should implement:

- `edit_file` argument schema.
- Pure helpers for line-ending normalization, BOM handling, exact matching, duplicate detection, overlap detection, and reverse-order replacement.
- Unified diff generation with first changed line.
- Tests for successful one-block and multi-block edits.
- Tests for empty `old_text`, missing match, duplicate match, overlapping edits, identical output, CRLF preservation, and BOM preservation.

Expected output:

- A pure edit engine that returns `{ newContent, diff, firstChangedLine }` or a precise failure.
- No runtime/tool registry integration yet.

Verification:

```sh
pnpm test test/tools.test.ts
pnpm typecheck
```

Dependencies: None.

### Slice 2: Workspace-Scoped `edit_file` Tool

Status: `[x]` Completed

Goal: Expose the edit engine as a real workspace tool.

Why here: After the edit contract is tested, the next risk is path safety and filesystem behavior.

This slice should implement:

- `src/agent/tools/edit-file.ts`.
- Workspace containment checks matching `read_file` and `grep`.
- Existing-file-only behavior.
- UTF-8 text read/write with clear errors for directories, missing files, and invalid paths.
- Same-directory temporary write plus rename.
- Per-file mutation queue to serialize writes to the same resolved path.
- Optional `expected_current_hash` check.
- Tool result fields for path, diff, before/after hashes, bytes changed, and first changed line.

Expected output:

- `executeToolCall(...)` can run `edit_file` against a temp workspace in tests.
- Failed edits do not partially write files.

Verification:

```sh
pnpm test test/tools.test.ts
pnpm typecheck
```

Dependencies: Slice 1.

### Slice 3: Registry, Prompt, and Runtime Result Handling

Status: `[x]` Completed

Goal: Let the model discover and use `edit_file` safely.

Why here: The model needs concise instructions and the runtime needs to present edit results differently from read/search results.

This slice should implement:

- Register `edit_file` in `toolRegistry`.
- Export the tool from `src/agent/tools.ts`.
- Update `getToolPromptLines()` expectations.
- Update `getChatSystemPrompt()` guidance:
  - use `read_file` before editing,
  - use `edit_file` for existing-file targeted edits,
  - make multiple disjoint edits in one call for the same file,
  - keep `old_text` small but unique,
  - do not use line labels from read output in `old_text`.
- Adjust `formatToolCallMessage(...)` and `formatToolResultForPrompt(...)` so edit results show the diff and final hash without dumping entire file contents.
- Keep the current single-tool-call runtime loop unless a test proves `edit_file` needs immediate multi-step retry support.

Expected output:

- The model sees `edit_file` as an available tool.
- User-visible tool rows and final model prompt contain useful edit summaries.

Verification:

```sh
pnpm test test/tools.test.ts test/tui.render.test.ts
pnpm typecheck
```

Dependencies: Slice 2.

### Slice 4: KB and Session Dirty-State Hooks

Status: `[x]` Completed

Goal: Make successful edits visible to Topchester's KB/runtime state.

Why here: AGENTS.md makes KB coupling a core invariant; edits cannot be a side effect known only to the filesystem.

This slice should implement:

- A small file-edit event shape with path, before hash, after hash, diff summary, and timestamp.
- Logging of edit result metadata without full file content at `debug`.
- A session-overlay or runtime dirty-state hook that marks edited files as known dirty.
- Advisory KB state update: changed L1 entries become stale/suspect, or a `needs_sync` marker is set if the full stale propagation is not implemented yet.
- Tests for emitted metadata and dirty-state behavior.

Expected output:

- After `edit_file`, Topchester can tell that the KB may need refresh for that file.
- Future KB-aware agent slices have a concrete event/overlay contract to consume.

Verification:

```sh
pnpm test test/tools.test.ts test/logging.test.ts
pnpm typecheck
```

Dependencies: Slice 3.

### Slice 5: Documentation and Checklist Update

Status: `[x]` Completed

Goal: Keep user-facing command docs and implementation tracking in sync.

Why here: CLI behavior changes should update docs in the same feature path.

This slice should implement:

- Update `docs/cli.md` interactive `topchester` section to mention `edit_file`.
- Update `docs/plans/kb-implementation-checklist.md` under Agent KB-Aware Behavior or a new Tool Execution section.
- Record exact verification commands in this plan.
- Add working notes from implementation findings that affect later slices.

Expected output:

- Docs describe the new edit capability accurately.
- The checklist shows what part of the agent edit path is now implemented.

Verification:

```sh
pnpm check
```

Dependencies: Slices 1-4.

## Cross-Slice Rules

- Do not add broad write access outside the workspace.
- Do not create, delete, or move files through `edit_file`.
- Keep exact matching as the default and only V0 behavior.
- Preserve file line endings and BOM.
- Never log full edited file contents at debug level.
- Treat KB/session dirty state as part of edit success, not a later nice-to-have.
- Prefer focused tests around small temp workspaces over broad integration tests until the runtime loop grows.

## Testing Plan

Per-slice verification is listed above. Final verification should run:

```sh
pnpm check
```

Manual checks after implementation:

- Ask Topchester to edit a small existing file and confirm the file changes.
- Ask it to edit a duplicated snippet and confirm the tool fails with a useful message.
- Ask it to edit a file after manually changing it from another shell and confirm `expected_current_hash` catches the stale read when provided.
- Confirm the TUI shows a compact edit tool row and the final answer does not dump the whole file.
- Confirm the KB/session state records the edited path as needing sync or stale.

## Open Questions

- Should `expected_current_hash` become required after `read_file` returns hashes, or stay optional for model ergonomics?
- Should `read_file` return line numbers, hashes, or both, and how should that be formatted so models do not copy line labels into `old_text`?
- Should `edit_file` have a `dry_run` mode for future approval UI, or should preview be a separate TUI/runtime concern?
- Where exactly should the first session overlay live while `.agents/topchester/sessions/` is still minimal?
- Should a separate `create_file` or `write_file` tool come next, or should Topchester jump directly from `edit_file` to a structured `apply_patch` tool?

## Working Notes

- 2026-05-12: Plan created after reading `AGENTS.md`, `AGENTS.override.md`, the architecture/knowledge/session/CLI docs, current Topchester tool code, and local Pi/OpenCode/Codex/Cline/Kilo Code edit implementations.
- 2026-05-12: Slice 1 added a pure edit engine in `src/agent/tools/edit-file.ts`; verification passed with `pnpm test test/tools.test.ts` and `pnpm typecheck`.
- 2026-05-12: Slice 2 wired `edit_file` as a workspace-scoped tool with same-directory temp writes, per-file mutation serialization, expected-current-hash checks, diff/hash metadata, and registry execution. Verification passed with `pnpm test test/tools.test.ts`, `pnpm typecheck`, and `pnpm format-check`.
- 2026-05-12: Slice 3 added edit-specific prompt guidance, `read_file` hash metadata, compact edit result formatting for the final model prompt, and runtime coverage for edit tool-call labels/results. Verification passed with `pnpm test test/tools.test.ts test/tui.render.test.ts test/commands.test.ts`, `pnpm typecheck`, and `pnpm format-check`.
- 2026-05-12: Slice 4 added an in-memory session overlay for edit events and dirty-known KB state, marks edited files `needs_sync` with stale L1/suspect derived markers, and sanitizes edit debug logs so old/new text is not logged at debug level. Verification passed with `pnpm test test/tools.test.ts test/logging.test.ts`, `pnpm test test/commands.test.ts`, `pnpm typecheck`, and `pnpm format-check`.
- 2026-05-12: Slice 5 updated `docs/cli.md`, `docs/plans/kb-implementation-checklist.md`, and this plan; also corrected the CLI integration footer expectation to the current label-less model footer. Verification passed with `pnpm check` and `mise local-ci`.

## Next Slice

All slices implemented. Final gate: `mise local-ci` passed.
