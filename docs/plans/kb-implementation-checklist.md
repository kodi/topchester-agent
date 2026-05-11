# KB Implementation Checklist

## Purpose

Track implementation of the global knowledge base feature from current L1 support through L2/L3, graph, drift, service, MCP, TUI, and agent behavior.

`docs/KNOWLEDGE.md` remains the design source. This file is the implementation checklist.

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
- [x] Slash command `/kb compile`
- [x] CLI L1 progress with count, percentage, progress bar, and current file

## Global KB Setup and Configuration

- [x] `topchester kb init`
- [x] `topchester kb reset`
- [x] `topchester kb status`
- [x] Default canonical path: `topchester-kb/`
- [x] Default cache path: `.agents/topchester-kb-cache/`
- [x] Environment overrides for KB/cache paths
- [ ] Validate KB folder schema/version during status and compile
- [ ] Add explicit compiler version to manifest
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
- [x] Existing current-entry skip/resume behavior
- [x] Per-file failure metadata
- [x] Orphan L1 entry cleanup
- [x] Mirrored path-safe entry writes
- [ ] Add stronger language/type detection
- [ ] Add structural import/export/symbol extraction before summarization
- [ ] Add test/doc coverage links where detectable
- [ ] Add chunking or fallback strategy for oversized text files
- [ ] Add L1 schema JSON files under `topchester-kb/schema/`
- [ ] Add L1 validation command/check

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
- [ ] Implement `kb.search`
- [ ] Implement `kb.getNode`
- [ ] Implement `kb.neighbors`
- [ ] Implement `kb.contextPack`
- [ ] Implement `kb.driftCheck`
- [ ] Implement `kb.impact`
- [ ] Implement `kb.updatePlan`
- [ ] Add response envelope with drift warnings
- [ ] Add service tests

## Runtime Cache

- [ ] Define cache build flow from canonical KB
- [ ] Add SQLite cache under `.agents/topchester-kb-cache/`
- [ ] Add FTS index
- [ ] Add cache invalidation based on manifest/hash
- [ ] Keep cache fully rebuildable from canonical KB
- [ ] Add cache tests

## MCP Adapter

- [ ] Add MCP server/adapter over KB service
- [ ] Expose KB nodes/context packs as resources
- [ ] Expose `kb.search` as MCP tool
- [ ] Expose `kb.contextPack` as MCP tool
- [ ] Expose `kb.driftCheck` as MCP tool
- [ ] Expose `kb.impact` as MCP tool
- [ ] Add MCP adapter tests

## Agent KB-Aware Behavior

- [ ] Query KB before architecture answers
- [ ] Request context pack before non-trivial coding tasks
- [ ] Run drift check before editing relevant files
- [ ] Warn clearly when relevant KB is stale
- [ ] Update or mark KB stale after edits
- [ ] Include KB updates with in-scope code changes
- [ ] Prevent normal coding path from bypassing KB once strict mode exists
- [ ] Add agent behavior tests

## TUI Integration

- [ ] Show KB health/status in TUI
- [ ] Show compile progress
- [ ] Show L1 file processing progress
- [ ] Add feature map view
- [ ] Add context pack preview
- [ ] Add drift warning panel
- [ ] Add knowledge diff view
- [ ] Add TUI tests

## Validation and CI

- [ ] Add schema validation for canonical KB files
- [ ] Add compiler output reproducibility check
- [ ] Add drift check command suitable for CI
- [ ] Add generated KB policy checks
- [ ] Add test fixtures for small repos
- [ ] Add end-to-end compile validation for a sample workspace
