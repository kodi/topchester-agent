# Remove Completion Guards and Restore OpenTUI Syntax Highlighting

## Summary

Remove the benchmark-only runtime profile, the `finish_task` tool, and all
runtime logic that replaces a model's final response with completion-policy
messages. Restore syntax highlighting for completed fenced code blocks in the
OpenTUI scrollback renderer.

## Decisions

- A normal assistant message is always a valid terminal response.
- Topchester must not infer implementation intent and replace the model's final
  response because no source edit was observed.
- Remove the `terminal-bench` runtime profile and its CLI/tool-policy plumbing.
- Keep standalone benchmark and performance harnesses that do not alter the
  product runtime; remove their use of deleted runtime contracts.
- Keep streaming Markdown enabled so completed transcript text is committed
  reliably, while recognized fenced languages use a synchronous native text
  renderer for syntax colors.
- Preserve selectable code with surface-only background styling and respect
  `NO_COLOR`.

## Scope

Included: CLI/runtime/tool/profile removal, affected tests and current docs,
OpenTUI fenced-code rendering, packaged parser-worker support, and production
renderer coverage.

Out of scope: historical changelog entries and unrelated performance harnesses.

## Slices

### Slice 1: Remove completion-policy runtime surfaces

Status: `[x]` Done

- remove `finish_task`, required-finish environment behavior, and no-edit final
  response repair/failure wrappers
- remove the `terminal-bench` runtime profile and its tool-policy plumbing
- update active docs, scripts, and tests

Verification: focused agent runtime, tool, bash, and CLI tests.

Verified with `vp test run test/agent-runtime.test.ts test/bash-tool.test.ts
test/tools.test.ts test/cli.integration.test.ts` (204 tests passed) and
`mise run typecheck`.

### Slice 2: Restore highlighted fenced code

Status: `[x]` Done

- highlight recognized fenced languages synchronously during scrollback commit
- verify TSX and CSS token colors through the production renderer
- ensure packaged Tree-sitter worker resolution works

Verification: OpenTUI production test and packaged PTY code-fence smoke.

Verified with `mise run opentui-test`, `mise run build-standalone`, and
`mise run standalone-check`.

Finding: disabling streaming made completed Markdown intermittently blank in
the production renderer. The final implementation keeps streaming enabled and
uses native `StyledText` chunks for recognized languages, while still packaging
the Tree-sitter worker for OpenTUI's remaining syntax paths.

### Slice 3: Final gate and residue audit

Status: `[x]` Done

- run `mise run test` and `mise run local-ci`
- audit remaining runtime references and inspect the final diff

Verification: both repository gates pass and remaining benchmark mentions are
historical or standalone harness terminology only.

Verified with `mise run test` (41 files and 698 tests passed, including the
production OpenTUI renderer), `mise run local-ci`, the active-source residue
search, and `git diff --check`.
