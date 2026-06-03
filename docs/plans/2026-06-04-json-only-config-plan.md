# JSON-Only Config Migration Plan

## Summary

Topchester should support one runtime config format: JSONC. Maintaining YAML and JSONC config paths is unnecessary for the current pre-alpha contract and keeps tests, docs, examples, and smoke fixtures split across two shapes.

## Decisions

- Use JSONC for all Topchester runtime config files.
- Load only `topchester.jsonc`, `~/.config/topchester/config.jsonc`, `TOPCHESTER_CONFIG`, and `--config <path>`.
- Do not keep YAML config aliases.
- Keep unrelated YAML uses such as skill frontmatter, `lefthook.yml`, lockfiles, and documentation examples about external tools.

## Scope

Included:

- Runtime config loader and parser.
- Config tests and CLI integration tests.
- Checked-in config examples under `config/`.
- User-facing docs, onboarding, README, and the `topchester-config` skill.
- Smoke and benchmark command references that point at Topchester config files.

Out of scope:

- Removing the `yaml` dependency, because skill frontmatter still uses it.
- Rewriting old historical plan snippets except where they are active command examples for current local workflows.

## Current State

`src/config/index.ts` parses config through the YAML parser and checks YAML aliases before JSONC. Several tests use `topchester.yaml` and `config.yaml` fixtures. Checked-in local model configs under `config/` are YAML files, and `package.json` runs dev mode with `config/example.yaml`.

## Implementation Shape

Replace YAML parsing with a small JSONC parser that accepts comments and trailing commas, then merge only the JSONC config layers. Convert all active tests and examples to JSONC so the repo no longer exercises or documents YAML config support.

## Slices

### Slice 1: Loader Contract

Status: `[x]` Done

Goal: Make runtime config loading JSONC-only.

Why here: Tests and docs should describe the final loader contract, not a temporary compatibility path.

This slice should implement:

- Remove YAML config paths from `loadTopchesterConfig`.
- Parse config files as JSONC instead of YAML.
- Keep clear error messages with the config path.
- Add focused coverage for comments/trailing commas and ignored YAML aliases.

Expected output: `src/config/index.ts` and focused config tests encode JSONC-only behavior.

Verification: `pnpm exec vitest test/config.test.ts run` passed on 2026-06-04.

Dependencies: None.

### Slice 2: Fixtures And CLI Paths

Status: `[x]` Done

Goal: Convert repo-local and test config fixtures from `.yaml` to `.jsonc`.

Why here: The CLI and smoke workflows should exercise the real supported format.

This slice should implement:

- Rename checked-in `config/*.yaml` Topchester configs to `.jsonc`.
- Update package scripts, CLI tests, smoke scripts, and benchmark examples.
- Ensure invalid-config tests use `.jsonc` fixtures.

Expected output: No active Topchester runtime config examples use `.yaml`.

Verification: `pnpm exec vitest test/cli.integration.test.ts run` passed on 2026-06-04.

Dependencies: Slice 1.

### Slice 3: Docs And Skill Cleanup

Status: `[x]` Done

Goal: Remove YAML config guidance from user-facing docs and reusable skill instructions.

Why here: Users and future agents should see one source of truth.

This slice should implement:

- Update README, onboarding, docs/config, config-file reference, hooks examples, ignore paths, and `skills/topchester-config/SKILL.md`.
- Preserve unrelated YAML documentation where it is not about Topchester runtime config.

Expected output: Docs consistently say Topchester config is JSONC-only.

Verification: `rg -n "topchester\\.ya?ml|config\\.ya?ml|YAML is accepted|compatibility alias" README.md onboarding.md docs skills scripts package.json src test` only returns the intentional ignored-YAML test and historical implementation plans.

Dependencies: Slices 1 and 2.

### Slice 3.1: First-Run Starter Config

Status: `[x]` Done

Goal: Give a new install a discoverable config example in the user config file itself.

Why here: The JSONC-only migration makes the first config path unambiguous, so startup can create a harmless commented starter file.

This slice should implement:

- On first app context startup, create `~/.config/topchester/config.jsonc` if it does not exist.
- Fill it with the Quickstart minimal OpenRouter config, fully commented out.
- Treat comments-only JSONC files as empty config.
- Never overwrite an existing user config.

Expected output: A first Topchester start leaves users with an editable commented config example and no configured model until they uncomment it.

Verification: `pnpm exec vitest test/config.test.ts run` passed on 2026-06-04.

Dependencies: Slice 1.

## Final Verification

- `pnpm exec vitest test/config.test.ts test/cli.integration.test.ts run` passed on 2026-06-04.
- `pnpm check` passed on 2026-06-04.
- Stale-reference search only returns the intentional ignored-YAML test, current/historical plan notes, and unrelated YAML uses such as skill frontmatter and lockfiles.
