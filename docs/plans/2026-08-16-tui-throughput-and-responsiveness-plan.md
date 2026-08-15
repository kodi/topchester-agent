# TUI Throughput and Responsiveness Plan

## Summary

Improve Topchester's perceived responsiveness under long transcripts, streaming reasoning, tool-event bursts, and session persistence load without rewriting the product in Rust or replacing OpenTUI.

This plan covers the five agreed changes:

1. add a PTY and in-process performance harness with regression gates;
2. replace whole-transcript view publication with incremental transcript updates;
3. batch and coalesce non-input-critical view changes;
4. decouple durable session persistence from the visible runtime stream; and
5. drain runtime events in bounded batches while yielding priority to terminal input.

The work is ordered so every later optimization is measured by Slice 1 and preserves the current split-footer, native-scrollback, session, input, and failure contracts. Each slice should be independently reviewable and leave all existing tests passing.

## Decisions

- Keep Bun, Solid, and OpenTUI. OpenTUI 0.4.4 already uses a native Zig renderer and exposes native frame statistics; this project should remove application-level hot paths before considering a renderer or language change.
- Keep `screenMode: "split-footer"`, native terminal scrollback, `targetFps: 30`, mouse capture disabled, captured external output, and the existing terminal restoration behavior.
- Treat responsiveness as a pipeline concern: runtime event ingestion, state reduction, view publication, transcript commitment, persistence, and terminal painting must be measured separately.
- Do not treat model response time, provider latency, hook duration, or tool subprocess duration as renderer performance. Existing session timing diagnostics remain the source for those categories.
- Establish two performance-test layers:
  - deterministic in-process workload assertions for event counts, publication counts, transcript work, queue bounds, and ordering;
  - a real production-path PTY workload for input-to-paint latency, frame timing, cells/bytes changed, and terminal correctness.
- Do not invent final wall-clock thresholds before recording the first baseline on supported development and CI hosts. Slice 1 must record the observed distribution, choose a documented margin, and add the accepted budgets before it is marked done.
- Use monotonic, session-epoch-scoped transcript entry IDs. Do not derive renderer identity by serializing entry content.
- Give immediate publication to input-critical state: active dialog/choice changes, cancellation state, session transitions, submitted user messages, and completed stable transcript entries. Spinner, reasoning-tail, hook-progress, and similar cosmetic/transient changes may be frame-coalesced.
- Preserve ordered, crash-consistent JSONL session events. Persistence may move off the visible event path, but session switching, fork/restore boundaries, turn completion, and disposal must provide explicit durability barriers.
- Bound both event count and synchronous processing time per runtime batch. Yield to the host event loop between batches so OpenTUI can process input and paint requests before the full model/tool backlog drains.
- Keep all benchmark prompts, model responses, tool output, and transcript content out of performance artifacts. Store only scenario names, counts, durations, sizes, and aggregate percentiles.

## Scope

Included:

- OpenTUI production-path performance scenarios and machine-readable reports;
- performance regression budgets and repository commands;
- application-level counters that are disabled outside tests/explicit profiling;
- incremental transcript publication and append cursors;
- batched view-store transactions and frame-coalesced transient state;
- ordered asynchronous session journal writes, coalesced metadata writes, and explicit flush barriers;
- bounded runtime-event queues, host yielding, cancellation, and input-priority regression coverage;
- focused tests, full repository gates, and updates to this plan after every completed slice.

Out of scope:

- a Rust rewrite or a custom replacement for OpenTUI;
- an agent leader/daemon or ACP process split;
- changing the public TUI design, shortcuts, layout, or terminal-screen mode;
- optimizing provider, inference, hook, or subprocess latency;
- changing persisted session-event schemas or removing JSONL storage;
- adding user-visible performance telemetry;
- upgrading OpenTUI as part of these slices unless a currently pinned API is proven insufficient and the upgrade is planned separately;
- caching Markdown or diff render output beyond what incremental scrollback commitment already provides; add a follow-up slice only if the new measurements prove it necessary.

## Current State

Observed in the current checkout:

- `src/tui/opentui/renderer.tsx` creates the production renderer in split-footer mode at 30 FPS.
- The installed `@opentui/core` exposes `frameTimes`, average/min/max frame time, native render/write time, frame count, and updated-cell counts. Topchester does not currently collect those metrics in a product-specific workload.
- `scripts/opentui/production-test.tsx` provides strong in-memory production-component coverage, including split-footer geometry, resize behavior, dialogs, scrollback commitment, Markdown, and cleanup.
- `scripts/opentui/pty-smoke.ts` verifies the packaged native CLI through a real PTY, but it is a correctness smoke rather than a latency or throughput benchmark.
- `TuiViewStore.getSnapshot()` clones the full transcript on every publication. Every setter publishes independently, including transient spinner updates every 80 ms.
- `TopchesterApp` sends every snapshot to `TranscriptWriter.sync()`. The writer scans the full transcript and derives each identity with `JSON.stringify`, even when only footer status changed.
- `TranscriptWriter` correctly serializes stable scrollback commits and commits each accepted entry once. The replacement must retain this append-only split-footer behavior and settle-before-commit guarantee.
- `TopchesterTuiController.applyRuntimeEvents()` reduces and persists one runtime event at a time. The streaming loop awaits this work before consuming the next event.
- `SessionHandle.append()` already serializes overlapping callers, but every event performs a file `stat`, JSONL append, and complete metadata rewrite. Metadata failure truncates the JSONL file back to its prior size.
- `createRuntimeEventQueue()` stores events in an array and removes them with `shift()`. It has no batch-drain, queue-depth, backpressure, or host-yield contract.
- `mise run local-ci` is intentionally the fast format/lint/typecheck gate. Runtime, product, package, and PTY checks belong in dedicated tasks or `local-ci-extended`.

## Behavior To Preserve

- The prompt remains editable while the agent is working.
- Typed input, paste, Escape, Ctrl-C, dialog navigation, and session actions remain responsive and keep their current priority semantics.
- Stable transcript entries are written to native scrollback once; footer-only state never leaks into scrollback.
- Session restore, new, fork, queued follow-ups, steering, reasoning display, task plans, hook status, knowledge status, and bash approval retain their current visible and persistence behavior.
- Transcript order and session event IDs remain deterministic.
- A persistence failure produces readable user feedback and never leaves metadata claiming events that are not durable.
- Session switching cannot write old-session output into the new session or commit old-session transcript entries below the new boundary.
- Non-TTY/static output remains independent of the OpenTUI scheduler.
- Terminal restoration, signal behavior, `NO_COLOR`, responsive layouts, Markdown selection/copy, and captured stdout remain covered by their existing production tests.

## Target Data Flow

```text
runtime producer
      │
      ▼
bounded event buffer ── cancellation/session ownership
      │ max events + max synchronous slice
      ▼
batch reducer ───────────────► ordered persistence writer
      │                            │
      │ one semantic transaction  ├─ batched JSONL append
      ▼                            ├─ coalesced metadata write
incremental view change            └─ explicit durability barrier
      │
      ├─ immediate: input/dialog/session/stable entry
      └─ coalesced: spinner/reasoning/progress
      │
      ▼
OpenTUI split footer + append-only TranscriptWriter cursor
      │
      ▼
native Zig renderer/backpressure ──► terminal
```

## Cross-Slice Rules

- Slice 1 is the measurement contract. Every later slice must record its relevant before/after metrics in this plan rather than relying on subjective smoothness.
- Use deterministic fake runtime/model streams. Performance verification must not access the network or depend on a live provider.
- Keep correctness assertions separate from timing assertions. A fast but incorrect, reordered, dropped, duplicated, or undurable result fails.
- Do not gate regular CI on tight workstation timing. Gate stable algorithmic counts everywhere and run generous, documented PTY latency budgets only on the host classes established in Slice 1.
- Performance instrumentation must be injectable or explicitly enabled; normal sessions must not accumulate samples or write reports.
- Preserve current public and persisted types unless a slice explicitly introduces a private replacement and removes the old path within the same slice.
- Do not leave dual transcript or persistence paths after a slice. Compatibility adapters may exist only inside the slice and must be removed before it is marked done.
- Keep the worktree narrow. Update only the plan and the files named by the active slice, preserving unrelated changes.
- After completing a slice, update its status, actual files, measured results, verification commands, findings, and `Next Slice` in this document.

## Performance Contract

### Workloads

Slice 1 should create at least these deterministic scenarios:

1. `long-transcript-input`: seed 1,000 mixed transcript entries, update footer state, type into the composer, and verify the typed character becomes visible without rescanning or recommitting stable history.
2. `reasoning-flood`: publish a deterministic stream of reasoning/spinner updates while typing and cancelling.
3. `runtime-event-burst`: deliver at least 1,000 mixed status, tool, hook, task-plan, subagent, and message events with an input injection in the middle.
4. `scrollback-heavy-entry`: commit representative large Markdown, fenced code, and diff entries through the production `TranscriptWriter` path.
5. `persistence-burst`: append a deterministic event burst and verify event order, metadata, flush behavior, and write amplification.
6. `resize-and-dialog`: resize across 80x24, 120x40, and 200x60 while a transient stream and a modal are active.

### Metrics

Collect only aggregate, privacy-safe metrics:

- input injection to visible paint: p50, p95, p99, and max;
- JavaScript frame callback and total frame time;
- native render time and stdout write time when available;
- total frames, updated cells, unchanged/no-op frames, and scrollback commits;
- view publications and coalesced updates;
- transcript records inspected, serialized, scheduled, and committed;
- runtime batch count, maximum batch size, maximum queue depth, and host yields;
- session event count, JSONL write batches, metadata writes, flushes, and maximum pending persistence depth;
- correctness counters for dropped, duplicated, reordered, or cross-session events.

### Gate Policy

- Check in scenario definitions and accepted budget metadata, not raw terminal output or machine-specific absolute paths.
- Slice 1 records an initial baseline using the current implementation before optimization. The same harness remains runnable against later commits.
- Fail deterministic tests on contract/count regressions immediately.
- Establish PTY latency ceilings from repeated baseline runs on each supported gate host, with enough margin to tolerate normal CI variance. Record the chosen sample count and margin in this plan.
- Treat an unavailable native timing field as `unsupported`, not zero.
- Require an explicit `--update-baseline` or equivalent maintenance action; a normal test run must never rewrite accepted budgets.

## Checkpoint and Commit Strategy

Every slice is an intentional checkpoint and should receive its own focused Conventional Commit. The boundaries separate measurement, view-state identity, publication cadence, storage durability, and runtime fairness; combining adjacent slices would make regressions harder to attribute and rollback riskier.

Before each checkpoint commit:

- complete that slice's focused verification and `mise run local-ci`;
- run the relevant Slice 1 performance scenarios and record actual before/after findings in this plan;
- update the slice status, completed work, verification evidence, implications for later slices, and `Next Slice`;
- review `git status`, the scoped diff, and `git diff --check`;
- do not include an incomplete compatibility path or rely on the next slice to restore passing behavior.

Recommended checkpoints:

| After slice | Why this is a stable checkpoint                                                                                             | Suggested commit                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Slice 1     | Establishes tests, metrics, and accepted baselines without changing runtime behavior.                                       | `test(perf): add TUI responsiveness baselines`        |
| Slice 2     | Completes the transcript identity/cursor migration and removes the whole-history publication path.                          | `perf(tui): publish transcript changes incrementally` |
| Slice 3     | Completes view transactions and transient scheduling while leaving persistence behavior unchanged.                          | `perf(tui): coalesce noncritical view updates`        |
| Slice 4     | Completes the crash-consistent journal boundary; keep this independently revertible because it changes durability behavior. | `perf(session): batch durable journal writes`         |
| Slice 5     | Completes bounded event draining and fairness, then serves as the final implementation checkpoint.                          | `perf(runtime): drain agent events fairly`            |

Do not push automatically at these checkpoints unless the active implementation request also asks for a push. After Slice 5, run the broader final verification before treating the branch as complete; if that gate requires fixes, amend or add a narrowly scoped final fix commit rather than rewriting earlier checkpoint history.

## Implementation Slices

### Slice 1: Performance harness and baseline gates

Status: `[x]` Done

Goal: Create the measurement contract used to evaluate Slices 2–5 and capture the unoptimized baseline before behavior changes.

Why here: Without a stable workload and counters, later changes could trade correctness for lower counts or move latency between layers without improving input responsiveness.

This slice should implement:

- add a reusable OpenTUI performance scenario runner under `scripts/opentui/`;
- extend the existing fake-runtime/fake-API fixtures so workloads are deterministic and offline;
- reuse the production renderer configuration rather than maintaining a benchmark-only screen mode;
- collect OpenTUI renderer/native statistics and Topchester-owned counters through an explicit profiling interface;
- add a real PTY driver based on the existing PTY smoke approach, excluding build/install time from steady-state measurements;
- emit a versioned JSON report plus a compact human summary;
- add accepted budget metadata and an explicit baseline-update workflow;
- add `mise run opentui-perf` and keep it separate from `local-ci`;
- decide, from measured stability, which PTY scenarios join `local-ci-extended` or a dedicated CI job;
- record the initial metrics, host details, sample count, variance, and accepted margins in this plan.

Expected output:

- new scenario, metrics, report, and budget modules under `scripts/opentui/`;
- focused fixtures/tests for percentile calculation, report stability, unsupported metrics, and budget comparisons;
- a repository task that produces the same schema in human and JSON modes;
- a baseline findings entry in this plan.

Verification:

- `mise run opentui-test`;
- `mise run opentui-perf`;
- repeat `mise run opentui-perf` enough times to document variance and choose budgets;
- `mise run local-ci`;
- `git diff --check`.

Dependencies: Current OpenTUI production test and PTY smoke paths.

Completed in this slice:

- added `mise run opentui-perf`, six deterministic offline workloads, a versioned JSON/human report, explicit baseline updates, accepted deterministic budgets, and focused percentile/budget tests;
- added opt-in profiling seams for view publication/transcript inspection, scrollback work, runtime queue depth, and session write amplification; normal product sessions allocate none of these counters;
- added renderer-backed scrollback and resize/dialog scenarios using split-footer/captured-output configuration, including native frame statistics when OpenTUI reports them;
- added a real source-CLI PTY driver backed by the deterministic local fake API. Build and install time are excluded, and terminal restoration remains owned by `opentui-pty-smoke` rather than the timing harness;
- kept the deterministic harness separate from `local-ci`; the PTY timing layer remains opt-in because only the Darwin arm64 host class has an accepted baseline.

Baseline and budgets (2026-08-16, Darwin arm64, Bun 1.3.2):

- deterministic scenarios use five samples per run. Repeated runs put `scrollback-heavy-entry` p95 between 144 and 176 ms and `persistence-burst` p95 between 145 and 191 ms; timing is reported but deterministic counters are the cross-host gate;
- the five-sample PTY input-to-visible-paint baseline was p50 14,743 ms, p95/p99/max 14,768 ms. Repeated pre-teardown runs stayed within 14,077-14,775 ms;
- the accepted Darwin arm64 PTY p95 ceiling is 20,000 ms, roughly 35% above the observed baseline. Other host classes report timing as unsupported for gating until a host-specific baseline is accepted;
- initial count baselines include 240,000 transcript inspections for a 240-update reasoning flood, 61,000 inspections for resize/dialog transient updates, 1,000 single-event runtime batches with queue depth 1,000 and no host yields, and 1,000 JSONL plus 1,000 metadata writes for a 1,000-event persistence burst;
- renderer-backed sampling reported native frame-time distributions plus native render/write time where supported. A representative scrollback run reported 5 frames, 960 updated cells, 0.10 ms frame p50, 0.18 ms frame p95, and 19 ms native render time.

Verification:

- `mise run opentui-test` (pass);
- `mise run opentui-perf` (pass);
- `mise run opentui-perf -- --pty` (pass, loopback bind requires host permission in the sandbox);
- `mise run test-node -- test/opentui-performance.test.ts` (3 tests pass);
- `mise run local-ci` (pass after scoped formatting);
- `git diff --check` (pass).

Implication for later slices: update the accepted deterministic counters only when the corresponding production path intentionally changes. Do not weaken correctness counters. Preserve the Darwin arm64 PTY ceiling through Slices 2-5 and record unsupported host timing explicitly.

Completion evidence to record:

- exact commands and host classes;
- baseline metrics for every workload;
- accepted deterministic and timing budgets;
- whether the timing gate runs in `local-ci-extended`, a dedicated CI job, or both.

### Slice 2: Incremental transcript publication and append cursors

Status: `[x]` Done

Goal: Make footer-only updates independent of transcript length and eliminate content serialization as the transcript identity mechanism.

Why here: The current full transcript clone and scan is the clearest application-level cost, and removing it gives later batching and event-drain work a stable incremental contract.

This slice should implement:

- introduce a private transcript record with a monotonic ID scoped to `sessionEpoch`;
- make `TuiViewStore` retain immutable transcript records without cloning the full record array for every unrelated snapshot;
- publish an explicit transcript change shape: append records, remove uncommitted active choice, or reset/replay;
- give `TranscriptWriter` an epoch plus append cursor and process only newly appended stable records;
- remove the `scheduled` identity set and `JSON.stringify(entry)` key generation once cursor parity is proven;
- define reset behavior for new, fork, and restore sessions while scrollback commits are pending;
- keep active choices/dialogs out of stable scrollback and preserve the existing session-boundary row;
- update controller, static-view, conversation projection, and tests to consume the private record boundary without changing public/persisted transcript payloads;
- add invariant tests for duplicate publications, choice removal, session reset, pending commits, and a 1,000-entry footer-only update.

Expected output:

- incremental transcript change types owned by the renderer-neutral chat/view layer;
- an append-cursor `TranscriptWriter` with no whole-history scan on footer updates;
- measured transcript inspection/serialization counts independent of existing history length.

Verification:

- `mise run test-node -- test/tui-controller.test.ts test/opentui-state.test.ts`;
- `mise run opentui-test`;
- `mise run opentui-perf -- --scenario long-transcript-input`;
- `mise run local-ci`;
- `git diff --check`.

Dependencies: Slice 1 metrics and baseline.

Completed in this slice:

- added immutable, epoch-scoped transcript records with monotonic record IDs and explicit `none`, `append`, `remove`, and `reset` publication changes while preserving the existing `TranscriptEntry` view and persisted payloads;
- made footer-only snapshots reuse both transcript arrays and publish `none`, so view publication no longer clones or inspects stable history;
- replaced serialized transcript identity and the scheduled-key set with `TranscriptAppendCursor`, which consumes only initial/reset replay records or newly appended records;
- moved initial writer replay to mount and sends later controller publications directly to the writer so Solid signal coalescing cannot hide appends;
- retained choice exclusion, settle-before-commit, session-boundary rows, and epoch checks before work, after settle, and during failure reporting so abandoned-session scrollback cannot commit or fail into the new session;
- migrated production/performance fixtures to create coherent transcript records and changes.

Measured result (2026-08-16, Darwin arm64, Bun 1.3.2):

- after a 1,000-record initial replay, the footer-only long-transcript step changed from 2,000 transcript inspections to 0 inspections, 0 serializations, and 0 scheduled commits;
- appending one stable record schedules one scrollback commit; an intervening removed choice advances identity without entering scrollback;
- `mise run opentui-perf -- --scenario long-transcript-input` reported p50 0.07 ms and p95/max 0.11 ms in the integration run. The full performance suite retained all accepted correctness budgets.

Verification:

- `mise run test-node -- test/tui-controller.test.ts test/opentui-state.test.ts` (2 files, 20 tests pass);
- `mise run opentui-test` (pass, including duplicate publication, choice exclusion, pending reset, and new-epoch commit coverage);
- `mise run opentui-perf -- --scenario long-transcript-input --output /tmp/topchester-slice2-long-transcript.json` (pass);
- `mise run test` (39 files, 617 tests pass, plus production OpenTUI test);
- `mise run local-ci` (pass);
- `git diff --check` (pass).

Implication for later slices: batching and transient coalescing must preserve the explicit transcript change carried by a transaction. A stable append or reset must never be overwritten by a later footer patch before publication.

Acceptance criteria:

- after initial replay, a footer-only update inspects and serializes zero historical transcript entries;
- appending one stable entry schedules exactly one new scrollback commit;
- session reset cannot commit an old-session entry after the new session boundary;
- visible output and persisted session payloads remain unchanged.

### Slice 3: Batched view transactions and transient coalescing

Status: `[x]` Done

Goal: Publish one coherent semantic view change per controller operation and cap transient view-publication work to the display cadence.

Why here: Incremental transcript publication first removes history-dependent work; batching can then reduce publication frequency without hiding transcript-reset or append semantics.

This slice should implement:

- add nested-safe `TuiViewStore.batch()` or an equivalent reducer transaction that emits once after all synchronous patches;
- make a transaction either complete and publish or leave the prior state intact when its reducer throws;
- reduce one `applyRuntimeEvents(events)` call into one coherent state transaction while preserving runtime-event order;
- combine busy start/stop, cancelability, prompt hints, queued state, task-plan notice, and dialog transitions where they currently emit intermediate frames;
- add an injectable frame-coalescing scheduler for spinner, reasoning-tail, hook-progress, and similar transient state;
- use the same 30 FPS cadence contract as the production renderer, without coupling the framework-neutral controller to OpenTUI types;
- flush or cancel pending coalesced work on stable transcript append, dialog open, cancellation, session switch, and disposal;
- leave composer editing and OpenTUI-local cursor/selection behavior immediate;
- add fake-clock tests for nested batching, timer cleanup, immediate-state bypass, final-state delivery, and no post-dispose publication.

Expected output:

- a transaction-capable view store;
- a small injectable transient-publication scheduler;
- fewer publications and frames during spinner/reasoning workloads with identical final state.

Verification:

- `mise run test-node -- test/tui-controller.test.ts test/opentui-state.test.ts`;
- `mise run opentui-test`;
- `mise run opentui-perf -- --scenario reasoning-flood --scenario resize-and-dialog`;
- `mise run local-ci`;
- `git diff --check`.

Dependencies: Slices 1 and 2.

Completed in this slice:

- added nested-safe, rollback-capable `TuiViewStore.batch()` transactions with a transaction-local transcript-change accumulator, so a batch publishes at most once without replaying a previously published append/reset;
- canonicalized reset/append/remove combinations inside a transaction and deferred temporary-line timer changes until commit, preserving both state and existing timer behavior when a reducer throws;
- added an injectable framework-neutral transient scheduler paced at the production 30 FPS cadence, with optional profiling for updates replaced before publication;
- moved spinner/reasoning-tail and hook-progress updates onto the transient scheduler while keeping stable transcript, dialog, cancellation, and session mutations immediate;
- batched runtime-event reduction, chat/check/skill busy transitions, cancellation state, prompt hints, queued state, dialog transitions, and paired error/status changes into coherent publications;
- added fake-scheduler/fake-time coverage for nested rollback, timer cleanup, immediate bypass, final delivery, disposal, hook bursts, and chat start publication counts.

