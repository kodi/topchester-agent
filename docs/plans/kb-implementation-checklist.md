# KB Implementation Checklist

## Purpose

Track implementation of the global knowledge base feature from current L1 support through L2/L3, graph, drift, service, MCP, TUI, and agent behavior.

`docs/KNOWLEDGE.md` remains the design source. This file is the implementation checklist.

Status legend:

- `[x]` Done
- `[-]` Partial or in progress
- `[ ]` Not started

## Current Status

- [x] Project KB folder initialization
- [x] Configurable canonical KB path with `TOPCHESTER_KB_DIR`
- [x] Configurable generated cache path with `TOPCHESTER_KB_CACHE_DIR`
- [x] L1 inventory scan for in-scope files
- [x] Durable L1 processing queue
- [x] Model-backed L1 file entry generation
- [x] Mirrored L1 entry layout under `topchester-kb/l1-files/<source/path>.json`
- [x] Basic manifest updates with L1 counts
- [x] CLI `topchester kb compile`
- [x] CLI `topchester kb search`
- [x] CLI `topchester kb context`
- [x] Top-level CLI `topchester search` alias for L1 KB search
- [x] Slash command `/kb compile`
- [x] CLI L1 progress with count, percentage, progress bar, and current file
- [x] Workspace-scoped `edit_file` and create-by-default `write_file` tools mark changed files dirty-known and `needs_sync` in the runtime session overlay
- [x] L1 in-memory search over paths, symbols, exports, responsibilities, summaries, imports, relationships, evidence, and tests
- [x] L1 context pack generation for CLI and runtime prompt injection
- [x] Agent runtime injects relevant L1 context packs when the KB is ready
- [x] L1 post-processing infers file roles and reverse test links
- [x] Provider-exposed reasoning can stream into the TUI without persisting thinking text into session/model context

## Recent Implementation Notes

- `e411787` added L1 search, compact context pack generation, CLI `kb search`/`kb context`, top-level `search`, runtime L1 context injection, L1 post-processing, and tests.
- `eac6997`, `21a8825`, and `bbab1d2` added L1 search benchmarks, optimized index loading/prefix lookup, and stripped empty containers from JSON search/context-pack output.
- `e5ae0b7` added the `TOPCHESTER_DISABLE_L1_CONTEXT=1` escape hatch and token-usage context notes.
- `22b608c` added streamed provider reasoning in the TUI and hardened the plan/tool-call display path. This is TUI/runtime work, not canonical KB content.
- L1 structural fields are currently model-extracted and normalized/post-processed. Deterministic static extraction before model summarization is still only partial.

## Global KB Setup and Configuration

- [x] `topchester kb init`
- [x] `topchester kb reset`
- [x] `topchester kb status`
- [x] Default canonical path: `topchester-kb/`
- [x] Default cache path: `.agents/topchester-kb-cache/`
- [x] Environment overrides for KB/cache paths
- [ ] Validate KB folder schema/version during status and compile
- [x] Add explicit compiler version to manifest
- [ ] Add reproducibility metadata to manifest
- [ ] Add safe upgrade/migration story for future KB layout changes

## L1: File Knowledge

- [x] In-scope file inventory
- [x] `.gitignore` handling
- [x] Generated/vendor/cache folder exclusion
- [x] Binary file skipping
- [x] SHA-256 content hashes
- [x] Durable queue statuses: `queued`, `in_progress`, `completed`, `failed`, `changed`, `missing_file`
- [x] L1 entry schema/type validation
- [x] Deterministic field overrides for model output
- [x] Model-owned L1 fields normalize symbols, imports, exports, module ids, feature ids, test ids, evidence, and confidence before schema validation
- [x] Existing current-entry skip/resume behavior
- [x] Per-file failure metadata
- [x] Orphan L1 entry cleanup
- [x] Mirrored path-safe entry writes
- [ ] Add stronger language/type detection
- [-] Add structural import/export/symbol extraction before summarization; model prompt/schema normalization exists, but deterministic static extraction before summarization is still open
- [-] Add test/doc coverage links where detectable; test links are implemented through `declared_test_targets`, `likely_test_targets`, and reverse `tested_by` post-processing, while doc relationship links are still open
- [ ] Add chunking or fallback strategy for oversized text files
- [ ] Add L1 schema JSON files under `topchester-kb/schema/`
- [ ] Add L1 validation command/check
- [x] Add L1 in-memory lexical index
- [x] Add compact L1 context pack assembly with omitted empty containers and optional full L1 entries
- [x] Add CLI formatting and JSON output for L1 search/context packs

