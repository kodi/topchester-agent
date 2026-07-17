# Built-In Topchester Product Knowledge

> Superseded on 2026-07-17 by `2026-07-17-remove-embedded-product-knowledge-plan.md`. Product help now uses packaged static skills; the generated product-KB source and release-time regeneration were removed.

## Summary

Give Topchester accurate, version-matched knowledge about its own configuration, commands, knowledge-base behavior, skills, hooks, sessions, and troubleshooting while it is working in any repository.

The target state keeps two kinds of knowledge separate:

- the existing workspace KB describes the repository being edited and remains mutable through `topchester kb init`, `sync`, `status`, and `reset`;
- a new read-only Topchester product source ships with the installed package and describes the matching Topchester version.

A small built-in `topchester` skill routes explicit product-help requests and remains useful even before automatic product retrieval is complete. Runtime retrieval later searches the workspace and product sources independently, keeps source/version provenance, and injects only relevant entries.

This plan is intentionally sliced so the cross-repo skill improvement can ship before the larger multi-source KB refactor.

## Decisions

- Do not point `TOPCHESTER_KB_DIR` at the Topchester repository or its generated KB when working elsewhere. That setting continues to mean the current workspace's one mutable project KB.
- Keep `topchester-kb/` and `.agents/topchester-kb-cache/` as workspace-scoped paths with their existing commands and drift semantics.
- Ship product knowledge as a separate read-only package resource under `resources/knowledge/topchester/`.
- Use a separate portable product manifest. Do not package the current workspace `topchester-kb/manifest.json`, which contains machine-local absolute paths and queue locations.
- Add a built-in `topchester` router skill. Keep `topchester-config` working as a compatibility/focused skill rather than renaming or removing it.
- Add a read-only agent tool for linked skill files because `SkillsService.readLinkedFile(...)` already supports safe reads but is not exposed to the model.
- Use explicit includes and excludes in `knowledge/topchester-pack.jsonc` for product-pack inventory. Do not add `.topchesterignore` in V0 and do not reuse the Topchester repository's normal `ignore.paths`, which currently excludes public docs.
- Build/update the committed product pack only through an explicit developer task that may use the configured summarizer model.
- Make product-pack validation deterministic and model-free. CI and package publication run the check, not automatic regeneration.
- Tie the built-in product manifest to `package.json` version and reject or omit a mismatched pack rather than silently presenting it as current.
- Query product knowledge automatically for Topchester-shaped requests, including when the current workspace has no project KB.
- Preserve `topchester search`, `topchester kb search`, and `topchester kb context` project-only defaults for compatibility. Add explicit `--source` selection and source diagnostics instead of silently changing CLI output.
- Keep `topchester kb init`, `sync`, `dry-run`, `status`, and `reset` project-only. A read-only built-in source can never be synced or reset by those commands.
- Do not add public `knowledge.sources` config in V0. The matching built-in product source is part of the runtime, not a user-mounted external KB. A future user/organization source design can extend the source registry separately.
- Keep the existing `TOPCHESTER_DISABLE_L1_CONTEXT=1` escape hatch disabling automatic context injection until a broader setting is intentionally designed.
- Every injected product entry must identify `sourceId`, product version, source path, and content hash.
- Continue treating retrieved KB summaries as orientation: task-critical claims should still be checked against live workspace files when those files are available.

## Scope

Included:

- Correct current Topchester config/skill/doc inconsistencies before using those files as product-pack inputs.
- A built-in `topchester` router skill and curated linked references.
- A safe read-only `skill_read` tool for linked `references`, `templates`, `scripts`, and `assets` files.
- Knowledge-source types and a registry for workspace and built-in product sources.
- A portable, versioned product knowledge manifest and committed L1 entries.
- Explicit product-pack include/exclude configuration.
- Developer sync/check tasks and package inclusion.
- Source-aware search, context-pack assembly, routing, budgets, and provenance.
- Automatic runtime product-context injection without requiring a workspace KB.
- CLI and slash-command source diagnostics and explicit source selection.
- Unit, integration, packaging, smoke, and documentation coverage.

Out of scope:

- Remote or network-fetched product knowledge.
- User-installed, organization, marketplace, or server-hosted KB sources.
- A general public `knowledge.sources` config schema.
- Automatic product-pack regeneration during install, startup, normal build, or publication.
- Mutating a built-in product source through normal `kb` commands.
- Replacing `AGENTS.md`, project instructions, skills, or the project KB with one combined system.
- L2/L3/graph generation for the product pack; V0 uses the existing L1 search model.
- Embeddings or a vector database.
- A dedicated product-knowledge TUI browser.
- Removing `topchester-config` or changing existing skill override precedence.
- Making public docs the only authority for implementation work inside the Topchester repository. Current source and tests remain authoritative there.

## Current State

### Skills already travel across repositories

- `package.json` includes `skills/` in the published files.
- `src/skills/roots.ts` resolves the installed package's `skills/` directory as the lowest-precedence read-only built-in root.
- Workspace and user skills can shadow built-ins by name.
- `skills/topchester-config/SKILL.md` already covers config, providers, ignore paths, hooks, and project instructions.
- `/skill <name>`, `/<skill-name>`, and `@skill-name` explicitly activate a skill.
- The base prompt advertises `skills_list` and `skill_view`; it does not inject all skill bodies.

### Linked skill files are not model-readable

- `src/skills/scanner.ts` discovers files below `references/`, `templates/`, `scripts/`, and `assets/`.
- `SkillsService.readLinkedFile(...)` validates containment and reads those files.
- `src/agent/tools/skills.ts` exposes only `skills_list` and `skill_view`, so the model cannot call the linked-file read method.

### Knowledge is currently one workspace source

- `getKnowledgeStatus(workspaceRoot)` resolves one canonical KB path from `TOPCHESTER_KB_DIR` or `topchester-kb/`.
- Search and context-pack functions derive that one path again from the workspace root.
- `TopchesterAgentRuntime.buildPromptWithKnowledgeContext(...)` returns before retrieval if the workspace KB is missing or not ready.
- The current context pack has workspace and KB paths but no general source id/kind/version contract.
- Runtime search reloads an in-memory L1 index from files; there is no source registry or cross-source result merger.

### Workspace sync and ignore behavior

Current project inventory applies:

1. built-in safety exclusions such as `.git`, dependencies, build output, agent state, KB cache, and `topchester-kb`;
2. nested `.gitignore` files;
3. `topchester.jsonc` `ignore.paths` rules.

`topchester.jsonc` itself is a built-in excluded input. The Topchester repository's current project config also excludes `docs/**/*.md`, the lockfile, and `.agents/**/*.md`. Those rules must not control the product pack because the public docs are primary product-help inputs.

### The local Topchester KB is not portable

The current generated manifest records absolute `workspaceRoot`, queue, and `.gitignore` paths. The repository also ignores `topchester-kb/`. It is suitable as local workspace knowledge but not as a committed npm package resource.

### Product guidance has known drift

Before creating the pack, reconcile at least these confirmed inconsistencies:

- `skills/topchester-config/SKILL.md` says provider config lives below `models.providers`, while the current config schema accepts top-level `providers`.
- `docs/configuration/project-instructions.md` uses `projectInstructions`, while the current config schema and skill use `instructions`.
- `topchester-config` describes `TOPCHESTER_CONFIG` and `--config` as two sequential layers, while current behavior treats them as one selected-profile slot with CLI selection shadowing the environment selection.
- The skill's verification command uses a direct package-manager command even though this repository requires checks through mise tasks.

## Target Behavior

| Situation                                                                     | Expected behavior                                                                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Work in a repo with no project KB and ask how Topchester ignore paths work    | Retrieve the installed Topchester product source and explain the matching version                                |
| Work in a repo with a ready project KB and ask about application architecture | Use project knowledge; do not add unrelated Topchester manual content                                            |
| Ask how to configure Topchester for the current repo                          | Use product knowledge for the config contract and inspect the repo's current `topchester.jsonc` for local values |
| Explicitly invoke `@topchester`                                               | Load the built-in skill and use its product-help routing instructions                                            |
| Run `topchester kb sync`                                                      | Update only the workspace project KB                                                                             |
| Run `topchester kb search --source topchester "ignore paths"`                 | Search only the read-only packaged product source                                                                |
| Run `topchester kb context --source all "configure knowledge sync"`           | Return a provenance-preserving merged context pack                                                               |
| Installed package and product manifest versions differ                        | Report the built-in source as invalid/unavailable; never label it current                                        |
| Product source is missing or corrupt                                          | Log/report the source failure and continue normal project work                                                   |
| Project KB is missing                                                         | Product retrieval remains available; existing startup guidance for creating project knowledge remains            |
| Product-pack inputs changed without regeneration                              | Deterministic pack check fails in local CI/package validation                                                    |

