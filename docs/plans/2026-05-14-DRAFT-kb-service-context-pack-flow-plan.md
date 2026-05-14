# DRAFT: KB Service, Context Packs, And Agent Flow

Status: Draft
Date: 2026-05-14

## Purpose

Capture the current design discussion for the first useful Knowledge Base runtime:
Topchester should be able to ask questions about compiled L1 file knowledge, use
that knowledge in the agent loop, and expose the same KB to other agents later.

This is a working note for iteration, not an implementation-complete plan.

## Starting Point

The project already has:

- L1 file entries generated under `topchester-kb/l1-files/`.
- `topchester kb compile`, `topchester kb sync`, and `topchester kb status`.
- A session overlay that marks agent-edited files dirty-known and `needs_sync`.
- Only a placeholder `src/knowledge/service/index.ts` for the runtime KB service.

The next step is a KB service that can answer useful questions from L1 entries.

## Core Decision

`kb.search`, `kb.contextPack`, `kb.driftCheck`, and `kb.impact` should be KB
service methods first.

They are not the same kind of thing as mutation tools like `edit_file`.

Recommended layering:

```text
KB service method
  -> called directly by Topchester runtime
  -> optionally wrapped as model-visible tools
  -> optionally exposed as MCP tools/resources for other agents
```

Topchester should not call its own KB through MCP internally. The runtime should
use a typed internal KB client/service contract. MCP is an adapter for outside
agents, not the internal source of truth.

## Runtime Calls Versus Model Tools

Runtime-required calls:

- `kb.contextPack` before non-trivial work.
- `kb.driftCheck` before relying on relevant KB entries.
- `kb.impact` after edits or when planning verification.

Optional model-visible tools:

- `kb.search`
- `kb.getNode`
- `kb.neighbors`

External-agent MCP tools/resources:

- expose the same KB methods through an MCP adapter backed by the service layer.

The important rule is that mandatory KB behavior must not depend on the model
choosing to call a tool. The runtime should make those calls itself.

## API And MCP Shape

The core KB API should be JSON-RPC-shaped. A first implementation can be
in-process, but the method contract should match the future HTTP JSON-RPC API.

Suggested sequence:

1. Build an in-process KB service module.
2. Add HTTP JSON-RPC `/rpc` while the TUI is running.
3. Add `topchester kb serve` for a standalone KB server.
4. Add MCP as an adapter over the same service.

For MCP transport, avoid making stdio the only shared runtime path. Plain stdio
MCP usually starts one process per MCP client, which is not ideal when the goal is
"other agents can talk to the same KB while Topchester is running."

Better V0 options:

- `topchester kb serve`: local HTTP JSON-RPC service.
- `topchester kb mcp`: stdio MCP adapter that proxies to the running KB service,
  or starts an internal service when needed.

## `kb.contextPack` V0 Behavior

`kb.contextPack` should return relevant L1 files for a user question or task.

Decision: V0 uses a small in-memory lexical index over canonical L1 JSON files.
No embeddings, SQLite, or model reranker are required for the first version.

The index is built when the KB service starts or when a CLI search command runs:

```text
topchester-kb/l1-files/**/*.json
  -> load and validate L1 entries
  -> tokenize weighted fields
  -> build Map<token, postings[]>
  -> search and rank matches
```

Weighted fields:

- path and filename: highest weight
- symbols and exports: high weight
- responsibilities and summary: medium weight
- imports, test IDs, feature/module IDs, and evidence: lower weight

Search should split path text, snake_case, camelCase, symbols, route-ish strings,
and log-like text into useful query terms.

`kb.contextPack` should work without a model:

```text
task text
  -> deterministic L1 search
  -> rank candidate files from paths, summaries, responsibilities, symbols, imports, exports
  -> attach reasons and drift flags
  -> return compact context pack
```

If a suitable cheap KB model is configured, a later version can use it for
reranking or summary synthesis:

```text
deterministic candidates
  -> optional kb.extract / fast rerank
  -> synthesized task-specific context summary
```

The model step should be optional and fallback-based. Do not require a hidden
expensive model call at the start of every agent turn.

The first implementation includes a CLI probe:

```sh
topchester search "status bar"
topchester search --json "status bar"
topchester kb search "post author update error"
topchester kb search --limit 5 updatePostAuthor
topchester kb search --json "status bar"
topchester kb context "status bar"
topchester kb context --json "status bar"
topchester kb query "CMS post service"
```

