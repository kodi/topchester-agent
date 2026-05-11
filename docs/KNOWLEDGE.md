# Knowledge System

Status: Draft / initial research notes
Date: 2026-05-11

## Core Idea

This coding agent should not behave like a generic agent that is dropped into an arbitrary project and immediately starts answering questions from raw files.

Before the agent can do serious work in a project, the project must be scanned and a structured knowledge base must be compiled from the code.

The knowledge base is not an optional memory backend. It is the semantic backend of the coding agent.

The agent should use this knowledge base to understand:

- what every file contains,
- how files group into modules,
- what user-facing and system-facing features the application implements,
- how features cut across files and modules,
- where drift exists between the current code and the compiled understanding.

The goal is a coding agent whose first-class operating model is:

1. compile knowledge from code,
2. query the compiled knowledge,
3. act on code with knowledge-backed context,
4. update or invalidate knowledge when code changes.

## Research Path Taken So Far

Initial exploration looked at these families of solutions:

1. Markdown/wiki-style knowledge bases
   - Useful for human-readable summaries and cross-links.
   - Inspired by the LLM Wiki / Karpathy-style pattern: compile knowledge once, keep it current, cross-reference it, and avoid rediscovering everything from scratch.
   - Too loose on its own for drift detection, API serving, and strict agent behavior.

2. Code intelligence indexes
   - SCIP: language-agnostic protocol for indexing source code and powering go-to-definition, references, implementations, etc.
   - Tree-sitter: fast incremental parser that can produce syntax trees for many languages and tolerate syntax errors.
   - These are useful input layers, but they do not produce the high-level file/module/feature knowledge we need by themselves.

3. Graph and triple formats
   - RDF / Turtle / JSON-LD: mature semantic-web formats for triples and linked data.
   - JSON Graph: simple JSON representation of nodes and edges.
   - Property graph style appears to fit best for us: nodes plus typed edges plus metadata on both nodes and edges.

4. Plaintext serialization formats
   - JSON: strict, widely supported, easy to validate with JSON Schema, readable enough when pretty-printed.
   - JSON Lines: good for large edge lists, logs, observations, and streaming import.
   - YAML/TOML: more human-friendly but easier to parse inconsistently and less ideal for generated artifacts.
   - Markdown: good generated view, not ideal canonical source of truth.

5. Runtime storage
   - SQLite is attractive for query performance, FTS, joins, and local portability.
   - But SQLite should probably be a generated runtime cache, not the committed source of truth.
   - The canonical KB should be structured plaintext files committed with code.

6. API exposure
   - Local HTTP JSON API is likely the simplest default.
   - JSON-RPC 2.0 over HTTP is a good fit for agent-to-KB calls because it exposes named methods with typed params and can be adapted to MCP later.
   - MCP is worth considering as an adapter because it standardizes tool/resource exposure to agents, but it should not constrain the internal model too early.

## Initial Recommendation

Use a repo-committed plaintext property graph as the canonical KB.

Use generated runtime indexes for speed.

Recommended split:

- Canonical source of truth: `topchester-kb/` directory of structured JSON and JSONL files at the project root, committed with the project.
- Runtime cache: `.agents/topchester-kb-cache/` SQLite/FTS/vector/cache files generated from the canonical KB, ignored by git.
- API server: loads canonical KB, builds indexes, exposes query/context/drift endpoints.
- Knowledge Compiler: produces and updates KB entries from code.

Why not keep the canonical KB under `.agents/` by default:

- `.agents/` is a good home for generated SQLite/cache files because it is agent-local runtime state.
- In real repositories, dot-directories and agent-runtime directories are often ignored or omitted from packaging/review by default.
- The canonical KB is intended to be committed, diffed, validated in CI, and visible to humans and agents, so a project-root `topchester-kb/` directory is more explicit.
- The directory name `topchester-kb` remains vendor-specific enough to avoid colliding with generic project files and easy to grep for.

Path configuration:

- Default canonical KB path: `topchester-kb/`.
- Environment override: `TOPCHESTER_KB_DIR`, resolved relative to the workspace root unless absolute.
- Default generated cache path: `.agents/topchester-kb-cache/`.
- Optional cache override: `TOPCHESTER_KB_CACHE_DIR`, resolved relative to the workspace root unless absolute.
- If the default KB path is missing but `TOPCHESTER_KB_DIR` is set and valid, Topchester should use the override and surface the resolved path in status output.

Do not make an opaque database the canonical KB at first.

