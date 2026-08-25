# KB Live L1 Sync

## Summary

Add a cheap per-file L1 sync path, then a global live mode that fills project knowledge as the agent reads and edits files.

Target state: a user can turn on `/kb live`, keep coding, and Topchester writes or skips an L1 entry for each touched in-scope file by SHA, without walking the whole repo and without injecting knowledge context when there is no usable project KB.

This plan exists because full `/kb sync` is costly on large repos, V0 already has a single-file L1 processor plus SHA skip, and those pieces are not exposed or scheduled.

## Decisions

- Live mode fills **L1 only**. No L2/L3 generation, no feature/module suspect marking, no graph rebuild.
- Live mode is **opt-in** and persisted on **global user config** (`~/.config/topchester/config.jsonc`) as `knowledge.live`. Default is `false`.
- `/kb live on` and `/kb live off` write that global flag, then reload the running app config. This is a durable personal preference, not a session override.
- **Trigger on both successful `read_file` and mutations** (`edit_file`, `write_file`, and `apply_patch` through those helpers). Mutation-only would leave most explored files unsynced. Reads are how the agent "works on" a file.
- Do **not** trigger from `grep`, `find_file`, `list_files`, or `bash`. Those can name thousands of paths without meaning the agent is working on each file.
- SHA skip is mandatory: if the L1 entry exists, `scan_status` is `current`, and `content_hash` matches the file hash, skip the model call.
- If there is **no project KB**, or the KB is not a directory, live mode is a no-op. Do **not** auto-run `/kb init`. Do **not** inject KB context, KB status, or "run /kb sync" text into the model prompt. The agent keeps working with empty project knowledge.
- Context injection stays on the existing gate: only when the KB exists, is a directory, and is `ready`, and only when a context pack has matching files. Empty packs still return the original prompt.
- No special large-repo policy: no size warnings, no coverage percent, no sharding, no auto `--full`. The user chooses live fill, dirty `/kb sync`, `--full`, or nothing.
- Single-file sync must **not** call `listProjectFilesForL1`. That walk is a large part of current sync cost. Hash and ignore-check the requested path only.
- Live and single-file sync skip `postProcessL1Entries`. That pass reloads every L1 entry. Defer linking to a later idle/batch slice.
- Live work is async and must not block the agent turn. Serial worker, one in-flight L1 summarize at a time, per-path debounce, latest-hash wins.
- Use purpose `kb.summarize` only. Never the primary agent model.
- Footer/status for live mode must **not** refresh via `dryRunKnowledgeCompile`. That is a full-repo inventory. Live status comes from the scheduler snapshot plus session overlay.
- `topchester run` honors the same `knowledge.live` flag because it shares `AgentRuntime`. Tests keep the default `false`.

### Why sync on read, not mutations only

Mutation-only looks cheaper, but it misses the actual live-mode job: fill knowledge for files the agent is using.

A typical turn reads several files and edits one. If live only runs after writes, the files that shaped the plan stay missing or stale in L1. SHA skip makes repeat reads free after the first current entry, so the expensive case is "first time this hash was seen," which is the case we want to pay for.

Gates that keep reads from exploding:

- in-scope files only (gitignore, `ignore.paths`, default excludes, not binary, not over the L1 byte cap)
- skip `read_file` results marked `binary` or `too_large`
- skip when the hash already matches a current L1 entry
- skip when the same path+hash is in-flight or already queued
- do not enqueue from search/list tools
- serial `kb.summarize` worker so live mode cannot stampede the provider

Partial `read_file` ranges still enqueue the **whole file** using the returned file hash. L1 entries describe the file, not the snippet.

## Scope

Included:

- compiler primitive `syncL1File` with SHA skip
- CLI `topchester kb sync [paths...]` and slash `/kb sync <path>`
- global `knowledge.live` config
- slash `/kb live on|off|status` and CLI `topchester kb live on|off|status`
- live scheduler hooked from file read/edit/write helpers
- overlay clear when a live sync matches the overlay after-hash
- TUI footer live status without a full dirty scan
- tests and public docs for the new commands and config key

Out of scope:

- L2/L3, graph, drift API, MCP
- auto `/kb init`
- repo-size warnings or coverage UI
- live sync from grep/find/list/bash
- deleting L1 entries when `apply_patch` deletes a file (leave stale until `/kb sync --full` orphan removal)
- incremental `postProcessL1Entries`
- committing `topchester-kb/` automatically
- session-only live toggle
- injecting KB health text into model prompts