## Recommended Architecture

### Source contract

Introduce a small source abstraction rather than teaching every caller about package paths:

```ts
export type KnowledgeSourceKind = "workspace" | "builtin-product";

export interface KnowledgeSourceDescriptor {
  id: "project" | "topchester";
  kind: KnowledgeSourceKind;
  rootPath: string;
  readOnly: boolean;
  ready: boolean;
  supportsSync: boolean;
  version?: string;
  warning?: string;
}

export interface LoadedKnowledgeSource extends KnowledgeSourceDescriptor {
  index: L1InMemoryIndex;
  entryCount: number;
  invalidEntryCount: number;
}
```

Suggested modules:

```text
src/knowledge/sources/types.ts
src/knowledge/sources/workspace.ts
src/knowledge/sources/builtin-product.ts
src/knowledge/sources/registry.ts
src/knowledge/sources/routing.ts
src/knowledge/sources/merge.ts
```

The exact split can be adjusted during implementation, but package path/version validation, source routing, and result merging should not accumulate inside `runtime/index.ts`.

### Product pack layout

```text
resources/knowledge/topchester/
  manifest.json
  l1-files/
    docs/configuration/config-files.md.json
    docs/configuration/ignore-paths.md.json
    ...
```

Use existing L1 entry validation for entry files. Add a separate product manifest schema containing only portable data:

```ts
interface ProductKnowledgeManifest {
  formatVersion: 1;
  sourceId: "topchester";
  sourceKind: "builtin-product";
  productVersion: string;
  compiler: { name: string; version: number };
  generatedAt: string;
  sourceRevision?: string;
  packSpecHash: string;
  sourceFileCount: number;
  entryCount: number;
  sourceFiles: Array<{ path: string; contentHash: string }>;
}
```

Do not store workspace roots, queue paths, cache paths, home paths, or absolute `.gitignore` paths in the product manifest.

### Product input specification

Add `knowledge/topchester-pack.jsonc`:

```jsonc
{
  "id": "topchester",
  "include": [
    "docs/getting-started/**/*.md",
    "docs/configuration/**/*.md",
    "docs/features/**/*.md",
    "docs/hooks/**/*.md",
    "docs/mcp/**/*.md",
    "docs/reference/**/*.md",
    "skills/topchester*/**",
    "agents.json",
  ],
  "exclude": ["docs/plans/**", "docs/KNOWLEDGE.md", "test/**", "bench/**"],
}
```

The builder should reuse the inventory glob machinery where practical, but this specification is an allowlisted product-build input, not another runtime config layer.

### Runtime retrieval

```text
user message
  -> enumerate valid sources
  -> route query to project and/or product source
  -> search selected indexes independently
  -> apply per-source thresholds and caps
  -> merge without losing source provenance
  -> inject one bounded context section
  -> continue normal conversation/tool loop
```

Rules:

- Project source is eligible whenever it is ready.
- Product source is eligible when routing identifies Topchester product intent or explicit source selection requests it.
- Explicit mentions such as `Topchester`, `topchester.jsonc`, `TOPCHESTER_*`, `/kb`, and `topchester kb` must route to the product source.
- Broader phrases such as knowledge sync, project instructions, provider setup, Topchester hooks, or Topchester skills should be covered by tested routing terms without matching ordinary application code too broadly.
- Product results receive a separate small cap, initially at most three entries.
- Project results keep the existing limit/threshold behavior unless tests justify a change.
- A source failure does not suppress successful results from another source.
- The merged prompt explicitly labels each source and version.
- Cache loaded product indexes at runtime scope because packaged entries cannot drift during the process.
- Preserve current logging, adding selected source ids, per-source match counts, versions, and warnings without logging full knowledge bodies at debug level.

### Skill role

The built-in `topchester` skill is a product-help router and procedure layer. Its `SKILL.md` should:

- explain when to use product knowledge;
- distinguish product facts from current-repository facts;
- instruct the model to inspect live `topchester.jsonc`, `AGENTS.md`, or workspace state when the answer depends on local values;
- list the available linked references;
- warn against using `TOPCHESTER_KB_DIR` to mount the built-in product source;
- keep exact commands and config examples compact.