Do not make a vector database the canonical KB. Embeddings can be useful retrieval indexes, but they should be derived from the structured KB.

## Current V0 Decisions

These are decisions from the early product/design discussion:

- First supported target repositories: TypeScript/JavaScript projects.
- API shape: local HTTP JSON-RPC as the core API, with MCP exposed as a layer/adapter on top.
- Feature model: hierarchical, not flat. Features may have parent/child relationships and graph relationships.
- Canonical KB path: `topchester-kb/` by default, overrideable with `TOPCHESTER_KB_DIR`.
- Drift enforcement: non-strict warning mode first. The agent warns clearly when KB is stale, but does not block coding tasks yet.
- Scanner/generator name: call the full KB generation system the **Knowledge Compiler**. The deterministic file/hash/symbol scan is only one phase inside it.
- V0 file inclusion policy: include everything that can change the product or the agent's understanding of the product: source, config, package manifests, lockfiles, schemas, migrations, scripts, tests, and docs. Exclude generated code/build output/vendor/cache artifacts by default.
- Human interaction with the KB should be minimal. The Knowledge Compiler should maintain the KB automatically and only interrupt the user when there is likely drift induction, corruption, destructive rewriting, or low-confidence/high-risk ambiguity.
- Massive repositories: detect large repo size early and warn about expected compile cost/time. V0 can continue best-effort with clear warnings; long-term performance should improve through cheaper/faster models, sharding, background jobs, and lazy extraction.
- Semantic change policy: every in-scope file change is potentially semantic and can propagate through L1, L2, and L3. Never assume a diff is too small to affect modules or features.
- PR review policy for KB files: generated plaintext KB changes should not require human semantic review in PRs. If the Knowledge Compiler generated the KB output and validation passes, accept the generated knowledge by default.
- TypeScript framework policy: do not build first-class per-framework optimizations in V0. Detect frameworks/packages/versions and record metadata, hints, and relationships, but rely on model reasoning plus generic code intelligence and search/discovery escape hatches instead of trying to hand-cover every framework.

## Required KB Layers

### L1: Files

Every in-scope file gets one KB entry.

An L1 file entry answers:

- What is this file?
- What does it contain?
- What does it do at a high-ish level?
- What are the important symbols, exports, imports, types, functions, commands, routes, or configuration keys?
- Which modules and features does it participate in?
- What files does it depend on?
- What tests cover it, if known?
- What hash was used when this understanding was generated?

V0 in-scope file policy:

- Include all git-tracked text files that can change the product itself or the agent's understanding of the product.
- This includes source files, application config, package manifests, lockfiles, schemas, migrations, scripts, tests, and documentation.
- Tests are first-class KB inputs because they encode expected behavior, edge cases, and feature boundaries.
- Docs are in scope when they explain product behavior, architecture, setup, APIs, user flows, or operational assumptions.
- Exclude generated code, build output, coverage output, vendored dependencies, caches, and files ignored by `.gitignore` unless explicitly included.
- Binary assets can have minimal entries if they are important to a feature, but not full semantic summaries.

Draft L1 entry shape:

```json
{
  "$schema": "../schema/file-entry.v1.json",
  "id": "file:src/server/routes/users.ts",
  "layer": "L1",
  "type": "file",
  "path": "src/server/routes/users.ts",
  "language": "typescript",
  "content_hash": "sha256:...",
  "size_bytes": 12345,
  "last_scanned_at": "2026-05-11T00:00:00Z",
  "scan_status": "current",
  "summary": "Defines HTTP routes for user account lookup and profile updates.",
  "responsibilities": [
    "Register user-related HTTP handlers",
    "Validate request parameters",
    "Call the user service layer"
  ],
  "symbols": [
    {
      "id": "symbol:src/server/routes/users.ts#registerUserRoutes",
      "kind": "function",
      "name": "registerUserRoutes",
      "exported": true,
      "summary": "Attaches user routes to the server router."
    }
  ],
  "imports": [
    "file:src/server/services/user-service.ts"
  ],
  "exports": [
    "registerUserRoutes"
  ],
  "module_ids": [
    "module:server.users"
  ],
  "feature_ids": [
    "feature:user-profile"
  ],
  "test_ids": [
    "file:tests/server/users.test.ts"
  ],
  "evidence": [
    {
      "kind": "path",
      "value": "src/server/routes/users.ts"
    },
    {
      "kind": "symbol",
      "value": "registerUserRoutes"
    }
  ],
  "confidence": "medium"
}
```

