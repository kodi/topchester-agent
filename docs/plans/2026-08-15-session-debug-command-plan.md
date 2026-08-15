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
- Preserve every hook run in JSON, but keep terminal output compact by showing the ten slowest runs plus any additional failed, timed-out, or aborted runs.
- Identify hook handlers with privacy-safe labels and ordinals. Do not persist full configured commands in diagnostic logs.
- Distinguish configured timeout, process exit, and final process/stream close timing so delayed descendant cleanup is visible.

## Scope

Included:

- session metadata, event counts, turn counts, tool counts, failures, subagent outcomes, and longest event gaps
- model, tool, hook, setup, and other timing percentages when scoped timing records exist
- per-tool and per-session timing tables
- per-hook run timing and outcome details, plus repeated-handler summaries
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

### Slice 4: Hook-run diagnostics

Status: `[x]` Done

- enrich compact `hook_run` records with handler ordinal, safe label, effective timeout, and process-exit timing
- preserve all hook runs in the JSON report and aggregate repeated handler/event combinations
- render the ten slowest hook runs plus every additional failed, timed-out, aborted, or spawn-failed run
- show how many successful runs were omitted from the text report
- add focused runtime, analyzer, formatter, and CLI JSON coverage
- update public CLI/session diagnostics documentation

Verification:

- `mise run test-node -- test/hooks.test.ts test/session-debug.test.ts test/cli.integration.test.ts` passed: 74 tests.
- `mise run local-ci` passed.
- `mise run test-node` passed: 613 tests in 38 files.
- `mise run package-check` passed; the packed native CLI installed and ran without Bun on `PATH`.
- `/Users/kodi/.local/bin/topchester-dev session debug latest` rendered the existing Gantempo session and its legacy hook records without errors.

Completed:

- Added monotonic hook timing with effective timeout, actual timeout/abort trigger, process exit, and final close-wait fields.
- Added privacy-safe handler labels and effective handler ordinals without logging full commands or arguments.
- Added complete JSON hook runs, repeated-handler summaries, duplicate lifecycle-handler warnings, and the compact ten-slowest-plus-all-unsuccessful text view.
- Added focused producer, analyzer, formatter, and CLI JSON coverage and updated public session, CLI, and changelog pages.

Dependencies: completed Slices 1-3 and existing session-scoped `hook_run` records.

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
- more than ten hook runs, with failures outside the slowest ten
- duplicate handlers created by canonical and compatibility-alias hook configuration
- sensitive arguments in configured hook commands
- a timeout that fires before the shell exits or inherited streams close

## Working Notes

- 2026-08-15: The observed Gantempo trace has `model_response.durationMs`, `tool_result.durationMs`, and `hook_run.durationMs`, but no session, turn, or tool-call identifiers. Concurrent root and child logs are therefore not safe to attribute exactly.
- 2026-08-15: Session `events.jsonl` emits tool-call rows after tool completion. Gaps between rows combine model wait, setup, hooks, and tool work, so event-only reports must label gaps as mixed time.
- 2026-08-15: The sandboxed full suite could not bind local HTTP fixtures. The same `mise run test-node` command passed outside the restricted sandbox.
- 2026-08-15: Gantempo session `01a0074d-1dac-7901-803b-2557199bd70e` spent 22.159 seconds in hooks. Two effective `Stop` handlers for `peon.sh` timed out and closed after 10.011 and 9.850 seconds, while `clankerlog-dev` completed in 1.868 seconds. The aggregate report did not identify the handlers or show the timeout-to-close delay.
- 2026-08-15: The effective Gantempo configuration contains both `Stop` and compatibility-alias `TaskComplete` Peon handlers. Alias normalization appends `TaskComplete` to `Stop`, so the same notification handler runs twice.

## Next Slice

No follow-up slice is queued. If live use exposes a hook whose descendants survive after the configured timeout, inspect process-group termination as a separate runtime-behavior change; this slice only makes that delay precise and visible.
