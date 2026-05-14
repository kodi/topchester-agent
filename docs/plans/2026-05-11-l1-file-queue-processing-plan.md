# L1 File Queue Processing Plan

## Summary

Implement the next Knowledge Compiler step after inventory queue creation: read `.agents/topchester-kb-cache/l1-queue.json`, process every queued file, and write one current L1 file entry per in-scope file into `topchester-kb/l1-files/`.

The target state is that `topchester kb compile` does not stop at "L1 file queue is ready"; it ingests the queue, calls the configured KB model, validates output, updates durable queue state, and leaves the KB with complete L1 coverage.

## Decision

- Use the existing implemented folder name `topchester-kb/l1-files/` for L1 entries. `docs/KNOWLEDGE.md` still shows an older draft path of `topchester-kb/files/`, but current code and `docs/cli.md` use `l1-files/`.
- Reuse `ModelGateway.generateText()` with purpose `kb.summarize` for V0 L1 summaries.
- Keep deterministic fields trusted by code, not by the model: `id`, `path`, `content_hash`, `size_bytes`, `last_scanned_at`, and `scan_status`.
- Treat hash mismatches conservatively. If a queued file changed before processing, mark it changed instead of writing a current entry from stale queue metadata.

## Scope

Included:

- L1 queue schema and status lifecycle.
- L1 file entry TypeScript types and Zod validation.
- Safe path-to-entry filename encoding.
- Single-file L1 prompt/build/parse/validate flow.
- Durable queue processing with resume behavior.
- Manifest count/status updates.
- CLI and slash command wiring for `kb compile`.
- Tests using fake model output.
- `docs/cli.md` update when command behavior changes.

Not included:

- L2 module discovery.
- L3 feature discovery.
- Graph edge generation.
- JSON-RPC KB service.
- MCP adapter.
- Full drift API.
- Advanced TypeScript language-server or tree-sitter extraction.

## Current State

- `src/knowledge/compiler/index.ts` creates `.agents/topchester-kb-cache/l1-queue.json` and `topchester-kb/manifest.json`.
- `src/knowledge/compiler/inventory.ts` lists workspace files, reads `.gitignore`, skips generated/vendor/cache folders, skips binary files, and computes `sha256:` hashes.
- `src/knowledge/init.ts` creates `topchester-kb/l1-files/`, `l2-modules/`, `l3-features/`, `graph/`, and `reviews/`.
- Queue items currently have `id`, `path`, `sizeBytes`, `hash`, and `status: "queued"`.
- `ModelGateway` already supports `kb.scan` and `kb.summarize`.
- `compileKnowledgeBase()` only receives `workspaceRoot`; it does not yet receive `modelGateway`.
- Slash command context currently only has `workspaceRoot`, so `/kb compile` cannot call a KB model yet.

## Behavior To Preserve

- `topchester kb init` remains the setup command for project KB folders.
- `topchester kb reset` still deletes the configured KB and cache paths safely.
- `topchester kb status` remains a cheap path/status check.
- Inventory still respects `.gitignore`, binary skipping, and generated folder exclusions.
- V0 remains advisory/non-strict about broader KB drift.

## Recommended Approach

Add an L1 ingestion module under the Knowledge Compiler, then make `compileKnowledgeBase()` run inventory and ingestion as one pipeline.

Implementation shape:

1. Inventory creates the queue as it does today.
2. L1 processor reads the queue from cache.
3. For each queued item:
   - recompute file stat/hash,
   - skip valid existing entry when hash matches,
   - read file content,
   - build a JSON-only L1 prompt,
   - call `modelGateway.generateText({ purpose: "kb.summarize" })`,
   - parse and validate model JSON,
   - overwrite deterministic fields from trusted queue/current file data,
   - write `topchester-kb/l1-files/<source/path>.json`,
   - persist queue item status after each file.
4. Manifest records queued/completed/failed/changed counts.

## Data Flow

```text
workspace files
  -> inventory scan
  -> .agents/topchester-kb-cache/l1-queue.json
  -> L1 processor
  -> topchester-kb/l1-files/*.json
  -> topchester-kb/manifest.json
```

## Edge Cases