This lets us test L1 retrieval quality before wiring it into the agent runtime.
The plain output is for humans; `--json` prints the full structured search result
so the command can be used in scripts and compared against the future JSON-RPC
method response shape.

`topchester kb context` builds on the same index, selects strong matches, and
returns a compact context pack for each selected file. It should not dump raw full
L1 entries by default because that can create very large payloads. Full raw L1
entries are only for explicit debugging or inspection. The runtime should call
the compact path internally before the model sees normal user prompts when the KB
is ready. The injected prompt context is orientation only; the model must still
read live files before exact claims or edits.

## Example Flow: CMS Post Author Error

User says:

```text
Here is the error log we see when user tries to update author of a post:
<ERR LOG HERE>
```

Expected flow:

1. Runtime receives the task and classifies it as likely debugging or implementation work.
2. Runtime directly calls `kb.contextPack` with the user task and a token budget.
3. `kb.contextPack` searches L1 entries for terms from the task and error log,
   such as `post`, `author`, `update`, route names, model names, and error symbols.
4. It returns likely files, for example:
   - post update route/controller
   - post service/repository
   - author/user model
   - validation or authorization code
   - related tests
5. Runtime calls `kb.driftCheck` for those relevant files.
6. If entries are stale, the agent warns plainly and treats KB results as orientation only.
7. Runtime gives the model the original task, the KB context pack, and drift state.
8. The model uses normal file/search tools to read current source and prove the
   task-critical facts against the working tree.
9. If a fix is needed, the model uses mutation tools like `edit_file`.
10. File mutation tools mark changed paths dirty-known in the session overlay.
11. Runtime calls `kb.impact` with changed paths to identify likely affected tests
    and areas.
12. The agent runs targeted verification.
13. At a checkpoint, Topchester runs KB sync for touched L1 files or leaves a
    visible `needs_sync` state.
14. Final answer summarizes root cause, changed files, verification, and KB state.

Short version:

```text
KB narrows the search. Live files prove the fix.
```

## First Useful Implementation Slice

Build an L1-only KB service with these methods:

### `kb.search`

Search loaded L1 file entries by:

- path
- summary
- responsibilities
- symbols
- imports
- exports

Return ranked matches with reasons.

Initial implementation:

- load `topchester-kb/l1-files/**/*.json`
- validate with the existing L1 schema
- skip invalid entries and report a count
- build an in-memory postings index
- return score, path, scan status, content hash, reasons, and summary
- expose the same path through `topchester kb search`

### `kb.getNode`

Fetch one L1 file node by ID:

```text
file:<path>
```

### `kb.contextPack`

Given task text, return:

- short pack summary
- relevant L1 files
- reason each file was selected
- current/stale drift flag per file
- suggested tests when L1 entries already know them

Initial implementation:

- default `limit`: 8
- default `minScore`: 12
- include compact L1 knowledge in the JSON command result
- cap long arrays and include omitted counts
- allow full raw L1 entries only behind an explicit flag such as `--full-l1`
- mark drift as `unchecked` until `kb.driftCheck` exists
- expose the command as `topchester kb context`
- inject a compact context-pack rendering into runtime model prompts when the
  canonical KB is ready and there are relevant files

### `kb.driftCheck`

Compare current file hashes against L1 `content_hash` values and report:

- current files
- changed files
- missing entries
- missing files

### `kb.impact`

For V0, use L1-only signals:

- changed files
- direct imports/imported-by where available
- test IDs already present in L1 entries
- fallback related files from search

Later, this should become graph-backed with L2/L3 propagation.

## Open Questions

- Should the TUI always start an HTTP JSON-RPC KB server, or only start it when
  another client or MCP adapter asks for it?
- Should `kb.contextPack` use `agent.fast`, `kb.extract`, or no model at all for
  the first reranking pass?
- What is the exact response envelope for in-process calls versus HTTP JSON-RPC?
- How much source text, if any, should `contextPack` include, versus only L1
  summaries and paths?
- Should `kb.impact` exist in L1-only V0, or wait until import reverse indexes
  and graph edges exist?
- When should the in-memory index refresh during a long TUI session: on startup,
  after `/kb sync`, on file watcher signals, or lazily when the manifest changes?

## Non-Goals For This Draft

- L2 module discovery.
- L3 feature discovery.
- Full graph generation.
- SQLite/FTS runtime cache.
- Full MCP implementation.
- Strict KB enforcement.