Linked references should provide a useful fallback if automatic KB retrieval is unavailable, but they should not duplicate the full generated pack.

### CLI contract

Add:

```text
topchester kb sources
topchester kb search --source project|topchester|all <query>
topchester kb context --source project|topchester|all <query>
```

Compatibility rules:

- Omitted `--source` continues to mean `project` for CLI search/context.
- The top-level `topchester search` alias stays project-only in V0.
- `kb sources` performs no model or network work.
- `kb sources` reports source id, kind, path label, version, readiness, read-only state, and any validation warning.
- User-facing output for the installed source should use a package-relative label rather than exposing a full installation path unless `--json` explicitly requests structured diagnostics.
- Add `/kb sources` to slash commands. Do not add slash-command search/context until a separate UX need exists; ordinary chat already uses automatic retrieval.

## Cross-Slice Rules

- Preserve all existing project KB commands and default CLI output until source-specific behavior is explicitly added and tested.
- Never sync, reset, drift-check, or write into the packaged product source during a normal Topchester session.
- Never let a missing product source prevent the agent from working in the current repo.
- Never let a missing workspace KB prevent product-help retrieval.
- Keep source provenance through search results, context packs, logs, CLI JSON, and prompt formatting.
- Keep generated product knowledge committed and reviewable, but treat the deterministic check as the freshness gate.
- Do not run a model during normal build, install, CI check, package publication, or startup.
- Use the package version as the product-source version contract.
- Keep generated resources out of workspace inventory to avoid recursive compilation.
- Keep product source content local; no network fetch is required for retrieval.
- Use mise tasks for repository checks and automation.
- Update public docs and `docs/reference/cli.md` in the same slice that changes user-visible commands or behavior.
- Record actual verification commands and findings in this plan when each slice completes.

## Data Flow

### Explicit skill activation

```text
@topchester question
  -> existing mention activation loads skills/topchester/SKILL.md
  -> skill names the relevant linked reference or product topic
  -> skill_read loads a bounded linked file when needed
  -> model inspects current workspace config/files for local facts
```

### Automatic product retrieval

```text
normal user message
  -> source registry resolves project + packaged Topchester source
  -> routing selects eligible sources
  -> source-aware L1 search
  -> per-source selection and merge
  -> provenance-bearing context prompt
  -> normal agent loop
```

### Product pack update

```text
maintainer changes public docs/skill references
  -> mise run knowledge-product-sync
  -> selected files are summarized into a staging output
  -> portable manifest and L1 entries replace resources/knowledge/topchester
  -> mise run knowledge-product-check validates source hashes, schemas, and package version
  -> generated changes are committed with source changes
```

Use a staging directory under the repository's generated cache or system temp directory and replace the product output only after the complete pack validates. A failed generation must not leave a partially updated committed pack.

## Edge Cases

- Installed bundle path differs from the source checkout layout.
- `dist` execution resolves `import.meta.url` differently from direct TypeScript tests.
- Product manifest is missing, malformed, from another package version, or contains an unsupported format version.
- One or more product L1 entries are invalid.
- Product pack includes a path no longer allowed by its specification.
- Source inputs changed but generated entries were not refreshed.
- Pack generation fails midway or the summarizer is unavailable.
- Workspace contains its own skill named `topchester`, shadowing the built-in skill. Product KB remains available because source loading is independent of skill precedence.
- Workspace has a folder named `resources/knowledge/topchester`; it must not shadow the installed product source.
- Query matches both a project feature called "Topchester" and the product manual.
- Generic words such as "hooks", "skills", or "config" cause false product routing.
- Product and project entries share the same `file:<path>` id. Merged results must key identity by `(sourceId, entryId)`, not entry id alone.
- `TOPCHESTER_KB_DIR` points outside the workspace. It still affects only the project source.
- Existing `TOPCHESTER_DISABLE_L1_CONTEXT=1` disables both project and product context injection but should not disable explicit CLI search or skill activation.
- User config contains secrets. Product retrieval must describe config shape without reading or logging secret values beyond existing workspace tool behavior.
- Package publication omits the resource directory.

## Files To Add

Likely additions:

- `skills/topchester/SKILL.md`
- `skills/topchester/references/configuration.md`
- `skills/topchester/references/knowledge-base.md`
- `skills/topchester/references/commands.md`
- `skills/topchester/references/troubleshooting.md`
- `knowledge/topchester-pack.jsonc`
- `resources/knowledge/topchester/manifest.json`
- generated entries under `resources/knowledge/topchester/l1-files/`
- `scripts/knowledge/build-topchester-pack.ts`
- `scripts/knowledge/check-topchester-pack.ts`
- `src/knowledge/sources/types.ts`
- `src/knowledge/sources/workspace.ts`
- `src/knowledge/sources/builtin-product.ts`
- `src/knowledge/sources/registry.ts`
- `src/knowledge/sources/routing.ts`
- `src/knowledge/sources/merge.ts`
- `src/knowledge/product/manifest.ts`
- `test/knowledge-sources.test.ts`
- `test/product-knowledge-pack.test.ts`
- a smoke scenario under `scripts/smoke/scenarios/` for product help in a repo without a project KB

## Files To Change

Likely changes:

- `package.json`
- `.mise.toml`
- `skills/topchester-config/SKILL.md`
- `src/skills/service.ts` if the linked-file result contract needs tightening
- `src/agent/tools/skills.ts`
- `src/agent/tools/registry.ts`
- `src/agent/profiles.ts`
- `src/agent/prompts.ts`
- `src/knowledge/search.ts`
- `src/knowledge/status.ts` or a new source-aware status boundary
- `src/agent/runtime/index.ts`
- `src/agent/runtime/knowledge.ts`
- `src/agent/commands.ts`
- `src/cli.ts`
- `test/skills.test.ts`
- `test/tools.test.ts`
- `test/agent-runtime.test.ts`
- `test/knowledge-search.test.ts`
- `test/commands.test.ts`
- `test/cli.integration.test.ts`
- `test/tui.render.test.ts` if `/kb sources` changes rendered command output
- `docs/configuration/config-files.md`
- `docs/configuration/project-instructions.md`
- `docs/configuration/ignore-paths.md`
- `docs/features/knowledge-base.md`
- `docs/features/skills.md`
- `docs/reference/config-schema.md`
- `docs/reference/cli.md`
- `docs/reference/changelog.md`
- `docs/KNOWLEDGE.md`
- `docs/plans/kb-implementation-checklist.md`

## Slices

### Slice 1: Correct And Pin Product Guidance

Status: `[x]` Done

Goal: Reconcile confirmed config, instruction, and verification-command drift before those files become product-pack inputs.

Why here: A packaged and automatically retrieved knowledge source would amplify current documentation errors. The canonical user-facing material must be corrected first.

This slice should implement:

- Recheck current config loading, normalized schema, instruction config, ignore behavior, and command names against source and tests.
- Correct `skills/topchester-config/SKILL.md` provider nesting, selected-profile precedence, and repository verification commands.
- Correct public docs that use `projectInstructions` instead of `instructions`.
- Reconcile config schema examples and provider placement across the config docs.
- Add focused tests or fixtures for any behavior that was ambiguous rather than encoding an unverified doc claim.
- Record which public documents are approved inputs for the first product pack.

Expected output:

- The existing built-in config skill gives accurate cross-repo guidance.
- Public config and project-instruction examples match current parsing behavior.
- No product source or runtime retrieval behavior changes yet.

Verification:

```sh
mise run test
mise run typecheck
mise run format-check
```

Dependencies: none.

### Slice 2: Cross-Repo Topchester Skill And Linked-File Tool

Status: `[x]` Done

Goal: Ship an immediately usable built-in `topchester` skill with safe access to its curated references.

Why here: This provides cross-repo self-knowledge using the existing skill packaging and activation path before the KB source refactor begins.

This slice should implement:

- Add `skills/topchester/SKILL.md` as a compact router for Topchester product questions.
- Add curated linked references for configuration, KB behavior, commands, and troubleshooting.
- Add `skill_read` with `{ name, group, path }` arguments using `SkillsService.readLinkedFile(...)`.
- Keep `skill_read` read-only, traversal-safe, size-bounded, and available to the same read-only profiles as `skill_view`.
- Register the tool and add prompt guidance for reading only a reference named by an inspected or activated skill.
- Preserve existing skill precedence and explicit activation forms.
- Ensure `topchester-config` remains available and accurate.
- Add package/discovery, tool parsing/execution, profile permission, containment, missing-file, and truncation tests.
- Update skill docs with the new built-in and linked-file behavior.

