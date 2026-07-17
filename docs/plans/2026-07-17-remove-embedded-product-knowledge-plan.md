# Remove Embedded Topchester Product Knowledge

## Summary

Remove the generated `resources/knowledge/topchester/` product-KB pack and return Topchester product help to packaged static skills. This avoids release commits that rewrite every generated L1 entry solely because the package version or generation timestamp changed.

## Decisions

- Keep `skills/topchester/` and its static linked references as the cross-repository product-help source.
- Tell the model to load the `topchester` skill for Topchester-specific questions.
- Keep project knowledge under `topchester-kb/` as the only KB source.
- Remove product-source search, source selection, diagnostics, generated manifests, sync/check tasks, and release regeneration.
- Keep package checks that prove built-in skills are present in installed standalone builds.

## Scope

Included: runtime prompt guidance, project-only KB restoration, CLI/slash-command cleanup, package and standalone build cleanup, publish workflow cleanup, generated artifact deletion, tests, and current docs.

Out of scope: changing project KB compilation/search semantics or redesigning the general skill system.

## Slices

### Slice 1: Static product-help route

Status: `[x]` Done

- Keep the built-in `topchester` skill and references packaged in npm and standalone artifacts.
- Add direct system-prompt guidance to load that skill for questions about Topchester itself.
- Add focused prompt/package coverage.

Verification: `pnpm test test/tools.test.ts test/skills.test.ts`

Completed with system-prompt routing to the packaged `topchester` skill and installed-package verification that built-in skills remain available.

### Slice 2: Restore project-only KB behavior

Status: `[x]` Done

- Restore automatic context injection to the mutable project KB only.
- Remove product source registry, routing, merging, `kb sources`, and `--source` options.
- Remove source-only L1 search metadata.

Verification: `pnpm test test/knowledge-search.test.ts test/commands.test.ts test/cli.integration.test.ts`

Completed by restoring project-only context injection and removing source selection from runtime, CLI, slash commands, and L1 result contracts.

Dependencies: Slice 1.

### Slice 3: Remove product-pack build and release machinery

Status: `[x]` Done

- Delete generated resources, product-pack code/spec/scripts, and product-only smoke coverage.
- Stop embedding product resources in standalone binaries.
- Stop regenerating and committing product resources during publish.
- Remove product-version checks while retaining native package and built-in-skill checks.

Verification: `mise run package-check`

Completed. `mise run package-check` packed and installed the Darwin ARM64 native package, found the built-in `topchester` skill, and ran without Bun on `PATH`.

Dependencies: Slice 2.

### Slice 4: Docs and final verification

Status: `[x]` Done

- Update current docs to describe static product-help skills and project-only KB behavior.
- Mark the previous embedded-product plan as superseded.
- Run formatting, type checking, focused tests, and repository gates.

Verification: `mise run local-ci-extended`

Completed. The full gate passed formatting, lint, type checking, 36 Node test files with 612 tests, the production OpenTUI renderer test, isolated native package install with built-in skill discovery, and the native OpenTUI PTY lifecycle smoke.

Dependencies: Slices 1 through 3.

## Progress Log

### 2026-07-17

- Confirmed built-in skills already ship from `skills/` in both package and standalone layouts.
- Confirmed the product pack duplicates 32 selected docs/skill files as generated L1 entries and is regenerated after version bumps.
- Removed 32 generated L1 files, the product manifest/spec/builder/checker, source-aware runtime modules, product-only tests/smoke coverage, and publication regeneration.
- Focused runtime, CLI, search, skill, and tool tests passed: 5 files and 246 tests.
- Type checking, lint, formatting, and `mise run package-check` passed.
- Final `mise run local-ci-extended` passed, including 612 Node tests, production OpenTUI, package installation, built-in skill discovery, and PTY lifecycle validation.