- File changed after queue creation: mark item `changed`, do not write a `current` L1 entry.
- File missing after queue creation: mark item `missing_file`.
- Model returns invalid JSON: mark item `failed` with error metadata and continue.
- Existing L1 entry matches hash and validates: mark item `completed` without another model call.
- Existing L1 entry is invalid or stale: regenerate it.
- Very large text file: V0 can fail clearly or use a capped/chunked prompt, but it must not silently write a weak entry as current.
- Path encoding collision: detect and fail clearly instead of overwriting another file entry.

## Cross-Slice Rules

- Keep queue state durable after every processed file.
- Do not trust the model for file identity, hashes, timestamps, or scan status.
- Keep L1 coverage at 100% for in-scope files before later L2/L3 work starts.
- Prefer small, testable helpers over one large compiler function.
- Any CLI behavior change must update `docs/cli.md` in the same implementation slice.

## Files to Add

- `src/knowledge/compiler/l1.ts`
- `src/knowledge/compiler/l1-entry.ts`
- `src/knowledge/compiler/path-encoding.ts`
- `test/knowledge-l1-processor.test.ts`

## Files to Change

- `src/knowledge/compiler/index.ts`
- `src/cli.ts`
- `src/agent/commands.ts`
- `test/knowledge-compiler.test.ts`
- `test/commands.test.ts`
- `test/cli.integration.test.ts`
- `docs/cli.md`

## Slice 1: L1 Contracts and Path Encoding

Status: `[x]` Completed

### Goal

Define the durable queue and L1 entry contracts before adding model calls.

### Why here

The processor needs stable data shapes, statuses, and output paths before queue ingestion can be safe or testable.

### This slice should implement

- Add L1 queue file and queue item types.
- Add queue statuses: `queued`, `in_progress`, `completed`, `failed`, `changed`, `missing_file`.
- Add L1 file entry schema/type with the fields from `docs/KNOWLEDGE.md`.
- Add safe path-mapping helper for writing mirrored entries under `topchester-kb/l1-files/`.
- Add collision tests for mirrored paths.

### Expected output

- Typed queue and L1 entry helpers exist.
- Invalid L1 entries fail validation.
- File paths map to stable KB entry filenames.

### Verification

```bash
pnpm test test/knowledge-l1-processor.test.ts
pnpm typecheck
```

Completed in Slice 1 with focused schema/path tests, `pnpm test test/knowledge-l1-processor.test.ts`, `pnpm typecheck`, and `pnpm format-check`.

### Dependencies

None.

## Slice 2: Single-File L1 Processing

Status: `[x]` Completed

### Goal

Process one queued file into one validated L1 entry using a fake model in tests.

### Why here

Single-file ingestion proves the core model/parse/validate/write path before adding full queue lifecycle complexity.

### This slice should implement

- Add prompt builder for one L1 file entry.
- Add JSON extraction/parsing for model text.
- Add `processL1QueueItem()` or equivalent helper.
- Force deterministic fields after model parsing.
- Write the L1 entry JSON to `topchester-kb/l1-files/`.
- Add tests with a fake `generateText()` implementation.

### Expected output

- One queued file can become one L1 JSON file.
- The written entry has trusted hash/path/size fields even if the model omits or changes them.

### Verification

```bash
pnpm test test/knowledge-l1-processor.test.ts
pnpm typecheck
```

Completed in Slice 2 with a focused single-file L1 processor, fake-model tests for valid output, deterministic field overrides, JSON wrapper extraction, invalid/ambiguous/empty output, changed/missing files, oversized files, sanitized failure metadata, `pnpm test test/knowledge-l1-processor.test.ts`, and `pnpm typecheck`.

### Dependencies

Slice 1.

## Slice 3: Durable Queue Processing and Resume

Status: `[x]` Completed

### Goal

Process the full queue, update item statuses after each file, and support resume/idempotency.

### Why here

Full queue processing should be crash-safe before it is wired into the user-facing compile command.

### This slice should implement

- Add `processL1Queue()` for the whole queue file.
- Mark items `in_progress`, then `completed`, `failed`, `changed`, or `missing_file`.
- Persist queue state after each item.
- Skip valid existing entries whose `content_hash` matches the queued/current hash.
- Continue after per-file failures and return a summary.
- Update `manifest.json` with L1 counts and status.

### Expected output

- A queue can be resumed after partial completion.
- Failures are visible in queue state.
- Manifest reflects queued/completed/failed/changed counts.