### L2: Modules

Modules are groups of files or groups of other modules scoped to a specific responsibility.

A module may be path-aligned, but should not have to be. Some modules will map cleanly to folders. Others will be semantic groupings.

An L2 module entry answers:

- What responsibility does this module own?
- Which files and child modules belong to it?
- What public interfaces does it expose?
- What other modules does it depend on?
- Which features use it?
- What models, concepts, or resources does it own?
- What hash summarizes the current state of all files and child modules in it?

Draft L2 entry shape:

```json
{
  "$schema": "../schema/module-entry.v1.json",
  "id": "module:server.users",
  "layer": "L2",
  "type": "module",
  "name": "Server / Users",
  "summary": "Server-side user account and profile route/service logic.",
  "responsibilities": [
    "Expose user HTTP endpoints",
    "Coordinate profile reads and updates",
    "Enforce user-level authorization checks"
  ],
  "contains_files": [
    "file:src/server/routes/users.ts",
    "file:src/server/services/user-service.ts"
  ],
  "contains_modules": [],
  "public_interfaces": [
    "registerUserRoutes",
    "UserService"
  ],
  "depends_on_modules": [
    "module:server.auth",
    "module:data.user-model"
  ],
  "feature_ids": [
    "feature:user-profile",
    "feature:account-settings"
  ],
  "module_hash": "sha256:...",
  "hash_inputs": [
    "file:src/server/routes/users.ts@sha256:...",
    "file:src/server/services/user-service.ts@sha256:..."
  ],
  "confidence": "medium"
}
```

### L3: Features

Features are orthogonal to the code layout.

A feature describes a thing the app does, not where the code happens to live.

A feature may cut across many modules and files. A module may support many features.

Features are hierarchical in V0. A feature can have a parent feature and child features while still keeping arbitrary graph relationships to other features.

Example:

```text
feature:authentication
  feature:authentication.login
  feature:authentication.logout
  feature:authentication.password-reset

feature:user-profile
  feature:user-profile.view
  feature:user-profile.edit
  feature:user-profile.avatar-upload
```

The hierarchy is for product/behavior organization. It should not replace graph edges such as `depends_on`, `interacts_with`, `shares_model`, or `implemented_by`.

An L3 feature entry answers:

- What does this application feature do?
- Is it user-facing, internal, operational, developer-facing, or infrastructure-facing?
- What are its entrypoints?
- What files and modules implement it?
- What data models or external systems does it touch?
- How does it interact with other features?
- What tests cover it?
- What are the important flows, states, and edge cases?
- What drift risks exist when key files change?

Draft L3 entry shape:

```json
{
  "$schema": "../schema/feature-entry.v1.json",
  "id": "feature:user-profile",
  "layer": "L3",
  "type": "feature",
  "name": "User Profile",
  "kind": "user-facing",
  "parent_feature_id": null,
  "child_feature_ids": [
    "feature:user-profile.view",
    "feature:user-profile.edit",
    "feature:user-profile.avatar-upload"
  ],
  "summary": "Allows a signed-in user to view and update profile information.",
  "entrypoints": [
    {
      "kind": "route",
      "value": "GET /users/:id"
    },
    {
      "kind": "route",
      "value": "PATCH /users/:id"
    },
    {
      "kind": "screen",
      "value": "ProfileSettingsScreen"
    }
  ],
  "key_files": [
    "file:src/server/routes/users.ts",
    "file:src/server/services/user-service.ts",
    "file:src/ui/screens/profile-settings.tsx"
  ],
  "module_ids": [
    "module:server.users",
    "module:ui.profile"
  ],
  "data_models": [
    "User",
    "Profile"
  ],
  "depends_on_features": [
    "feature:authentication"
  ],
  "interacts_with_features": [
    {
      "feature_id": "feature:account-settings",
      "relationship": "shares profile update service"
    }
  ],
  "tests": [
    "file:tests/server/users.test.ts",
    "file:tests/ui/profile-settings.test.tsx"
  ],
  "known_edge_cases": [
    "User can only update own profile unless admin",
    "Email changes may require verification"
  ],
  "feature_hash": "sha256:...",
  "hash_inputs": [
    "file:src/server/routes/users.ts@sha256:...",
    "file:src/ui/screens/profile-settings.tsx@sha256:..."
  ],
  "confidence": "medium"
}
```

## Property Graph Model