Expected output:

- In any repository, `@topchester`, `/topchester`, and `/skill topchester ...` load the built-in product-help router.
- The model can safely read packaged linked references without workspace file access.
- No automatic product knowledge is injected yet.

Verification:

```sh
mise run test
mise run typecheck
mise run format-check
```

Manual check:

```text
topchester run "/skill topchester explain where KB ignore rules live"
```

Dependencies: Slice 1.

### Slice 3: Knowledge Source Contract With Project-Only Parity

Status: `[x]` Done

Goal: Introduce source-aware loading/search/context types while preserving current project-only behavior.

Why here: Multi-source retrieval should be built on a tested abstraction before adding a second source or changing runtime routing.

This slice should implement:

- Add knowledge source descriptor/loaded-source types.
- Wrap the existing `getKnowledgeStatus(...)` and `topchester-kb/` path as the `project` workspace source.
- Refactor L1 index loading so callers can load an explicit source root rather than always deriving it from `workspaceRoot`.
- Add `sourceId`, `sourceKind`, optional `sourceVersion`, and read-only metadata to internal search/context results.
- Keep current exported workspace helpers as compatibility wrappers where useful.
- Make merged identity source-aware so equal L1 ids from different sources cannot collide.
- Keep runtime, CLI, slash commands, status, sync, and prompt output behavior unchanged in this slice.
- Add parity tests proving existing project search/context results and missing-KB errors remain stable.

Expected output:

- Project knowledge uses the new source contract internally.
- No built-in source is loaded and no user-visible behavior changes.
- Later slices can add a source without another search-layer rewrite.

Verification:

```sh
mise run test
mise run typecheck
mise run format-check
```

Dependencies: Slice 2, so the source refactor does not overlap the skill/tool prompt changes.

### Slice 4: Portable Product Pack Builder And Package Resource

Status: `[x]` Done

Goal: Generate, validate, commit, and package a portable Topchester L1 product source.

Why here: Runtime code should not depend on a product source until its format, update workflow, and packaging are independently proven.

This slice should implement:

- Add `knowledge/topchester-pack.jsonc` with explicit includes/excludes.
- Add strict pack-spec and portable-manifest schemas.
- Extract or adapt compiler functions so the product builder accepts explicit input/output/cache locations without changing global environment variables.
- Reuse L1 entry generation and validation where possible.
- Stage complete output and atomically replace `resources/knowledge/topchester/` only after validation.
- Strip all absolute paths and queue/cache fields from the portable manifest.
- Record source file hashes, pack-spec hash, compiler identity, package version, and optional Git revision.
- Add `knowledge-product-sync` and deterministic `knowledge-product-check` mise tasks.
- Ensure the check validates manifest schema, entry schemas, exact source inventory/hashes, entry count, allowed paths, compiler format, and package version.
- Add `resources/knowledge` to npm package files.
- Add a package-content verification task/check that proves the skill references and product manifest/entries are present.
- Generate and commit the first pack from the corrected approved inputs.
- Ensure normal workspace inventory excludes `resources/knowledge/topchester/` to prevent recursive KB ingestion, either through a narrow built-in exclusion or the repository's project config with tests documenting the choice.

Expected output:

- A portable product source exists as a tracked package artifact.
- Maintainers can update it explicitly with a configured model.
- CI/publication can prove freshness without invoking a model.
- Normal runtime does not consume it yet.

Verification:

```sh
mise run knowledge-product-check
mise run package-check
mise run test
mise run typecheck
mise run format-check
```

Generation verification during implementation:

```sh
mise run knowledge-product-sync
mise run knowledge-product-check
```

Dependencies: Slices 1 and 3. The packaged artifact remains unused by runtime until Slice 5.

### Slice 5: Built-In Source Loading And Automatic Runtime Retrieval

Status: `[x]` Done

Goal: Load the matching packaged product source and inject relevant Topchester context automatically alongside project context.

Why here: The source abstraction and valid packaged artifact must exist before changing prompt assembly.

This slice should implement:

- Resolve the installed package resource path robustly in source tests and bundled `dist` execution.
- Validate manifest format and exact `package.json` product version before exposing the source as ready.
- Add the `topchester` read-only source to the runtime source registry.
- Add deterministic product-intent routing with focused positive and negative tests.
- Search eligible sources independently and merge results with source-aware identities, thresholds, and caps.
- Cache the packaged product index for the runtime lifetime.
- Refactor `buildPromptWithKnowledgeContext(...)` so it does not return merely because the workspace KB is absent.
- Preserve current project-context selection limits while initially capping product results at three.
- Format prompt context with visible source id, source kind, version, paths, hashes, drift semantics, and warnings.
- Treat the product source as immutable/version-checked rather than workspace drift-checked.
- Keep source failures non-blocking and independently logged.
- Make the existing context-disable escape hatch cover the combined automatic context.
- Add runtime tests for product-only, project-only, combined, no-match, source-failure, version-mismatch, collision, and disable behavior.

Expected output:

- Topchester can answer product questions from its installed version in a repository with no project KB.
- Ordinary repository questions do not receive unrelated product-manual content.
- Combined prompts preserve which facts came from which source.

Verification:

```sh
mise run knowledge-product-check
mise run test
mise run typecheck
mise run format-check
```

Dependencies: Slices 3 and 4.

### Slice 6: Source Diagnostics And Explicit CLI Selection

Status: `[x]` Done

Goal: Make source availability and source-specific search inspectable without changing existing command defaults.

Why here: Diagnostics should describe the real runtime source registry after product loading works, and they provide the main troubleshooting surface for packaging/version failures.

This slice should implement:

- Add `topchester kb sources`.
- Add `--source project|topchester|all` to `topchester kb search` and `topchester kb context`.
- Keep omitted source and top-level `topchester search` project-only.
- Add `/kb sources` and TUI command suggestions.
- Keep `/kb init`, `sync`, `status`, and `reset` explicitly project-only in wording and implementation.
- Add source diagnostics to `topchester info` if it can remain a cheap, model-free filesystem check.
- Return clear usage errors for invalid source ids and clear readiness errors for explicit unavailable sources.
- Add text and JSON output tests, CLI integration tests, slash-command tests, and TUI rendering tests.
- Update CLI, KB, skills, configuration, and changelog docs in the same slice.

Expected output:

- Users and maintainers can see which knowledge sources are active and why one is unavailable.
- Existing project-only CLI scripts continue to behave as before.

Verification:

```sh
mise run knowledge-product-check
mise run test
mise run typecheck
mise run format-check
```

Manual checks:

```sh
topchester kb sources
topchester kb search --source topchester "ignore paths"
topchester kb context --source all "configure knowledge sync" --json
```

Dependencies: Slice 5.

### Slice 7: Release Gate, Smoke Coverage, And Cleanup

Status: `[x]` Done

Goal: Prove the packaged feature end to end and make stale or omitted product knowledge fail before release.

Why here: Release and smoke gates should be added only after the final command and runtime contracts are stable.

This slice should implement:

- Add the deterministic product-pack check to the appropriate local CI and publication path.
- Ensure normal package build still performs no model/network work.
- Add a smoke scenario that runs Topchester in a fixture repository with no project KB and verifies a Topchester-specific answer is grounded in the built-in source.
- Add a negative smoke/unit case showing an ordinary repository task does not receive product context.
- Verify npm package contents from a built artifact, not only source-checkout discovery.
- Update `docs/KNOWLEDGE.md` and `docs/plans/kb-implementation-checklist.md` with the implemented source distinction.
- Remove temporary compatibility helpers introduced during the source refactor once all callers use the stable boundary.
- Review user-facing output for machine-local path leaks.
- Record actual pack size and prompt overhead. If they exceed acceptable limits, add a follow-up slice rather than silently changing the source contract.

Expected output:

- Product knowledge is present, current, version-matched, and automatically used in a built package.
- Local CI catches stale source inputs and package omission.
- The repo has an end-to-end regression test for cross-repo Topchester self-knowledge.

Verification:

```sh
mise run knowledge-product-check
mise run package-check
mise run smoke
mise run local-ci
```

Dependencies: Slices 2 through 6.

## Final Verification

Before marking the plan complete:

```sh
mise run knowledge-product-check
mise run package-check
mise run test
mise run typecheck
mise run lint
mise run format-check
mise run smoke
mise run local-ci
```