Measured result (2026-08-16, Darwin arm64, Bun 1.3.2):

- `reasoning-flood` reduced 240 transient updates from 240 publications to 9 publications, with 232 pending updates replaced before publication; the integration rerun reported p50 0.09 ms and p95/max 0.14 ms;
- `resize-and-dialog` reduced 60 transient updates plus the dialog transition from 61 publications to 3, with 58 pending updates replaced; the integration rerun reported p50 36.58 ms and p95/max 37.19 ms;
- both workloads retained zero transcript-history inspections and their accepted input, cancellation, resize, dialog, and renderer correctness counters.

Verification:

- `mise run test-node -- test/tui-controller.test.ts test/opentui-state.test.ts test/opentui-performance.test.ts` (3 files, 32 tests pass);
- `mise run opentui-test` (pass);
- `mise run opentui-perf -- --scenario reasoning-flood --scenario resize-and-dialog` (pass);
- `mise run local-ci` (pass);
- `git diff --check` (pass).

Implication for later slices: persistence enqueue/failure feedback and bounded event draining should enter the view through one transaction per semantic batch. Durability barriers and host-yield callbacks must not defer input-critical view changes behind the transient scheduler.

Acceptance criteria:

- one synchronous controller operation produces at most one immediate publication;
- transient-only floods publish no faster than the configured cadence, plus a final flush;
- dialog, cancel, session, and stable-entry changes are not delayed behind the transient scheduler;
- input-to-paint and frame-count metrics do not regress from the Slice 2 checkpoint.

### Slice 4: Asynchronous session journal writer and durability barriers

Status: `[x]` Done

Goal: Remove routine filesystem latency and metadata write amplification from runtime event consumption while preserving ordered crash-consistent sessions.

Why here: Once view publication is efficient, awaited per-event storage becomes the next avoidable serialization point. This slice must land before the event consumer is allowed to drain larger batches.

This slice should implement:

- extract a session journal writer owned by each `SessionHandle`;
- accept ordered payloads into a bounded queue and assign event IDs in queue order;
- append multiple ready JSONL events in one write where possible;
- write metadata once per durable batch while preserving title derivation, `updatedAt`, and `lastEventId` semantics;
- retain batch rollback: if metadata commit fails, truncate JSONL to the size before that batch and leave in-memory metadata unchanged;
- expose explicit `flush()`/durability barriers and call them at turn completion, session switch, new/fork/restore boundaries, and disposal;
- apply high-water backpressure only when the bounded persistence queue fills, rather than awaiting every routine event;
- surface one readable failure through the controller, reject the relevant barrier, and define whether subsequent writes may retry or the writer becomes terminally failed;
- make fork/restore and debug readers observe only durable state;
- add failure-injection tests for batched append failure, metadata failure, rollback, queue saturation, flush, disposal, and concurrent callers;
- measure JSONL and metadata write amplification in `persistence-burst`.

Expected output:

- an ordered, bounded session journal writer behind `SessionHandle`;
- controller persistence enqueue and durability-barrier helpers;
- fewer metadata writes than events during a burst, with unchanged reloaded session state.

Verification:

- `mise run test-node -- test/session.test.ts test/tui-controller.test.ts test/session-debug.test.ts`;
- `mise run opentui-test`;
- `mise run opentui-perf -- --scenario persistence-burst --scenario reasoning-flood`;
- `mise run local-ci`;
- `git diff --check`.

Dependencies: Slice 1 for write-amplification metrics and Slice 3 for coherent controller failure publication.

Completed in this slice:

- replaced the per-event append chain with an ordered per-`SessionHandle` journal that admits at most 128 non-durable events, assigns IDs in admission order, and applies FIFO backpressure only at the high-water mark;
- batch-appends up to 128 JSONL events and commits metadata once per durable batch while preserving title derivation, timestamps, and `lastEventId` semantics;
- made a write/stat/metadata failure terminal for that handle, rolls JSONL back to the pre-batch byte offset when possible, and preserves both the write and rollback failures when rollback itself fails;
- added watermark-based `flush()` and draining `dispose()` barriers; retained durable `append()` compatibility as enqueue plus flush;
- changed routine controller persistence to enqueue without awaiting filesystem durability, awaiting only a returned saturation promise, and deduplicated terminal failure feedback once per session handle;
- added ownership cutoffs and source flush barriers for new/fork/restore, plus initialization, turn/background completion, `waitForIdle`, debug-read, and disposal barriers so late old-session work cannot enter a replacement session;
- added deterministic batching, saturation, reload, JSONL/stat/metadata failure, rollback, disposal, concurrent ordering, transition failure/recovery, and debug-after-flush coverage.

Measured result (2026-08-16, Darwin arm64, Bun 1.3.2):