The best initial mental model is a typed property graph.

Nodes:

- file
- module
- feature
- symbol
- route
- command
- screen
- data_model
- database_table
- test
- external_service
- config_key
- job
- event

Edges:

- contains
- child_of
- parent_of
- imports
- exports
- depends_on
- calls
- implements
- used_by
- tests
- owns_model
- exposes_route
- exposes_command
- renders_screen
- reads_config
- writes_table
- publishes_event
- subscribes_to_event
- interacts_with
- supersedes
- has_drift

Edges should be triple-like, but with metadata:

```json
{
  "subject": "feature:user-profile",
  "predicate": "implemented_by",
  "object": "module:server.users",
  "confidence": "medium",
  "evidence": [
    {
      "file": "src/server/routes/users.ts",
      "lines": [12, 48],
      "reason": "Registers user profile routes"
    }
  ],
  "generated_by": "feature-discovery-agent@v0",
  "updated_at": "2026-05-11T00:00:00Z"
}
```

This is close enough to triples to support graph traversal, but more practical than pure RDF because we need confidence, evidence, hashes, provenance, and drift metadata on relationships.

## Canonical File Layout

Current L1 compiler output is implemented under `topchester-kb/l1-files/`.
The L2, L3, graph, scan, and service/API pieces below are the target layout for later
compiler stages; they are not produced as semantic output by the current L1 compile.

```text
topchester-kb/
  README.md
  manifest.json
  schema/
    file-entry.v1.schema.json
    module-entry.v1.schema.json
    feature-entry.v1.schema.json
    edge.v1.schema.json
  l1-files/
    src/
      server/
        routes/
          users.ts.json
        services/
          user-service.ts.json
  l2-modules/
    server.users.json
    ui.profile.json
  l3-features/
    authentication.json
    authentication.login.json
    authentication.password-reset.json
    user-profile.json
    user-profile.avatar-upload.json
  graph/
    edges.jsonl
  scans/
    initial-scan.json
    latest.json
```

Generated runtime files should not be committed:

```text
.agents/
  topchester-kb-cache/
    kb.sqlite
    fts.sqlite
    embeddings.sqlite
    import-report.json
```

The canonical KB should be committed with code.

The runtime cache should be rebuildable from canonical plaintext.

## Serialization Format Options

| Format | Fit | Pros | Cons | Initial verdict |
| --- | --- | --- | --- | --- |
| Pretty JSON files | L1/L2/L3 entries | Strict, validated, diffable, universally supported | More verbose than YAML | Use as canonical entry format |
| JSON Lines | Large edge lists, scan observations, event logs | Streamable, one record at a time, works well with unix tools | Not pretty for nested records | Use for `graph/edges.jsonl` and scan observations |
| YAML | Human-authored config | Readable, comments | Parser ambiguity, generated diffs can be noisy | Maybe for config, not canonical KB entries |
| Markdown | Human narrative docs | Easy for agents and humans to read | Weak schema, hard to validate | Use for generated views, not source of truth |
| SQLite | Runtime query/index | Fast, local, FTS, joins | Poor git diffs/merges, binary | Use as generated cache only |
| RDF/Turtle/JSON-LD | Formal semantic graph | Standards, SPARQL ecosystem | Heavy, less ergonomic for coding-agent iteration | Defer unless interoperability becomes important |
| JSON Graph | Graph-shaped JSON | Simple nodes/edges model | Less established for our exact needs | Borrow ideas, but define our own schema |

## Drift Detection

Drift detection is mandatory.

Each KB entry must know which code state it describes.

V0 is deliberately conservative: every in-scope file content change is treated as potentially semantic. The Knowledge Compiler must not assume that a small edit, comment change, config tweak, test update, or local implementation detail cannot affect higher layers. Any changed file can invalidate or alter L1 file knowledge, L2 module knowledge, and L3 feature knowledge.

### File Drift

For L1 entries:

- Store exact content hash for the file.
- On drift check, recompute hash from current file bytes.
- If hash differs, the L1 entry is stale.
- If a git-tracked file has no L1 entry, KB is incomplete.
- If an L1 entry points to a missing file, KB has orphaned knowledge.

### Module Drift

For L2 entries:

- Store a Merkle-style `module_hash` derived from child file hashes and child module hashes.
- If any child file entry is stale, the module is stale.
- If the module membership changes, the module is stale even if file contents did not.
- A changed child must be allowed to propagate upward; do not classify a module as semantically safe just because the diff appears small.