Manual acceptance:

1. Build/package Topchester and run the built CLI from a temporary unrelated Git repository.
2. Confirm `topchester kb sources` reports a ready, read-only `topchester` source with the package version and a missing or empty project source.
3. Ask how `ignore.paths` affects KB sync and confirm the answer uses product context without requiring `topchester kb init`.
4. Explicitly invoke `@topchester` and confirm linked references can be read through `skill_read`.
5. Ask an ordinary application-code question and confirm product context is not injected.
6. Initialize/sync a fixture project KB and confirm a combined product-plus-project question preserves provenance from both sources.
7. Change a product-pack input without regenerating and confirm `mise run knowledge-product-check` fails clearly.
8. Restore the input or regenerate, then confirm the check and package validation pass.

## Open Questions

- Exact product-intent routing terms and score thresholds should be tuned from focused tests and the first smoke run. The contract is deterministic, bounded routing; the initial term list is implementation detail.
- Decide whether the package-content check should inspect `npm pack --dry-run` output or unpack a tarball. Prefer the smallest mise-wrapped method that proves installed layout resolution.
- Decide whether invalid individual product entries make the whole product source unavailable or are skipped with a warning. Recommendation: fail the deterministic package check, but at runtime skip invalid entries and expose a degraded warning if at least one valid entry remains.
- Decide whether `topchester info` should show the product source in Slice 6 or leave full source detail to `kb sources`. Include it only if the output stays compact.
- Reassess whether a public enable/disable config is needed after real use. Do not add it preemptively in V0.

## Progress Log

### 2026-07-15: Slices 3 through 7 completed

- Added source-aware loading and context contracts while keeping the existing project-only search/context wrappers and CLI defaults intact.
- Added a portable product manifest, explicit allowlisted pack specification, staged deterministic builder, model-free freshness checker, committed L1 product entries, package inclusion, and built-in workspace inventory exclusion.
- Added version-checked installed-layout source discovery, runtime-lifetime product index caching, deterministic product-intent routing, independent source search, source-aware collision handling, and provenance-bearing merged prompt context.
- Added `topchester kb sources`, `/kb sources`, and `--source project|topchester|all` for KB search/context, with text and JSON diagnostics and package-relative product paths in text output.
- Added local CI/publication gates, built-tarball runtime validation, product-only/combined/failure/collision/disable coverage, and smoke scenario `21-product-knowledge-no-project-kb`.
- Product pack measurement: 32 source files and entries, 32,747 bytes. Representative three-entry product prompt context: 2,611 bytes. No size follow-up is needed.
- Verified `mise run knowledge-product-check`, `mise run package-check`, `mise run typecheck`, `mise run lint`, and `mise run format-check`.
- Verified the full product suite with `mise run test -- --reporter=verbose` (35 files, 752 tests).
- Verified `mise run smoke` (21 passed, 0 failed), including the no-project-KB product retrieval scenario.
- Verified `mise run local-ci`: formatting, lint, type checking, product-pack freshness, package contents, and packed-CLI product-source loading/search all passed.

### 2026-07-15: Slices 1 and 2 completed

- Corrected product guidance to use top-level `providers`, the `instructions` config key, and the single selected-profile precedence contract.
- Recorded the first pack inputs through the allowlisted product-pack specification planned for Slice 4: public getting-started, configuration, feature, hook, MCP, and reference docs; `skills/topchester*/**`; and `agents.json`.
- Added the built-in `topchester` router skill with curated configuration, knowledge-base, command, and troubleshooting references.
- Added read-only `skill_read` support with linked-group containment, missing-file errors, a 64 KiB limit, prompt guidance, read-only profile access, and tool/discovery tests.
- Verified with `mise run test` (33 files, 736 tests), `mise run typecheck`, and `mise run format-check`.

### 2026-07-15: Plan created

- Confirmed built-in skills already ship from the package and are available cross-repository.
- Confirmed linked skill files can be read by the service but have no agent tool.
- Confirmed automatic KB context currently depends on one ready workspace KB.
- Confirmed the current local manifest is non-portable because it contains absolute paths.
- Confirmed normal project inventory uses built-ins, `.gitignore`, and `ignore.paths`, and that the current Topchester project config excludes docs.
- Confirmed current config skill/docs contain drift that must be corrected before product-pack generation.
- No implementation slices have started.