### Verification

```bash
pnpm test test/knowledge-l1-processor.test.ts test/knowledge-compiler.test.ts
pnpm typecheck
```

Completed in Slice 3 with durable full-queue processing, per-item queue persistence, resume/idempotency for current and in-progress items, stale entry regeneration, manifest L1 counts, generated artifact exclusion for default/configured paths, orphan L1 entry cleanup, persisted queue validation, empty-workspace coverage, targeted tests, and `pnpm typecheck`.

### Dependencies

Slice 2.

## Slice 4: CLI and Slash Command Wiring

Status: `[x]` Completed

### Goal

Make `topchester kb compile` and `/kb compile` run L1 ingestion, not just queue creation.

### Why here

The processor should be proven by tests before it becomes the default user-facing behavior.

### This slice should implement

- Change `compileKnowledgeBase()` options to accept a model gateway or summarizer dependency.
- Pass `context.modelGateway` from `src/cli.ts`.
- Expand slash command context so `/kb compile` can access the model gateway.
- Update progress messages and formatted compile result.
- Update command tests and CLI integration tests.
- Update `docs/cli.md` to describe L1 ingestion behavior.

### Expected output

- CLI compile reports queued, completed, failed, and changed counts.
- Slash command compile uses the same pipeline.
- Command docs match behavior.

### Verification

```bash
pnpm test test/commands.test.ts test/cli.integration.test.ts test/knowledge-compiler.test.ts test/knowledge-l1-processor.test.ts
pnpm typecheck
```

Completed in Slice 4 with CLI and slash command model-backed L1 compile wiring, L1 outcome summaries, partial exit semantics, missing setup/model failure coverage, slash command suggestions/progress wording, `docs/cli.md` updates, and the assigned Slice 4 validators.

### Dependencies

Slice 3.

## Slice 5: End-to-End Compile Check on a Small Repo

Status: `[x]` Completed

### Goal

Run the complete L1 compile path against a small real workspace and harden obvious usability issues.

### Why here

Unit tests prove mechanics, but a real small repo catches prompt size, path, manifest, and progress issues.

### This slice should implement

- Run `topchester-dev --config config/gemini.yaml --workspace ~/data/github/clsx --dev disable-kb-check-modal kb compile`.
- Inspect a few generated L1 entries for schema shape and useful summaries.
- Tighten prompt or validation if outputs are too vague or invalid.
- Record any remaining non-blocking limitations as follow-up slices.

### Expected output

- The `clsx` workspace has one L1 entry per queued file.
- Queue and manifest show completed L1 state or clear per-file failures.

### Verification

```bash
topchester-dev --config config/gemini.yaml --workspace ~/data/github/clsx --dev disable-kb-check-modal kb compile
pnpm check
```

Completed in Slice 5 with the real clsx compile validation, generated L1 entry/count inspection, rerun stability checks, and final `pnpm check`.

### Dependencies

Slice 4 and a configured KB model/API key.

## Slice 6: Cleanup and Documentation Alignment

Status: `[x]` Completed

### Goal

Remove naming ambiguity and leave the compiler ready for L2/L3 slices.

### Why here

Once L1 processing works, docs and naming should stop disagreeing before later compiler stages depend on them.

### This slice should implement

- Decide whether `docs/KNOWLEDGE.md` should keep draft `files/` naming or switch to implemented `l1-files/`.
- Update docs only where behavior is now real.
- Add follow-up notes for L2 module discovery inputs available from L1 entries.

### Expected output

- User-facing docs and implementation agree about L1 entry location.
- Future L2/L3 work has a clean handoff.

### Verification

```bash
pnpm check
topchester-dev --config config/gemini.yaml --workspace ~/data/github/clsx --dev disable-kb-check-modal kb compile
```

Completed in Slice 6 by aligning `docs/KNOWLEDGE.md` with the implemented `topchester-kb/l1-files/` L1 output path and keeping L2/L3/graph/service language clearly scoped as future target work.

### Dependencies

Slice 5.

## Final Verification

Before considering the L1 queue processing work complete:

```bash
pnpm check
topchester-dev --config config/gemini.yaml --workspace ~/data/github/clsx --dev disable-kb-check-modal kb compile
```

If the external model/API is unavailable, record that the real-workspace compile could not be verified and keep the model-backed slice open.