### Feature Drift

For L3 entries:

- Store a `feature_hash` derived from key file hashes, module hashes, entrypoints, and critical relationships.
- If any linked file, module, route, screen, command, model, test, doc, config, or other feature evidence changes, the feature is suspect.
- Feature drift is often semantic, so it may require agent review rather than deterministic update.
- The default stance is "changed until recompiled," not "probably harmless." Any file change can propagate into feature meaning.

### Drift Severity

Suggested statuses:

- `current`: hashes match and no missing dependencies.
- `changed`: file hash changed; entry needs refresh.
- `missing_entry`: code file exists without KB entry.
- `missing_file`: KB entry references a file that no longer exists.
- `suspect`: upstream child changed; semantic review needed.
- `invalid`: schema validation failed.

### Enforcement Modes

We probably want modes:

1. Advisory
   - Agent warns about drift but can continue.

2. Guarded
   - Agent can inspect and answer with warnings, but refuses high-confidence claims about stale areas.

3. Strict
   - Agent refuses coding tasks until affected KB entries are updated.

Initial V0 recommendation: default to Advisory/non-strict warning mode. The agent must surface stale KB warnings prominently, but it can continue coding tasks while the workflow is still being developed. Guarded and Strict modes remain future enforcement levels.

## Knowledge Compiler Pipeline

The full KB generation and refresh system is called the **Knowledge Compiler**.

Do not call the whole system just "the scanner". Scanning is only the deterministic inventory phase. The Knowledge Compiler includes scanning, structural code intelligence, LLM reasoning, module discovery, feature discovery, graph building, validation, and drift reporting.

Naming proposal:

- User-facing system name: **Knowledge Compiler**
- Short/codename: **Cartographer**
- TypeScript package/module name: `@topchester/kb-compiler`
- CLI namespace: `topchester kb compile`, with `topchester kb scan` reserved for the lower-level deterministic scan phase
- Runtime service name: `kb-service`

The most important component is the initial scan/discovery subagent system.

This should not be one giant prompt over the whole repository.

It should be a staged pipeline with deterministic scanners plus reasoning agents.

### Stage 0: Inventory Scan

Deterministic scanner:

- Detect repository scale before doing expensive reasoning: file count, total text size, largest files, package/workspace count, and likely generated/vendor areas.
- If the repository is huge, warn clearly about expected compile cost/time and proceed best-effort rather than failing by default.
- Read git-tracked files.
- Apply ignore rules.
- Classify by language/type.
- Detect package manifests, build files, test files, docs, routes, schemas, migrations, config.
- Compute file hashes.
- Produce `topchester-kb/scans/initial-scan.json` by default.

For massive repos, V0 should favor visibility over cleverness: tell the user the repo is large, show the likely cost/time risk, and continue with staged compilation if requested. Longer-term optimizations can include package-level shards, background Knowledge Compiler jobs, lazy L3 feature extraction, and cheaper/faster model passes.

### Stage 1: Structural Code Intelligence

Use deterministic and semi-deterministic tools where possible, but keep the V0 approach framework-neutral.

V0 should target TypeScript/JavaScript repositories without trying to optimize for individual frameworks:

- Parse `package.json`, lockfiles, `tsconfig.json`, workspace configs, scripts, and dependency metadata.
- Detect frameworks, libraries, tooling, and versions from manifests/configs/imports, then write them into the KB as metadata and hints.
- Extract generic TS/JS structure: imports, exports, symbols, dependency edges, tests, config usage, package boundaries, and likely runtime entry points where detectable by generic static signals.
- Link detected frameworks/packages to files, modules, features, and docs when there is evidence.
- Use TypeScript compiler APIs or language-server data where useful.
- Use Tree-sitter as a fast structural fallback.

Do not add first-class framework-specific scanner optimizations in V0. The reason is strategic: there are too many frameworks and project-specific patterns to cover exhaustively, and modern models already know common framework semantics. The KB should record which frameworks are present and provide enough evidence for the agent to reason from code.

Escape hatch: when framework behavior or project conventions are unclear, the Knowledge Compiler and coding agent should be allowed to inspect more source files, read local docs, query package metadata, or search externally rather than relying on hardcoded framework scanners.

Longer-term inputs:

- SCIP or language-server-derived indexes where available for symbols, references, and definitions.
- Generic package/dependency intelligence that improves framework metadata and relationships without creating one-off scanners for every framework.

Output should be structured observations, not final prose.