## Current State

- `syncKnowledgeBase` always inventories the workspace, then queues non-clean files (`src/knowledge/compiler/index.ts`).
- `--full` inventories everything and removes orphan L1 entries.
- `processL1QueueItem` already does one-file L1 generation and rejects hash mismatches (`src/knowledge/compiler/l1-processor.ts`).
- `hasCurrentEntry` already skips a model call when path + hash + `current` match.
- After a batch queue, `postProcessL1Entries` reloads all L1 files to infer test links.
- `edit_file` / `write_file` mark session overlay dirty-known with before/after hashes. Overlay never clears on sync.
- `read_file` already returns a `sha256:` hash.
- `apply_patch` routes add/update through `writeWorkspaceFile` / `editWorkspaceFile`.
- Runtime injects an L1 context pack only when the KB is ready (`src/agent/runtime/index.ts` `buildPromptWithKnowledgeContext`). Missing/empty KB returns the prompt unchanged. Search failures are logged and ignored.
- KB ready means `manifest.json` `l1.currentEntries > 0` or `l1.completed > 0`.
- Global config writes already exist for `/connect` and `/model all` via `writeGlobalConfig` (`src/config/index.ts`). `reloadAppBaseConfig` reloads JSONC into a running `AppContext`.
- Config merge order: workspace `topchester.jsonc`, then `~/.config/topchester/config.jsonc`, then `--config` / `TOPCHESTER_CONFIG`. User global already wins over project config.
- TUI footer dirty count uses `dryRunKnowledgeCompile` (full inventory) on a 90s timer and after `/kb` commands (`src/chat/controller.ts`).
- Slash `/kb sync` currently rejects any arg other than `--full`.

## Behavior To Preserve

- `/kb sync` with no paths still means "all non-clean files" and still inventories.
- `/kb sync --full` still means "all in-scope files" and still removes orphans.
- Missing KB does not block coding. Product help stays in the packaged `topchester` skill.
- `TOPCHESTER_DISABLE_L1_CONTEXT=1` still skips context injection even when live is on.
- Interrupted batch sync still exits 130 and keeps its queue.
- Deterministic L1 fields stay owned by code, not the model.
- Do not expose full home directory paths in user-facing docs. Use `~`.

## Implementation Shape

```text
tool success (read_file | edit_file | write_file)
  -> runtime/tool-context notifyLiveL1Touch({ path, hash, reason })
  -> if !config.knowledge.live: return
  -> if !kb directory: return
  -> scheduler.enqueue(path, hash)
       debounce per path (~400ms), latest hash wins
       serial worker:
         cheap ignore + size + hash check
         hasCurrentEntry? skip
         processL1QueueItem
         bump manifest currentEntries best-effort
         if overlay.afterHash === synced hash: drop that dirty file
```

CLI/slash single-file path is the same primitive without the scheduler:

```text
topchester kb sync src/a.ts
  -> syncL1File(workspace, "src/a.ts")
  -> no inventory, no postProcess, no orphan removal
```

New config shape, written only by `/kb live` / `topchester kb live` into global user config:

```jsonc
{
  "knowledge": {
    "live": true,
  },
}
```

Workspace `topchester.jsonc` may contain the same key because it is on the shared schema, but the slash command always writes the user global file. With default merge order, the user flag wins over a project file.

## Data Flow

```text
read_file(a.ts) / edit_file(a.ts)
        |
        +-- tool result returned to agent immediately
        |
        v
 LiveL1Scheduler (in-memory, workspace-scoped)
        |
        +-- skip: live off, no KB dir, ignored, too large, binary, same SHA current
        |
        v
 processL1QueueItem  (kb.summarize)
        |
        v
 topchester-kb/l1-files/<path>.json
 manifest.json currentEntries (best-effort increment)
 session overlay entry cleared if hashes still match
        |
        v
 next turn's createL1ContextPack reads L1 files from disk
 (no separate index invalidation; search already reloads from disk)
```

## Edge Cases

