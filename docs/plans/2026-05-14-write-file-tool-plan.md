# Write File Tool Plan

## Summary

Implement a workspace-scoped `write_file` tool for Topchester's coding-agent loop.

The target outcome is a safe file-creation path that lets the agent add new source files, tests, fixtures, config files, and docs without abusing `edit_file` or `inspect_command`. `edit_file` should remain the precise targeted-edit tool for existing files; `write_file` should own whole-file creation and, only after the create path is proven, explicit hash-guarded whole-file replacement.

This plan follows the alpha gap analysis item for `write_file` / `create_file` / `mkdir` and reuses the existing `edit_file` safety shape: workspace containment, UTF-8 text only, same-directory atomic-ish writes, compact metadata, trace-only content logging, and KB/session overlay updates.

## Decisions

- Add a new agent tool named `write_file`.
- Default behavior is create-only: fail when the target path already exists.
- Keep V0 UTF-8 text only.
- Keep path containment strict; reject absolute or relative paths that resolve outside the workspace.
- Do not add a broad `mkdir` tool first.
- Let `write_file` create parent directories only when `create_parent_dirs: true` is provided.
- Reject missing parent directories when `create_parent_dirs` is absent or false.
- Return path, hash, byte count, line count, KB state, and a compact creation summary.
- Mark successfully written files dirty-known and `needs_sync` through the same session overlay used by `edit_file`.
- Implement overwrite support only as a separate hash-guarded mode after the create path, requiring an explicit existing-file hash.
- Defer binary writes, deletes, moves, chmod, and patch grammar support.

## Scope

Included:

- Workspace-scoped creation of new UTF-8 files.
- Optional parent directory creation for the target path.
- Atomic-ish write flow using a temporary file in the final directory and rename.
- Per-file mutation serialization through the existing file mutation queue.
- Structured tool result metadata for path, hash, byte count, line count, created parent directories, and KB dirty state.
- Runtime prompt and TUI labels for successful writes.
- Tests for parser, schema, path safety, missing parent behavior, parent directory creation, existing-file rejection, UTF-8 handling, atomic write cleanup, logging, KB/session overlay, and runtime formatting.
- Docs updates for interactive tool behavior.

Not included:

- General directory creation unrelated to a file write.
- Overwriting existing files in the first create-only slice.
- Binary or base64 content.
- File deletion, move, copy, rename, or chmod.
- Formatter or LSP integration after writes.
- Human approval UI before writes.
- Strict KB blocking before writes.

## Current State

Topchester currently exposes these workspace-scoped tools:

- `read_file`
- `list_files`
- `grep`
- `find_file`
- `edit_file`
- `inspect_command`

Relevant existing implementation surfaces:

- `src/agent/tools/registry.ts` registers tools and feeds prompt lines.
- `src/agent/tools/types.ts` defines the shared `ToolContext`, `ToolCall`, `ToolResult`, and `ToolDefinition` contracts.
- `src/agent/tools/edit-file.ts` already has path containment, UTF-8 validation, same-directory temp-file writes, hash metadata, diff summaries, mutation queue use, and session-overlay recording.
- `src/agent/tools/file-mutation-queue.ts` serializes same-file mutations.
- `src/agent/tools/executor.ts` logs tool calls and result metadata while avoiding debug-level file content.
- `src/knowledge/session-overlay.ts` currently models successful agent writes as `FileEditEvent` and dirty file state.
- `src/agent/runtime.ts` formats tool results into the next model prompt and compact TUI tool-call labels.
- `src/tui/messages.ts` mutes known tool-call lines in chat.
- `test/tools.test.ts`, `test/commands.test.ts`, and `test/logging.test.ts` cover the tool registry, runtime loop, metadata, prompt behavior, and logging boundaries.
- `docs/cli.md` and `docs/plans/kb-implementation-checklist.md` track implemented tool behavior.

Important baseline:

- `edit_file` intentionally rejects missing files.
- `inspect_command` is read-only and must not become a write escape hatch.
- Normal coding paths must keep the KB/session overlay aware of agent-authored file changes.

## Recommended Contract

Suggested V0 tool call shape:

```json
{
  "tool": "write_file",
  "args": {
    "path": "test/example.test.ts",
    "content": "import { describe, expect, it } from \"vitest\";\n\nit(\"works\", () => {\n  expect(true).toBe(true);\n});\n",
    "create_parent_dirs": true
  }
}
```

Suggested V0 args:

```ts
interface WriteFileToolArgs {
  path: string;
  content: string;
  create_parent_dirs?: boolean;
}
```

Suggested V0 result:

```ts
interface WriteFileToolResult extends ToolResult<"write_file"> {
  hash: string;
  bytesWritten: number;
  lineCount: number;
  createdParentDirs: string[];
  kbState: "needs_sync";
  writeEvent: FileMutationEvent;
}
```

Suggested tool output text:

```text
Created test/example.test.ts
hash: sha256:...
bytes_written: 109
line_count: 6
kb_state: needs_sync
created_parent_dirs: test
```

Prompt guidance should tell the model:

- Use `write_file` for new files by default.
- Use `edit_file` for targeted changes to existing files.
- Use `read_file` before replacing an existing file with `write_file` `overwrite: true`.
- Pass `create_parent_dirs: true` only when the user intent implies creating that folder path.
- Do not use `inspect_command` for file creation.

## Implementation Shape

Add `src/agent/tools/write-file.ts` with these helper boundaries:

- `writeFileArgsSchema`
- `writeFileTool`
- `writeWorkspaceFile(...)`
- workspace path resolver, preferably shared later with `edit_file`
- parent-directory validator/creator
- UTF-8 content encoder
- same-directory atomic write helper
- hash/line-count helpers
- creation summary helper

Execution flow:

1. Resolve the requested path inside the workspace.
2. Reject NUL bytes and workspace escapes.
3. Reject target paths that resolve to the workspace root.
4. Check whether the target exists.
5. If the target exists, fail in V0 with a clear `write_file can only create new files` error.
6. Check the parent directory.
7. If the parent is missing and `create_parent_dirs` is not true, fail with a clear parent-missing error.
8. If `create_parent_dirs` is true, create only the needed parent directory chain inside the workspace.
9. Encode `content` as UTF-8 bytes.
10. Write to a hidden temp file in the final parent directory with exclusive create, then rename to the target.
11. Hash the final bytes.
12. Record the file mutation in the session overlay.
13. Return compact metadata and avoid returning full content unless future UX proves it is needed.

## Session Overlay Shape

The current session overlay names file changes `FileEditEvent`. `write_file` should not fake an edit of a missing file.

Recommended small refactor:

- Add a broader event type such as `FileMutationEvent`.
- Keep existing edit event fields working for `edit_file`.
- Add `operation: "edit" | "create"` or a discriminated `kind: "file_edit" | "file_create"`.
- Preserve existing dirty-file state fields where they still make sense.
- For created files, use:
  - `beforeHash: null` or omit `beforeHash`
  - `afterHash`
  - `firstChangedLine: 1`
  - `diffSummary: "+N/-0"` or `writeSummary: "created N lines"`

Avoid a larger persisted-overlay migration in the first implementation. This is still in-memory runtime state until the runtime cache work introduces session overlay storage.

## Files to Add

- `src/agent/tools/write-file.ts`

## Files to Change

- `src/agent/tools.ts`
- `src/agent/tools/registry.ts`
- `src/agent/tools/executor.ts`
- `src/agent/tools/types.ts` if shared result types need widening
- `src/knowledge/session-overlay.ts`
- `src/agent/prompts.ts`
- `src/agent/runtime.ts`
- `src/tui/messages.ts`
- `test/tools.test.ts`
- `test/commands.test.ts`
- `test/logging.test.ts`
- `docs/cli.md`
- `docs/plans/kb-implementation-checklist.md`

## Cross-Slice Rules

- Keep `write_file` implemented in TypeScript application code, not through shell commands.
- Keep writes workspace-scoped and KB/session-overlay aware.
- Keep `write_file` create-only by default; overwrite requires `overwrite: true`, `expected_current_hash`, tests, and prompt guidance.
- Do not log full file content at debug level.
- Do not use `write_file` as a replacement for targeted edits.
- Keep user-facing errors plain and concrete.

## Slices

### Slice 1: Create-Only Write Core

Status: `[x]` Completed

Goal: Implement and test the core create-only filesystem behavior without changing the agent prompt yet.

Why here: File creation safety is the primary boundary. It should be proven before the model is encouraged to call the tool.

This slice should implement:

- `writeFileArgsSchema` with `path`, `content`, and `create_parent_dirs`.
- `writeWorkspaceFile(...)`.
- Workspace path containment.
- Existing-file rejection.
- Missing-parent rejection by default.
- Optional parent directory creation.
- UTF-8 byte encoding and hash calculation.
- Same-directory temp-file write and rename.
- Per-file mutation queue use.

Expected output:

- New `src/agent/tools/write-file.ts`.
- Focused tests for successful creation, existing target rejection, missing parent behavior, parent creation, workspace escape rejection, invalid path rejection, and same-file mutation serialization.

Verification:

```sh
pnpm test test/tools.test.ts
pnpm typecheck
```

Dependencies: None.

### Slice 2: Session Overlay Mutation Event

Status: `[x]` Completed

Goal: Record created files as known dirty files without pretending they were existing-file edits.

Why here: The core invariant is that agent-authored file changes must not bypass the KB/session state.

This slice should implement:

- Broaden the overlay event model from edit-only to file mutation events.
- Preserve `edit_file` result shape and existing tests.
- Record successful `write_file` calls with create-specific metadata.
- Keep dirty file state compatible with `/kb status` and future `/kb sync` expectations.

Expected output:

- Created files appear in `getSessionOverlayState(workspace).dirtyFiles`.
- `write_file` results include `kbState: "needs_sync"` and a write event.
- Existing `edit_file` tests still pass unchanged or with minimal naming updates.

Verification:

```sh
pnpm test test/tools.test.ts
pnpm test test/commands.test.ts
```

Dependencies: Slice 1.

### Slice 3: Registry, Prompt, and Runtime Formatting

Status: `[x]` Completed