### Stage 2: L1 File Summarization Agents

Batch files by directory/language/module candidate.

Each L1 summarizer receives:

- file path,
- file contents or chunks,
- structural observations,
- imports/exports/symbols,
- nearby files if needed,
- test/doc links if known.

It produces one file entry per file.

Hard requirement: coverage must be 100% for in-scope files.

### Stage 3: L2 Module Discovery Agent

This agent groups files and child modules into modules.

Signals:

- directory structure,
- imports/dependencies,
- naming patterns,
- package boundaries,
- test organization,
- route/screen/command ownership,
- repeated domain language,
- data model ownership.

Output:

- proposed module entries,
- confidence per module,
- explanation of why files belong together,
- unresolved grouping questions.

### Stage 4: L3 Feature Discovery Agent

This agent extracts the things the app does.

Signals:

- routes and API endpoints,
- UI screens/components,
- CLI commands,
- background jobs,
- tests and test names,
- docs/README/user guides,
- database models and migrations,
- config flags,
- event names,
- telemetry names,
- domain vocabulary repeated across files.

Output:

- feature entries,
- feature-to-module links,
- feature-to-file links,
- interactions between features,
- key user/system flows,
- confidence and evidence.

This is the differentiator. Other agents know files. This agent should know application behavior.

### Stage 5: Graph Builder

Merge L1, L2, and L3 outputs into a coherent property graph.

Tasks:

- normalize IDs,
- deduplicate edges,
- validate schemas,
- check every file has one L1 entry,
- check module/file memberships,
- check features cite evidence,
- write `graph/edges.jsonl`,
- write `manifest.json`.

### Stage 6: Critic / Consistency Review Agent

A review agent should look for:

- files with vague summaries,
- modules with no clear responsibility,
- features with weak evidence,
- orphan files,
- orphan modules,
- duplicated features,
- unsupported feature claims,
- missing tests or unknown coverage,
- stale hashes,
- invalid edges.

The review output should be stored as a scan report and shown in the TUI.

### Stage 7: Human Review

Human review should be exception-driven, not mandatory for normal KB operation.

The Knowledge Compiler should automatically compile and refresh the KB without asking the user to approve every module, feature, or file entry. The TUI should make the proposed KB visible and editable, but the default flow should not block on human review.

Interrupt the user only when there is a meaningful risk of bad KB state, such as:

- likely drift induction or attempts to corrupt the KB,
- destructive KB rewrites,
- contradictory source facts versus existing KB claims,
- very low-confidence module/feature restructuring,
- ambiguous ignore/inclusion rules that would omit product-affecting files.

The human should still be able to rename, merge, split, pin, and repair knowledge entries when they choose to intervene.

## API Design

The KB API should serve loaded KB data to the coding agent.

It should not just expose raw search. It should expose coding-agent-native operations.

### Recommended Initial Shape

Use local HTTP with JSON payloads.

The core API is HTTP JSON-RPC 2.0. MCP is a second layer/adapter on top of the same KB service, not the internal source of truth.

Expose a JSON-RPC 2.0 endpoint for agent calls:

```text
POST /rpc
```

Also expose a few human/debug REST endpoints:

```text
GET /health
GET /manifest
GET /nodes/:id
GET /files/:encodedPath
```

Why JSON-RPC for the main agent API:

- simple single endpoint,
- named methods map directly to agent tools,
- easy to batch,
- easy to expose through MCP tools/resources later,
- less endpoint sprawl while the API is evolving.

MCP adapter responsibilities:

- expose KB nodes and context packs as MCP resources,
- expose `kb.search`, `kb.contextPack`, `kb.driftCheck`, and `kb.impact` as MCP tools,
- keep JSON-RPC as the stable internal contract so the TUI, CLI, and MCP server all use the same service layer.

### Core Methods

#### `kb.search`

Search across files, modules, features, symbols, and edges.

Params:

```json
{
  "query": "how does profile update work?",
  "filters": {
    "layers": ["L1", "L2", "L3"],
    "types": ["feature", "module", "file"],
    "paths": ["src/server/**"]
  },
  "limit": 20,
  "include_edges": true,
  "include_stale": false
}
```

Response should include ranked nodes, why they matched, and drift flags.

#### `kb.getNode`

Fetch one node by stable ID.

```json
{
  "id": "feature:user-profile",
  "include_neighbors": true,
  "neighbor_depth": 1
}
```

#### `kb.neighbors`