- `persistence-burst` reduced 1,000 JSONL appends and 1,000 metadata rewrites to 8 JSONL batches and 8 metadata writes for 1,000 ordered events;
- maximum accepted non-durable depth is now gated at 128, one explicit flush completes the workload, and dropped/duplicated/reordered/cross-session counters remain zero;
- the integration rerun reported p50 4.64 ms and p95/max 5.06 ms, compared with the Slice 1 persistence p95 range of 145-191 ms.

Verification:

- `mise run test-node -- test/session.test.ts test/tui-controller.test.ts test/session-debug.test.ts test/opentui-performance.test.ts` (4 files, 68 tests pass);
- `mise run opentui-test` (pass);
- `mise run opentui-perf -- --scenario persistence-burst --scenario reasoning-flood` (pass);
- `mise run local-ci` (pass);
- `git diff --check` (pass).

Implication for Slice 5: runtime consumers may enqueue a whole reducer batch without routine filesystem waits, but must conditionally await the journal's saturation promise and flush at the existing turn/session/disposal barriers. Queue cancellation must unblock a producer waiting on persistence backpressure without transferring ownership to a replacement session.

Acceptance criteria:

- durable reload returns ordered, gap-free event IDs and correct metadata;
- a failed metadata write cannot leave extra durable JSONL events;
- session transition/disposal waits for the relevant durability barrier;
- routine runtime event consumption does not await one metadata rewrite per event;
- queue depth is bounded and saturation backpressure is covered deterministically.

### Slice 5: Bounded runtime-event draining with input priority

Status: `[ ]` Not started

Goal: Consume model, tool, hook, and subagent bursts efficiently without starving keyboard handling, painting, cancellation, or session transitions.

Why here: Removing per-event persistence waits can expose a tight ready-promise loop. This final slice deliberately adds throughput while retaining host yields and the bounds measured by all prior slices.

This slice should implement:

- replace array `shift()` queues with an O(1) head-index/ring-buffer implementation;
- add bounded queue capacity, producer backpressure, queue-depth metrics, close/error propagation, and batch drain;
- adapt `submitMessageStream()` consumption through a producer/consumer boundary that can collect ready events without blocking terminal work;
- cap each reducer batch by both event count and synchronous elapsed time;
- yield through an injectable host scheduler between batches so Bun/OpenTUI input and render callbacks can run;
- process each batch through the Slice 3 view transaction and enqueue persistence through Slice 4;
- preserve exact event order, task/subagent ordering, approval pauses, steering, cancellation, and active-session ownership;
- stop or discard the old-session producer safely on session switch/disposal;
- ensure immediate user actions do not wait for the remaining event backlog;
- add deterministic flood tests that inject typing, Escape/cancel, and a dialog action midway through the backlog and assert they are observed before complete drain;
- tune the initial count/time bounds from Slice 1 measurements, record the chosen values here, and avoid environment-specific magic constants.

Expected output:

- a reusable bounded async batch queue;
- a controller runtime-stream consumer with explicit fairness and cancellation contracts;
- improved event throughput with bounded input-to-paint latency under flood.

Verification:

- `mise run test-node -- test/agent-runtime.test.ts test/tui-controller.test.ts test/opentui-state.test.ts`;
- `mise run opentui-test`;
- `mise run opentui-perf -- --scenario runtime-event-burst --scenario reasoning-flood`;
- `mise run local-ci`;
- `git diff --check`.

Dependencies: Slices 1–4.

Acceptance criteria:

- no event is dropped, duplicated, reordered, or applied to the wrong session;
- the queue never exceeds its configured bound;
- the reducer never exceeds its accepted event/time slice without yielding;
- injected input is handled and visibly painted before the entire flood drains;
- cancellation and disposal terminate the producer and unblock all waiters;
- performance budgets pass without weakening correctness assertions.

## Expected File Impact

Likely files to add:

- `scripts/opentui/performance-test.tsx`
- `scripts/opentui/pty-perf.ts`
- `scripts/opentui/pty-perf.exp`
- `scripts/opentui/performance/` modules for scenarios, metrics, reports, and budgets
- focused test helpers for fake clocks, counters, and failure-injected storage

Likely files to change:

- `.mise.toml`
- `package.json` only if a repository script is preferable to direct Bun execution
- `src/chat/controller-state.ts`
- `src/chat/controller.ts`
- `src/chat/controller-busy.ts`
- `src/tui/opentui/app.tsx`
- `src/tui/opentui/transcript-writer.tsx`
- `src/tui/opentui/renderer.tsx` only to share configuration/profiling seams, not to replace OpenTUI scheduling
- `src/agent/runtime/event-queue.ts`
- `src/agent/runtime/index.ts`
- `src/session/store.ts`
- `test/tui-controller.test.ts`
- `test/opentui-state.test.ts`
- `test/agent-runtime.test.ts`
- `test/session.test.ts`
- `scripts/opentui/production-test.tsx`