- **No KB folder:** enqueue is a no-op. No init. No prompt text about KB.
- **KB exists but empty:** live may write the first L1 file. After that, status becomes `ready` and later turns may inject context packs. The turn that created the first entry still used empty context, which is correct.
- **Live on, `kb.summarize` missing:** skip live jobs and record a scheduler error; do not fail the user turn. `/kb sync <path>` keeps today's require-model behavior.
- **File ignored:** skip. Single-file CLI should print a clear skip reason.
- **Hash changed while in flight:** `processL1QueueItem` already returns `changed`. Re-queue the latest hash if live is still on and the file still exists.
- **Rapid edits:** debounce; only the last hash for that path is processed.
- **Read then edit same turn:** queue collapses to the latest hash.
- **`read_file` skip binary/too_large:** do not enqueue.
- **Deleted file via apply_patch:** do not live-delete the L1 entry in this plan.
- **Concurrent `/kb sync` batch and live worker:** one workspace mutex. Batch sync takes the lock; live jobs wait. Do not interleave two writers into the same L1 entry.
- **Subagent `task` reads:** share the parent workspace scheduler so explore children fill L1 too.
- **Config reload:** after `/kb live on|off`, call `reloadAppBaseConfig` and start/stop the scheduler in the current TUI/runtime.
- **TUI config-immutability docs:** `/kb live` is a global config write, same class as `/connect`, not a session override like `/model`.

## Cross-Slice Rules

- Do not inventory the repo for a single-file or live sync.
- Do not call `postProcessL1Entries` from live or `--file` sync in this plan.
- Do not inject KB guidance into model prompts when the KB is missing or empty.
- Do not refresh the footer dirty count with `dryRunKnowledgeCompile` from live completions.
- Keep `/kb sync` with no paths and `/kb sync --full` behavior unchanged.
- Persist live mode only through the existing global config writer; do not invent a second store.
- Use `mise run test -- test/<file>` (or `node_modules/.bin/vitest run --dir test`) for product tests. Do not "fix" the `/workspace` checkout `skills.test.ts` artifact.
- Update `docs/reference/cli.md` in the same slice as CLI behavior. Update `docs/features/tui.md` / `docs/features/slash-commands.md` / `docs/features/knowledge-base.md` / `docs/configuration/config-files.md` in the same slice as TUI/config behavior.

## Files to Add

- `src/knowledge/compiler/sync-file.ts` — `syncL1File` primitive
- `src/knowledge/live-scheduler.ts` — debounce, skip cache, serial worker, snapshot
- `test/knowledge-sync-file.test.ts`
- `test/knowledge-live-scheduler.test.ts`

## Files to Change

- `src/knowledge/compiler/index.ts` — export `syncL1File`; keep batch sync as-is
- `src/knowledge/compiler/inventory.ts` — export a single-path ignore/in-scope helper if needed
- `src/knowledge/session-overlay.ts` — clear a path when a matching hash is synced
- `src/config/index.ts` — `knowledge.live` schema + `setGlobalKnowledgeLive`
- `src/cli.ts` — `kb sync [paths...]`, `kb live`
- `src/agent/commands.ts` — slash `/kb sync <path>`, `/kb live`
- `src/agent/runtime/knowledge.ts` — treat `live` as a status-refresh subcommand
- `src/agent/runtime/index.ts` — construct scheduler, notify after file tools, no-poison stays
- `src/agent/tools/types.ts` / `executor.ts` / `read-file.ts` / `edit-file.ts` / `write-file.ts` — file-touch callback
- `src/chat/transcript.ts` / `src/chat/controller.ts` — live footer, avoid full dry-run on live ticks
- `src/app/context.ts` — only if live flag must be readable after reload (likely reuse `reloadAppBaseConfig`)
- tests: `test/knowledge-compiler.test.ts`, `test/commands.test.ts`, `test/cli.integration.test.ts`, `test/config.test.ts`, `test/tools.test.ts`, `test/tui-controller.test.ts`
- docs listed in cross-slice rules
- `docs/plans/kb-implementation-checklist.md` — add live L1 items when slices land

## Testing Plan

Confidence checks, per slice:

- fake `kb.summarize` model, temp workspace, no network
- SHA skip: second `syncL1File` on the same hash makes zero model calls
- hash change: model runs again
- ignored path: no write, no model
- missing KB dir: live enqueue does not create folders and does not throw into the tool result
- context pack: missing/empty KB leaves the prompt identical
- `/kb live on` writes `~/.config/topchester/config.jsonc` in a temp home, not workspace `topchester.jsonc`
- scheduler coalesces two enqueues of the same path to the later hash
- footer/status tests do not call full inventory for live snapshots

Final pass after the last slice:

```sh
mise run test -- test/knowledge-sync-file.test.ts test/knowledge-live-scheduler.test.ts test/knowledge-compiler.test.ts test/commands.test.ts test/cli.integration.test.ts test/config.test.ts test/tools.test.ts test/tui-controller.test.ts
mise run lint
mise run typecheck
mise run format-check
```

## Slice 1: Single-File L1 Sync Primitive

Status: `[x]` Done

Goal: Sync one workspace-relative file into L1 without listing the repo.

Why here: CLI, slash, and live mode all need one SHA-gated writer before any scheduling or TUI work.

This slice should implement:

- `syncL1File({ workspaceRoot, path, model, config, abortSignal, now })`
- normalize and contain the path
- cheap in-scope check (gitignore ancestors + `ignore.paths` + default excludes + binary + L1 size cap)
- hash the file
- `hasCurrentEntry` skip with outcome `skipped_current`
- otherwise `processL1QueueItem`
- best-effort manifest `currentEntries` increment on a new current entry
- do not write a batch queue file
- do not run `postProcessL1Entries`
- do not remove orphans

Expected output:

- `src/knowledge/compiler/sync-file.ts`
- focused tests for skip, write, changed-on-disk, missing file, ignored path, missing KB dir

Verification:

```sh
mise run test -- test/knowledge-sync-file.test.ts
```

Dependencies: none.

Completed 2026-08-25: added the inventory-free single-file primitive, including
current-SHA skip, ignore/binary/size checks, changed-during-model detection, and
best-effort manifest readiness. Verification passed with
`mise run test-node -- test/knowledge-sync-file.test.ts` and `mise run local-ci`.

## Slice 2: CLI And Slash Path Sync

Status: `[x]` Done

Goal: Let a user sync one or more named files without a full dirty scan.

Why here: Makes Slice 1 usable and gives live mode a command people can run by hand.

This slice should implement:

- `topchester kb sync [paths...]` mutually exclusive with `--full`
- `/kb sync <path> [path...]` in addition to `/kb sync` and `/kb sync --full`
- format results as one block per path: completed / skipped_current / ignored / failed / changed / missing
- keep no-path `/kb sync` and `--full` identical
- update `docs/reference/cli.md` and slash-command lists

Expected output:

- CLI and slash accept paths
- unknown flags still error
- integration tests for one dirty file, one already-current file, and `--full` plus path rejected

Verification:

```sh
mise run test -- test/commands.test.ts test/cli.integration.test.ts
```

Dependencies: Slice 1.

Completed 2026-08-25: CLI and slash sync accept one or more named paths, report
per-file outcomes, reject `--full` plus paths, and preserve both batch modes.
Verification passed with `mise run test-node -- test/knowledge-sync-file.test.ts
test/commands.test.ts test/cli.integration.test.ts` and `mise run local-ci`.

## Slice 3: Global Live Flag And Commands

Status: `[ ]` Not started

Goal: Persist live mode on user global config and expose on/off/status without starting background work yet.

Why here: The scheduler needs a durable flag and a reload path. Keep config writes separate from async runtime so they can ship even if later slices slip.

This slice should implement:

- `knowledge: { live?: boolean }` on the config schema (raw + canonical)
- `setGlobalKnowledgeLive(enabled: boolean)` using `writeGlobalConfig`
- `/kb live`, `/kb live on`, `/kb live off`, `/kb live status`
- `topchester kb live on|off|status`
- `/kb live on|off` writes `~/.config/topchester/config.jsonc`, then `reloadAppBaseConfig` in the TUI
- status prints on/off, config path as `~/.config/topchester/config.jsonc`, and whether the current workspace has a KB directory
- default remains off
- slash suggestions for the new commands
- `shouldRefreshKnowledgeStatus` includes `live`

Expected output:

- turning live on in a temp home writes `"knowledge": { "live": true }`
- workspace `topchester.jsonc` is not modified
- tests in `test/config.test.ts` and `test/commands.test.ts`

Verification:

```sh
mise run test -- test/config.test.ts test/commands.test.ts
```

Dependencies: none (can overlap Slice 1/2). Runtime scheduling waits for Slice 4.

## Slice 4: Live Scheduler And File-Touch Hooks

Status: `[ ]` Not started

Goal: When `knowledge.live` is true and a project KB directory exists, enqueue SHA-gated L1 sync after successful file reads and writes, without blocking the tool result.

Why here: This is the product behavior. It depends on the primitive (Slice 1) and the flag (Slice 3).