## L2: Module Knowledge

- [ ] Define L2 module entry TypeScript types
- [ ] Define L2 module JSON schema
- [ ] Add module ID normalization rules
- [ ] Add initial directory/package-based module grouping
- [ ] Add model-assisted module discovery
- [ ] Link modules to L1 files
- [ ] Track module dependencies from file imports
- [ ] Compute `module_hash` from child file/module hashes
- [ ] Mark modules stale/suspect when child files change
- [ ] Write module entries under `topchester-kb/l2-modules/`
- [ ] Add L2 manifest counts/status
- [ ] Add L2 tests

## L3: Feature Knowledge

- [ ] Define L3 feature entry TypeScript types
- [ ] Define L3 feature JSON schema
- [ ] Add feature ID normalization rules
- [ ] Add hierarchical parent/child feature model
- [ ] Detect candidate features from docs, tests, commands, routes, screens, and domain terms
- [ ] Add model-assisted feature discovery
- [ ] Link features to files and modules
- [ ] Track feature entrypoints
- [ ] Track feature interactions/dependencies
- [ ] Compute `feature_hash`
- [ ] Mark features stale/suspect when linked evidence changes
- [ ] Write feature entries under `topchester-kb/l3-features/`
- [ ] Add L3 manifest counts/status
- [ ] Add L3 tests

## Property Graph

- [ ] Define edge TypeScript types
- [ ] Define edge JSON schema
- [ ] Normalize graph node IDs
- [ ] Generate file/module/feature edges
- [ ] Generate import/dependency edges
- [ ] Generate test/coverage edges where known
- [ ] Generate feature/module/file implementation edges
- [ ] Deduplicate edges
- [ ] Store graph at `topchester-kb/graph/edges.jsonl`
- [ ] Add graph validation
- [ ] Add graph tests

## Drift Detection

- [ ] Add file drift checker from current file hashes
- [ ] Detect missing L1 entries
- [ ] Detect L1 entries for missing files
- [ ] Propagate stale/suspect status to L2 modules
- [ ] Propagate stale/suspect status to L3 features
- [ ] Add conservative impact calculation for changed files
- [ ] Add drift summary to manifest/status output
- [ ] Add advisory warning mode in CLI/TUI
- [ ] Add guarded/strict modes later
- [ ] Add drift tests

## KB Service and API

- [ ] Add local KB service process/module
- [ ] Add JSON-RPC 2.0 endpoint at `/rpc`
- [ ] Add `GET /health`
- [ ] Add `GET /manifest`
- [ ] Add `GET /nodes/:id`
- [ ] Add `GET /files/:encodedPath` or replacement file lookup
- [-] Implement `kb.search`; in-process L1 search exists, but no KB service/RPC endpoint yet
- [ ] Implement `kb.getNode`
- [ ] Implement `kb.neighbors`
- [-] Implement `kb.contextPack`; in-process L1 context packs and CLI output exist, but no KB service/RPC endpoint yet
- [ ] Implement `kb.driftCheck`
- [ ] Implement `kb.impact`
- [ ] Implement `kb.updatePlan`
- [ ] Add response envelope with drift warnings
- [ ] Add provenance metadata for canonical KB, session overlay, live file, and mixed evidence
- [ ] Add KB-suggested verification commands to context packs or impact responses
- [ ] Add service tests

## Runtime Cache

- [ ] Define cache build flow from canonical KB
- [ ] Add SQLite cache under `.agents/topchester-kb-cache/`
- [ ] Add FTS index
- [ ] Add cache invalidation based on manifest/hash
- [ ] Keep cache fully rebuildable from canonical KB
- [ ] Add session overlay storage for dirty-but-known active work
- [x] Add in-memory session overlay state for agent-authored `edit_file` changes
- [x] Reuse `.agents/topchester-kb-cache/` for durable L1 queue and sync queue artifacts
- [ ] Add cache tests

## Tool Execution

