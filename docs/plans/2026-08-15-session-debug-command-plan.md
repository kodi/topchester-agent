# Session Debug Command Plan

## Summary

Add `topchester session debug <session-id>` so developers can inspect one project-local session and see where its elapsed time went. The report must use durable session events for history and session-scoped timing records when trace or debug logging captured them. It must state when exact timing data is not available.

## Decisions

- Accept `latest`, an exact session ID, or a unique session ID prefix.
- Include child sessions recursively because parallel subagents are part of root-session performance.
- Print a readable report by default and support `--json` for scripts.
- Keep raw prompt, response, and tool-result content out of the report.
- Do not infer exact model or tool percentages from unscoped legacy log entries. Show event-gap evidence and a low-coverage warning instead.
- Add compact session-scoped timing records at debug level. Trace remains necessary only for full content inspection.
- Report both summed work time and wall-clock time. Parallel child work can make summed work exceed wall-clock time.

## Scope

Included:

- session metadata, event counts, turn counts, tool counts, failures, subagent outcomes, and longest event gaps
- model, tool, hook, setup, and other timing percentages when scoped timing records exist
- per-tool and per-session timing tables
- log coverage and actionable warnings
- text and JSON output
- focused unit and CLI integration tests
- public CLI and session documentation

Out of scope:

- changing stored session event schemas
- printing raw trace content
- a live TUI performance view
- retroactive exact attribution for old unscoped logs

## Implementation Shape

The runtime writes one compact timing record for each measured phase. Each record includes the root session ID, current session ID, turn ID, phase, duration, and optional tool metadata. A final turn record supplies wall duration. The debug analyzer loads the selected session tree, reads the project log if present, selects matching timing records, and builds one stable report model for text and JSON formatters.

### Slice 1: Report contract and analyzer

Status: `[x]` Done

- add report types and event-only analysis
- resolve exact, latest, and unique-prefix session selectors
- parse scoped timing records without failing on malformed or unrelated log lines
- format readable and JSON-safe output

Verification: focused analyzer tests.

Completed:

- Added the versioned report contract, event and child-session analysis, timing coverage, tool summaries, longest mixed gaps, warnings, and text/JSON formatters.
- Added exact, latest, and unique-prefix selection. A unique top-level session wins over children that share its short UUIDv7 prefix.

Dependencies: existing session store and project-local log path helpers.

### Slice 2: Runtime timing records

Status: `[x]` Done

- add session, root-session, and turn identifiers
- measure prompt preparation, model waits, tool execution, hooks, setup, and total turn time
- keep records compact at debug level
- preserve current runtime behavior

Verification: focused runtime logging tests.

Completed:

- Added session-scoped turn markers and compact setup phase records.
- Added session, root-session, turn, and tool-call identifiers to model, tool, and hook timing records.
- Added exact provider-wait timing separate from legacy model-step timing.

Dependencies: Slice 1 report contract.

### Slice 3: CLI, docs, and final verification

Status: `[x]` Done

- wire `topchester session debug <session-id>` and `--json`
- add CLI integration coverage for rich and event-only reports
- update `docs/reference/cli.md` and `docs/features/sessions.md`
- run format, type, and product tests through repository-approved `mise` tasks

Verification: CLI integration test, targeted product tests, `mise run typecheck`, and `mise run format-check`.

Completed:

- Added the `session debug` command, `--json`, public CLI/session docs, and the changelog entry.
- Focused verification passed: `mise run test-node -- test/session-debug.test.ts test/agent-runtime.test.ts test/cli.integration.test.ts test/tools.test.ts` (196 tests).
- Repository checks passed: `mise run local-ci`.
- Full product verification passed outside the restricted sandbox: `mise run test-node` (620 tests).
- Packaged-install verification passed: `mise run package-check`.

Dependencies: Slices 1 and 2.

## Edge Cases

- missing log file or logging disabled
- log file begins after the session starts
- multiple Topchester processes append to the same log
- old log entries without session fields
- malformed JSON log lines
- active sessions whose final turn has not ended
- parallel tools and child sessions
- failed or aborted child sessions
- zero-duration and empty sessions
- ambiguous session ID prefixes

## Working Notes

- 2026-08-15: The observed Gantempo trace has `model_response.durationMs`, `tool_result.durationMs`, and `hook_run.durationMs`, but no session, turn, or tool-call identifiers. Concurrent root and child logs are therefore not safe to attribute exactly.
- 2026-08-15: Session `events.jsonl` emits tool-call rows after tool completion. Gaps between rows combine model wait, setup, hooks, and tool work, so event-only reports must label gaps as mixed time.
- 2026-08-15: The sandboxed full suite could not bind local HTTP fixtures. The same `mise run test-node` command passed outside the restricted sandbox.