Exact paths may change after Slice 1 establishes the smallest reusable harness boundary. Record any changes in the active slice before implementation expands scope.

## Edge Cases

- an empty transcript and a restored transcript with thousands of entries;
- identical transcript entries that must still receive distinct identities;
- removal of an uncommitted active choice;
- session reset while a scrollback surface is settling or a persistence batch is pending;
- late events from an abandoned session or aborted runtime producer;
- subscriber removal or nested state batching during publication;
- a transient update queued immediately before a dialog, cancel, or stable message;
- timer and host-yield callbacks firing after disposal;
- a persistence queue that fills while the terminal remains interactive;
- JSONL append succeeds but metadata write fails;
- partial/batched write failure and rollback to the correct byte offset;
- fork or restore requested before the current durability barrier finishes;
- terminal resize or stdout capture while frames are backpressured;
- metrics unsupported on one platform or timing fields reported as invalid;
- CI host contention producing timing outliers;
- non-TTY execution, where no OpenTUI frame scheduler exists;
- `NO_COLOR`, Markdown/code selection, and Unicode cell widths;
- errors thrown inside one runtime-event reduction batch;
- cancellation while a producer waits for queue capacity or a consumer waits for events.

## Final Verification

After Slice 5:

1. Run all focused state, runtime, session, and OpenTUI tests named by the slices.
2. Run `mise run opentui-perf` and compare every scenario with the accepted Slice 1 baseline/budgets.
3. Run `mise run local-ci-extended`.
4. Run `git diff --check`.
5. Exercise the live development wrapper in a real terminal with:
   - a long restored session;
   - streamed reasoning;
   - several concurrent tool/subagent events;
   - typing, paste, resize, cancellation, and a dialog during activity;
   - session switch followed by exit and restore.
6. Inspect the resulting session with `topchester session debug latest` to confirm renderer work did not get misclassified as model, tool, or hook latency and that persistence remains complete.

The final handoff must state measured before/after results, any unsupported host metrics, and any verification that remained manual.

## Open Questions

- Which development and CI host classes produce stable enough PTY timings for an enforced wall-clock budget? Resolve in Slice 1 from repeated measurements.
- Should the real PTY timing gate run on every `local-ci-extended`, in one dedicated CI job, or both? Resolve in Slice 1 based on runtime and variance.
- What queue capacity, maximum event batch, and maximum synchronous time slice provide the best fairness/throughput tradeoff? Measure in Slice 1 and finalize in Slice 5.
- Should a session journal writer retry after a failed batch or become terminally failed until session replacement? Decide in Slice 4 before implementing failure recovery.
- Does OpenTUI's current stats surface expose enough output-byte information, or should the PTY harness count emitted bytes externally? Resolve in Slice 1 without patching OpenTUI.

## Working Notes

- 2026-08-16: Grok Build was used as an architectural reference. The transferable ideas are bounded message draining, input-aware fairness, one coherent presentation request, cached/incremental scrollback work, asynchronous terminal/persistence I/O, and PTY percentile benchmarks. Its Rust language and leader process are not prerequisites for this plan.
- 2026-08-16: Topchester already owns the correct renderer-level foundation: OpenTUI's native Zig renderer, split-footer mode, native scrollback surfaces, target frame pacing, and backpressure. The initial optimization target is the TypeScript application pipeline above that renderer.
- 2026-08-16: Existing production-frame regressions prove component-only tests are insufficient. The performance harness must retain a real production/PTY path in addition to deterministic counters.
- 2026-08-16: Slice 1 established the first measured baseline. The roughly 14.7-second PTY input-to-paint result exposes the existing settle/publication pipeline cost and is intentionally retained as the before value rather than normalized away.
- 2026-08-16: Slice 2 removed transcript-length-dependent footer work. The writer now owns an epoch-scoped cursor, while the public and persisted transcript entry shapes remain unchanged.
- 2026-08-16: Slice 3 made semantic view changes atomic and capped cosmetic publication to the renderer cadence. The accepted workloads now gate both publication counts and the number of transient replacements.
- 2026-08-16: Slice 4 established a terminal-on-failure, bounded session journal. A 1,000-event burst is durable in eight JSONL/metadata batches, and session boundaries now stop on failed source barriers instead of reading or switching past them.

## Next Slice

Start Slice 5. Replace the shift-based runtime queue with a bounded FIFO batch queue, then consume runtime streams through count- and time-limited reducer batches with an injectable host yield. Preserve approval, steering, cancellation, and session ownership while proving injected input is handled before a 1,000-event backlog finishes.