- [x] Add workspace-scoped `read_file`
- [x] Add workspace-scoped `grep`
- [x] Add workspace-scoped `find_file`
- [x] Add workspace-scoped `edit_file` for exact existing-file replacements
- [x] Add workspace-scoped `write_file` for create-by-default UTF-8 file writes
- [x] Add workspace-scoped `inspect_command` for read-only repo orientation through a narrow allowlist
- [x] Add workspace-scoped `run_validator` for strict tests, lint, typecheck, build, check, format-check, and smoke verification
- [x] Add workspace-scoped `run_command` for validator or configured project commands
- [x] Add workspace-scoped `git_status`, `git_diff`, and `git_log` for structured Git inspection
- [x] Add guarded `git_add` for explicit-path staging after current status acknowledgement
- [x] Add guarded `git_commit` for exact staged-path commits when the user explicitly asks
- [x] Add session-only `plan_todo` for visible multi-step task plans
- [x] Add `edit_file` path containment, existing-file checks, UTF-8 validation, optional expected-hash checks, and atomic-ish same-directory writes
- [x] Add `write_file` path containment, existing-file rejection, optional parent-directory creation, UTF-8 validation, and atomic-ish same-directory writes
- [x] Add per-file mutation serialization for `edit_file`
- [x] Add per-file mutation serialization for `write_file`
- [x] Return edit diff, before/after hashes, byte delta, first changed line, and KB dirty-state metadata
- [x] Return write hash, byte count, line count, parent directory list, and KB dirty-state metadata
- [x] Add hash-guarded whole-file overwrite support to `write_file`
- [x] Return overwrite before/after hashes, byte delta, and line delta
- [x] Avoid debug-level logging of full `edit_file` old/new edit text
- [x] Avoid debug-level logging of full `write_file` content
- [x] Avoid debug-level logging of full `git_diff` content
- [x] Avoid debug-level logging of full validator output
- [ ] Add approval-backed Git/network operations such as branch creation, push, pull, and PR creation

## MCP Adapter

- [ ] Add MCP server/adapter over KB service
- [ ] Expose KB nodes/context packs as resources
- [ ] Expose `kb.search` as MCP tool
- [ ] Expose `kb.contextPack` as MCP tool
- [ ] Expose `kb.driftCheck` as MCP tool
- [ ] Expose `kb.impact` as MCP tool
- [ ] Add MCP adapter tests

## Agent KB-Aware Behavior

- [-] Query KB before architecture answers; runtime injects L1 context for normal chat turns when KB is ready, but there is no architecture-specific policy yet
- [-] Request context pack before non-trivial coding tasks; runtime injects an L1 context pack for normal turns when KB is ready, with `TOPCHESTER_DISABLE_L1_CONTEXT=1` as an escape hatch
- [ ] Run drift check before editing relevant files
- [-] Use KB context to orient, plan, estimate impact, and identify verification; current implementation provides L1 orientation only, without impact or verification recommendations
- [x] Keep non-trivial runtime work visible through session-only `plan_todo` state
- [-] Resolve task-critical facts against current working tree before acting; prompt contract says to read current files, but this is not enforced by runtime policy
- [x] Track dirty files and suspect nodes in a session overlay during `edit_file` edits
- [x] Track created files in the session overlay during `write_file` writes
- [-] Warn clearly when relevant KB is stale; context packs carry `drift: unchecked` warnings, but scoped drift detection is not implemented
- [x] Update or mark KB stale after `edit_file` edits
- [x] Update or mark KB stale after `write_file` writes
- [x] Mark session as `needs_sync` after `edit_file` edits and `write_file` writes
- [ ] Include KB updates with in-scope code changes
- [ ] Prevent normal coding path from bypassing KB once strict mode exists
- [ ] Add agent behavior tests

## TUI Integration

- [x] Show KB ready/empty/missing/path-conflict state in TUI footer
- [ ] Show compile progress
- [ ] Show L1 file processing progress
- [ ] Add feature map view
- [ ] Add context pack preview
- [ ] Add drift warning panel
- [ ] Add knowledge diff view
- [x] Show current `plan_todo` state above the prompt during multi-step work
- [x] Show streamed provider reasoning as a non-persisted thinking row
- [x] Add TUI tests for KB footer path health
- [x] Add TUI tests for visible task-plan rendering
- [x] Add TUI tests for reasoning display and runtime failure rendering

## Validation and CI

- [ ] Add schema validation for canonical KB files
- [ ] Add compiler output reproducibility check
- [ ] Add drift check command suitable for CI
- [ ] Add generated KB policy checks
- [ ] Add test fixtures for small repos
- [ ] Add end-to-end compile validation for a sample workspace
- [x] Add focused tests for L1 search and context pack generation
- [x] Add CLI integration tests for `kb search`, `kb context`, and top-level `search`
- [x] Add L1 post-processing tests for inferred test links