Traverse graph around a file, module, feature, symbol, route, etc.

```json
{
  "id": "file:src/server/routes/users.ts",
  "predicates": ["implements", "depends_on", "tested_by"],
  "depth": 2
}
```

#### `kb.contextPack`

This may be the most important API method.

Given a task, return a compact context pack for the coding agent.

```json
{
  "task": "Add avatar upload to user profiles",
  "seed_ids": ["feature:user-profile"],
  "seed_paths": ["src/server/routes/users.ts"],
  "token_budget": 12000,
  "include": {
    "features": true,
    "modules": true,
    "files": true,
    "symbols": true,
    "tests": true,
    "drift": true
  }
}
```

Response:

```json
{
  "kb_version": "2026-05-11T00:00:00Z",
  "drift_summary": {
    "status": "current",
    "stale_nodes": []
  },
  "context_pack": {
    "summary": "User profile spans server.users and ui.profile...",
    "relevant_features": ["feature:user-profile", "feature:authentication"],
    "relevant_modules": ["module:server.users", "module:ui.profile"],
    "relevant_files": [
      {
        "id": "file:src/server/routes/users.ts",
        "path": "src/server/routes/users.ts",
        "reason": "Defines profile routes",
        "summary": "...",
        "hash": "sha256:...",
        "stale": false
      }
    ],
    "suggested_tests": ["file:tests/server/users.test.ts"],
    "risks": [
      "Profile updates depend on authentication/authorization checks"
    ]
  }
}
```

The coding agent should ask for a context pack before implementing non-trivial tasks.

#### `kb.driftCheck`

Check current code against KB hashes.

```json
{
  "paths": ["src/server/routes/users.ts"],
  "include_dependents": true
}
```

Response should show stale files, affected modules, affected features, and recommended refresh actions.

#### `kb.impact`

Given files or planned changes, answer what modules/features/tests may be affected.

```json
{
  "changed_paths": ["src/server/services/user-service.ts"],
  "include_tests": true,
  "include_features": true
}
```

#### `kb.updatePlan`

Given changed files, produce a plan for updating KB entries.

```json
{
  "changed_paths": ["src/server/services/user-service.ts"],
  "mode": "conservative"
}
```

Possible modes:

- `conservative`: default. Update changed L1 entries and propagate suspect/refresh work through all reachable L2/L3 layers. Never assume a small diff is isolated.
- `full`: rerun broader module/feature discovery for affected packages or the whole repo.
- `diagnostic`: explain the propagation graph and why specific modules/features are considered affected.

Avoid a mode that treats a changed file as locally harmless. Even if the compiler chooses an efficient incremental implementation, the semantic policy remains conservative: every in-scope change can propagate.

## Response Envelope

All agent-facing API responses should include:

```json
{
  "ok": true,
  "request_id": "req_...",
  "kb_manifest_hash": "sha256:...",
  "kb_version": "2026-05-11T00:00:00Z",
  "drift": {
    "status": "current",
    "warnings": []
  },
  "result": {},
  "warnings": []
}
```

This keeps drift visible everywhere. The agent should not be able to accidentally ignore it.

## Agent Behavior Rules

The coding agent should have KB-aware rules baked into its runtime.

Possible rules:

1. Before answering architecture questions, query the KB.
2. Before editing code, request a context pack for the task.
3. Before editing files, run drift check on the relevant files/modules/features.
4. If the relevant KB is stale, say so and either refresh it or operate in a clearly degraded mode.
5. After editing code, update or mark affected KB entries stale.
6. Commits should include KB updates whenever in-scope files changed, because every change is potentially semantic.
7. The TUI should make KB state visible: current/stale/missing/suspect.

## Pull Request Review Policy for KB Files

Generated KB files should not require human semantic review in PRs.

If canonical KB plaintext files change because the Knowledge Compiler regenerated them, the default policy is to accept the generated output. Reviewers should review the product code and compiler implementation, not hand-edit or bikeshed generated KB diffs.

Recommended checks are mechanical, not semantic:

- schema validation passes,
- the KB was generated by the expected compiler version,
- the generated output is reproducible from the current source tree,
- drift checks report no missing/stale in-scope entries after generation.

Manual intervention is reserved for suspected compiler bugs, KB corruption, malicious drift induction, or unexpected destructive rewrites.

## TUI Integration Ideas

Because this project is a TUI coding agent, the KB should be visible and interactive.

Possible TUI panes/views:

- Scan progress view: files scanned, files summarized, modules discovered, features discovered.
- KB health view: stale entries, missing entries, orphan nodes, weak-confidence features.
- Feature map view: list/tree of app features with key files and modules.
- Context pack preview: what the agent is about to use before coding.
- Drift warning panel: affected files/modules/features after git diff.
- Knowledge diff view: when code changes, show how KB entries changed too.

The earlier architecture document notes that we will use:

https://github.com/earendil-works/pi/tree/main/packages/tui

The `@earendil-works/pi-tui` package appears to provide a TypeScript TUI foundation with differential rendering, synchronized output, components, editor/input components, overlays, markdown rendering, select lists, and terminal process support. That fits the need for scan progress, KB browsing, and agent interaction panes.

## Resolved Decisions and Open Design Questions

Resolved for V0:

1. First target repositories: TypeScript/JavaScript.
2. Canonical KB path: `topchester-kb/` by default, overrideable with `TOPCHESTER_KB_DIR`.
3. Runtime generated cache path: `.agents/topchester-kb-cache/`, ignored by git.
4. API: HTTP JSON-RPC core, MCP adapter/layer on top.
5. Feature model: hierarchical features plus graph relationships.
6. Drift enforcement: non-strict warning mode first.
7. KB generation system name: Knowledge Compiler; deterministic scanning is a subphase.
8. File inclusion policy: include product-affecting source/config/package metadata/lockfiles/schemas/migrations/scripts/tests/docs; exclude generated code, build output, vendored dependencies, caches, and ignored files by default.
9. Human approval policy: minimal by default; ask only for suspected drift/corruption, destructive rewrites, contradictory facts, low-confidence/high-risk restructuring, or ambiguous inclusion rules.
10. Massive repo policy: detect huge size early, warn about cost/time, and proceed best-effort rather than failing by default. Optimize later with shards, background jobs, lazy extraction, and cheaper/faster models.
11. Semantic change policy: every in-scope file hash change is potentially semantic and can propagate through all layers. Update or mark stale/suspect through L1, L2, and L3; never assume a tiny diff is harmless.
12. PR policy for KB files: generated plaintext KB changes are not manually semantically reviewed in PRs. If generated by the Knowledge Compiler and validation passes, accept them by default.
13. Framework policy: no first-class TypeScript framework optimizations in V0. Detect frameworks/packages/versions, record metadata/hints/relationships, and rely on generic code intelligence, model reasoning, and search/discovery escape hatches.

Implementation details to refine before hardening:

1. The exact propagation algorithm for conservative stale/suspect marking across L1/L2/L3.
2. The mechanical PR/CI checks that prove the generated KB is reproducible and valid.
3. The escape-hatch workflow for framework behavior that is unclear from local code and metadata.

## Tentative V0 Scope

A practical first version could be:

1. Canonical `topchester-kb/` directory with JSON files for L1/L2/L3 and JSONL edges.
2. JSON Schema validation.
3. TypeScript/JavaScript-first, framework-neutral Knowledge Compiler with git-tracked file inventory, repo-size detection, framework/package/version metadata detection, and hash computation.
4. L1 entries for every in-scope product-affecting file, including source, config, package metadata, lockfiles, schemas, migrations, scripts, tests, and docs.
5. L2 module grouping based primarily on directories plus agent refinement.
6. Hierarchical L3 feature discovery from docs, tests, routes, commands, screens, and repeated domain concepts.
7. Non-strict but conservative drift checker for files/modules/features with prominent warnings: every in-scope file change can propagate through all layers until regenerated.
8. Local HTTP JSON-RPC API with:
   - `kb.search`,
   - `kb.getNode`,
   - `kb.neighbors`,
   - `kb.contextPack`,
   - `kb.driftCheck`,
   - `kb.impact`.
9. MCP adapter over the same KB service.
10. Generated SQLite cache for fast search/FTS, ignored by git.
11. TUI views for scan progress, feature map, context pack, and drift state.

## Working Thesis

The agent gets better than generic coding agents because it is not merely retrieving snippets.

It maintains an explicit, committed, drift-aware model of the application:

- L1: every file,
- L2: modules and responsibility boundaries,
- L3: actual application features and behavior,
- graph edges: how all of those things relate,
- hashes: whether the understanding still matches code,
- API: fast context assembly for coding tasks.

If the KB is stale, the agent knows it is stale.

If the KB is current, the agent starts work from compiled understanding instead of raw rediscovery.