This slice should implement:

- `LiveL1Scheduler` with `enqueue`, `snapshot`, `start`, `stop`, per-path debounce, serial worker, in-memory `path -> lastSyncedHash`
- skip when live is off, KB dir missing, file out of scope, hash already current, or hash already last-synced
- ToolContext callback `onFileTouch?: (event: { path: string; hash: string; reason: "read" | "create" | "edit" | "overwrite" }) => void`
- fire from `readWorkspaceFile` (not skipped), `editWorkspaceFile`, `writeWorkspaceFile` so `apply_patch` is covered
- runtime owns one scheduler per workspace and no-ops the callback when live is off
- do not fail the tool if live sync fails; log `live_l1_sync_failed`
- mutex with batch `syncKnowledgeBase` so they do not write L1 concurrently
- share the scheduler with subagent tool execution
- do not enqueue grep/find/list/bash

Expected output:

- `src/knowledge/live-scheduler.ts`
- runtime/tool wiring
- tests: debounce coalescing, SHA skip without model, missing KB no-op, live off no-op, edit+read collapse to latest hash

Verification:

```sh
mise run test -- test/knowledge-live-scheduler.test.ts test/tools.test.ts
```

Dependencies: Slice 1, Slice 3.

## Slice 5: Overlay Clear, No-Poison, Live Footer

Status: `[ ]` Not started

Goal: Keep human status honest and keep the model prompt clean.

Why here: Live writes change KB files under the agent. Overlay and footer still describe batch-era "everything is dirty until `/kb sync`." Context injection must stay empty when there is no KB.

This slice should implement:

- clear a session-overlay dirty file when live/single-file sync writes a current entry whose `content_hash` equals `afterHash`
- if overlay becomes empty, set overlay `drift: clean` and `kbState: current`
- do not clear if the user/agent edited again and `afterHash` moved
- confirm `buildPromptWithKnowledgeContext` still returns the original prompt when KB is missing, not a directory, empty/`not ready`, or the pack has zero files
- add an explicit test that live mode does not append KB guidance to the model prompt
- footer: when live is on, show scheduler snapshot instead of `N dirty` from full dry-run, for example `kb: live · 1 syncing` / `kb: live`
- do not start the 90s full-inventory timer as a substitute for live progress; live snapshot can be event-driven
- keep the existing dirty-count path when live is off

Expected output:

- overlay tests in `test/tools.test.ts`
- runtime/context-pack tests for missing and empty KB
- TUI footer string tests

Verification:

```sh
mise run test -- test/tools.test.ts test/tui-controller.test.ts test/transcript.test.ts
```

Dependencies: Slice 4.

## Slice 6: Public Docs And Checklist

Status: `[ ]` Not started

Goal: Document the commands, config key, and live behavior in the public docs that match implementation.

Why here: Docs stay in the same change as behavior; this slice exists so earlier slices can land CLI/TUI strings first, then one docs pass can make examples exact.

This slice should implement:

- `docs/features/knowledge-base.md` — live mode, single-file sync, SHA skip, no auto-init, empty KB does not affect the agent
- `docs/features/slash-commands.md` and `docs/features/tui.md` — `/kb live`, `/kb sync <path>`, footer live states
- `docs/reference/cli.md` — `kb sync [paths...]`, `kb live`
- `docs/configuration/config-files.md` — `knowledge.live` on user global config; `/kb live` writes it
- `docs/plans/kb-implementation-checklist.md` — mark live L1 items
- no `public: true` on this plan

Expected output:

- docs examples match shipped flags and config keys

Verification:

- docs review against CLI/slash strings from Slices 2–5
- `mise run format-check`

Dependencies: Slices 2–5.

## Open Questions

- Exact debounce interval. Start at 400ms; only change if tests or interactive use show churn.
- Whether a later slice should run deferred `postProcessL1Entries` on idle or `/kb live off`. Not required for L1 fill.
- Whether `topchester kb live` should refuse to turn on when `kb.summarize` is unresolved. Prefer warn-on-status, skip jobs, keep the flag.

## Next Slice

Start Slice 3.

Add the shared `knowledge.live` config field and global writer, then expose the
CLI and slash on/off/status commands without scheduling background work yet.

First verification:

```sh
mise run test-node -- test/config.test.ts test/commands.test.ts test/cli.integration.test.ts
```

Do not start the scheduler until the persisted flag and running-config reload
path are covered.