Goal: Expose `write_file` to the model and show compact write metadata in the TUI/runtime loop.

Why here: The tool should only become model-visible after core write and overlay behavior are safe.

This slice should implement:

- Export `writeFileTool` from `src/agent/tools.ts`.
- Register the tool in `src/agent/tools/registry.ts`.
- Add model prompt guidance in the tool prompt and `src/agent/prompts.ts`.
- Add executor metadata summarization for `write_file`.
- Add runtime prompt formatting for `write_file` results.
- Add TUI tool-call label formatting such as `write_file: test/example.test.ts (created +6)`.
- Add `write_file` to `src/tui/messages.ts` known tool-call line detection.

Expected output:

- The model can call `write_file`.
- Follow-up model prompts receive hashes, byte count, line count, KB state, and creation summary.
- The chat transcript shows a compact system row instead of dumping file content.

Verification:

```sh
pnpm test test/tools.test.ts
pnpm test test/commands.test.ts
pnpm test test/tui.render.test.ts
```

Dependencies: Slices 1 and 2.

### Slice 4: Logging and Failure Hygiene

Status: `[x]` Completed

Goal: Keep write telemetry useful without leaking full generated files into debug logs.

Why here: `write_file` will often create tests, config, or docs with user content. Logging should mirror the stricter `edit_file` behavior.

This slice should implement:

- Debug log summarization for args: path, content length, line count, and `create_parent_dirs`.
- Debug result metadata: path, hash, byte count, line count, created parent directories, KB state, and duration.
- Trace-only full tool result content, consistent with existing executor behavior.
- Temp-file cleanup assertions on write failure where practical.

Expected output:

- Debug logs contain useful metadata.
- Debug logs do not contain full file content.
- Failed writes do not leave durable target files behind.

Verification:

```sh
pnpm test test/logging.test.ts
pnpm test test/tools.test.ts
```

Dependencies: Slices 1-3.

### Slice 5: Docs and Checklist Sync

Status: `[x]` Completed

Goal: Update visible docs and implementation tracking after `write_file` ships.

Why here: Tool behavior is user-facing and should stay aligned with CLI/TUI documentation.

This slice should implement:

- Update `docs/cli.md` interactive tool list and behavior notes.
- Update `docs/plans/kb-implementation-checklist.md` Tool Execution and Agent KB-Aware Behavior sections.
- Mention that `write_file` is create-only by default, hash-guarded for whole-file overwrite, and `edit_file` remains the targeted edit tool.

Expected output:

- Docs reflect the implemented behavior and current limitations.
- Checklist captures the shipped create path and hash-guarded overwrite work.

Verification:

```sh
pnpm check
```

Dependencies: Slices 1-4.

### Slice 6: Hash-Guarded Overwrite Follow-Up

Status: `[x]` Completed

Goal: Add explicit whole-file replacement only after create-only behavior is stable.

Why here: Whole-file overwrite is useful for generated files, but it is riskier than creation and targeted edits. It deserves a separate reviewable step.

This slice should implement:

- Extend args with an explicit overwrite mode, for example:

```ts
interface WriteFileToolArgs {
  path: string;
  content: string;
  create_parent_dirs?: boolean;
  overwrite?: boolean;
  expected_current_hash?: string;
}
```

- Require `overwrite: true` and `expected_current_hash` from the latest `read_file` result for existing-file replacement. The hash is checked before writing to catch stale reads; it is not a predicted hash of the replacement content.
- Fail if the target is missing when overwrite is true, unless a separate create-or-replace mode is intentionally added later.
- Return before and after hashes, byte delta, and line delta for overwrite results.
- Keep prompt guidance clear: prefer `edit_file` for targeted existing-file edits.

Expected output:

- `write_file` can replace an existing file only when the model proves it read the expected current version.
- Existing create-only defaults remain unchanged.

Verification:

```sh
pnpm test test/tools.test.ts
pnpm test test/commands.test.ts
pnpm check
```

Dependencies: Slices 1-5.

## Testing Plan

Per-slice tests are listed above. The final confidence pass should be:

```sh
pnpm check
```

If the repo's broader local CI gate is available and expected for the implementation slice, also run:

```sh
mise run local-ci
```

Manual smoke prompt after implementation:

```text
Create a new Vitest test file under test/ that checks a simple exported helper, then report the file you created.
```

Expected smoke behavior:

- The model uses `write_file` for the new file.
- The TUI shows a compact `write_file: ... (created +N)` row.
- The file exists in the workspace.
- `kb_state` is `needs_sync`.
- `/kb status` reports the created file as non-clean when it is in scope.

## Open Questions And Follow-Ups

- Resolved: line count uses logical lines, so a trailing newline does not add an extra line.
- Resolved: the session overlay tracks the created file, while `write_file` result metadata reports any parent directories created for the write.
- Should the tool reject very large content in V0 to avoid accidental huge writes?
- Should generated files that match ignore rules still appear in session overlay dirty state, even if `/kb status` later excludes them?
- Should a later standalone `mkdir` tool exist, or is `create_parent_dirs` enough until a move/copy/delete tool family exists?

## Slice Status

All implementation slices in this plan are complete.
