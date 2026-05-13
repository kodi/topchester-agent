# Project Config Ignore Paths Plan

## Summary

Add a project-level Topchester config surface that can ignore specific paths before they enter KB inventory, drift checks, or other project-file scans.

For the filename, use the already documented and friendlier project config name:

```text
topchester.jsonc
```

Do not introduce `.topchesterrc.json` as the primary name. It is harder to type, easier to miss in a repo root, and would duplicate the existing documented config direction in `docs/MODEL_CONFIG.md`.

V0 should add one project-facing setting:

```jsonc
{
  "$schema": "https://topchester.com/schemas/config.v1.json",
  "ignore": {
    "paths": ["generated/**", "snapshots/**/*.json", "*.lock.backup"],
  },
}
```

The goal is a general config home with one useful first feature, not a one-off ignore file.

## Decisions

- Primary shared project config path: `topchester.jsonc`.
- Local uncommitted project overrides: `.topchester/config.local.jsonc`.
- User defaults remain under `~/.config/topchester/config.jsonc`.
- Keep the explicit override path through `TOPCHESTER_CONFIG` and CLI `--config`.
- Treat `.topchesterrc.json` as out of scope for V0. If users ask for compatibility later, it can be a read-only legacy alias with a deprecation warning.
- Use JSONC, not strict JSON, so humans can add comments and trailing commas.
- Add `ignore.paths` as an ordered list of workspace-relative glob patterns.
- Use standard glob behavior through a library such as `picomatch` or `minimatch`, rather than expanding the current hand-written gitignore matcher.
- Apply Topchester ignore rules after built-in safety exclusions and `.gitignore`.
- Keep default exclusions such as `.git/`, `node_modules/`, `.agents/topchester/`, `.agents/topchester-kb-cache/`, and `topchester-kb/` always excluded in V0.

## Scope

Included:

- Config schema extension for `ignore.paths`.
- Config loading alignment with `docs/MODEL_CONFIG.md` JSONC locations.
- Glob matching for workspace-relative POSIX paths.
- Knowledge compiler inventory support.
- Manifest or CLI output that makes config ignore usage visible enough to debug.
- Tests for config parsing, glob semantics, and inventory exclusion.
- Docs updates for config locations and `/kb compile` behavior.

Out of scope for V0:

- A separate `.topchesterignore` file.
- Interactive config editing commands.
- Per-tool allow/deny policies.
- Include rules that bypass built-in safety exclusions.
- Path ignores for arbitrary shell commands.
- Ignoring files outside the workspace root.
- Committed secrets or provider credentials.

## Current State

`docs/MODEL_CONFIG.md` already specifies the intended config layering:

1. built-in defaults
2. `~/.config/topchester/config.jsonc`
3. `topchester.jsonc`
4. `.topchester/config.local.jsonc`
5. `TOPCHESTER_CONFIG`
6. CLI flags

The implementation currently diverges from that doc. `src/config/index.ts` loads YAML paths:

- `~/.config/topchester/config.yaml`
- `topchester.yaml`
- `.topchester/config.local.yaml`

The current config schema only contains `models`.

The KB inventory already supports:

- nested `.gitignore` parsing
- built-in directory exclusions
- binary file skipping
- explicit excluded paths passed by the compiler for the configured KB and cache paths

The inventory matcher is currently custom and gitignore-shaped. It is good enough for current `.gitignore` behavior, but project config should use a known glob implementation so users get predictable `*`, `**`, `?`, character class, and brace semantics.

## Config Shape

Extend `TopchesterConfig`:

```ts
interface TopchesterConfig {
  models?: {
    defaultPurpose?: ModelPurpose;
    assignments?: Partial<Record<ModelPurpose, ModelRef>>;
    providers?: Record<string, ModelProviderConfig>;
  };
  ignore?: {
    paths?: string[];
  };
}
```

Example `topchester.jsonc`:

```jsonc
{
  "$schema": "https://topchester.com/schemas/config.v1.json",
  "ignore": {
    "paths": ["generated/**", "fixtures/large/**", "docs/archive/**/*.md", "*.snap"],
  },
}
```

Example `.topchester/config.local.jsonc`:

```jsonc
{
  "ignore": {
    "paths": [".scratch/**", "local-dumps/**"],
  },
}
```

## Glob Contract

All patterns are evaluated against workspace-relative POSIX paths, even on platforms that use backslashes.

Rules:

- A pattern must be relative. Reject absolute paths.
- A pattern must stay inside the workspace. Reject `..` path traversal.
- Match files and directories.
- A directory match excludes the directory and its descendants.
- Support standard glob tokens through the chosen library:
  - `*` matches within one path segment.
  - `**` matches across path segments.
  - `?` matches one character in one segment.
  - `[abc]` and `[a-z]` character classes work if the library supports them.
  - `{js,ts}` brace expansion works if the library supports it.
- Dotfiles should be matchable. For example, `.env*` and `.github/**` should work.
- Later rules win if negation is supported.

Negation should be supported in the rule list because users expect it from ignore-style patterns:

```jsonc
{
  "ignore": {
    "paths": ["fixtures/**", "!fixtures/important/**"],
  },
}
```

V0 should not let negation re-include files excluded by built-in safety rules. For example, `!node_modules/foo.ts` should remain ignored.

## Merge Semantics

Config objects deep-merge in the existing order. For `ignore.paths`, arrays should be concatenated in load order so user, project, local, explicit, and CLI layers can all contribute rules.

The ordered effective rule list should be:

1. user config rules
2. project config rules
3. local project config rules
4. `TOPCHESTER_CONFIG` rules
5. CLI rules, if added later

Later entries win for negation. This allows local config to exclude private scratch files without editing committed config, and it allows explicit config to override normal project behavior during a one-off command.

## Implementation Shape

Keep the config feature centered in `src/config/index.ts` and pass the resolved config into file inventory instead of making inventory read config files itself.

Likely shape:

- Update config loading to read JSONC paths documented in `docs/MODEL_CONFIG.md`.
- Keep YAML compatibility only if needed for the current dev examples, but prefer JSONC in docs and new tests.
- Add `ignore.paths` to `topchesterConfigSchema`.
- Add a small normalized `ProjectIgnoreRule` helper near the inventory module or config module.
- Use `picomatch` or `minimatch` for glob matching.
- Add `ignorePaths?: string[]` or `ignoreRules?: ProjectIgnoreRule[]` to `InventoryOptions`.
- In `src/knowledge/compiler/index.ts`, pass `config.ignore?.paths` to `listProjectFilesForL1(...)`.
- Include ignore metadata in compiler results and manifest:
  - number of config ignore patterns loaded
  - config files read, if this is already tracked by the loader
  - optionally, ignored file count by source in a later slice

Do not make `src/knowledge/compiler/inventory.ts` call `loadTopchesterConfig(...)` directly. Inventory should stay a deterministic file-listing primitive that receives options.

## Behavior To Preserve

- `.gitignore` remains respected.
- Built-in safety exclusions remain respected.
- Binary file skipping remains respected.
- The KB folder and cache folder remain excluded even when configured through env vars.
- `topchester-kb/` stays canonical KB output, not runtime config.
- Missing config files are ignored silently.
- Invalid config fails early with a clear config validation error.

## Files To Change

Likely:

- `src/config/index.ts`
- `src/app/context.ts`
- `src/knowledge/compiler/index.ts`
- `src/knowledge/compiler/inventory.ts`
- `src/knowledge/compiler/manifest.ts`
- `docs/MODEL_CONFIG.md`
- `docs/cli.md`
- `test/knowledge-compiler.test.ts`

Possible:

- `package.json`
- `pnpm-lock.yaml`
- config example files under `config/`
- generated schema docs if a schema export exists later

## Slices

### Slice 1: Config Name And JSONC Loader Contract

Status: `[x]` Done

Goal: Align config loading with the documented `topchester.jsonc` convention before adding new settings.

Why here: Ignore paths need a stable config source. The current implementation still loads YAML paths while docs describe JSONC.

This slice should implement:

- Teach the loader to read JSONC config files in the documented order.
- Keep or explicitly migrate any YAML dev config behavior.
- Add tests for precedence across user, project, local, env, and explicit config paths.
- Ensure invalid JSONC and schema errors point at the config file path.

Expected output:

- `topchester.jsonc` works as the shared project config file.
- `.topchester/config.local.jsonc` works as the local project override file.
- Existing model config tests still pass.

Verification:

```sh
pnpm test test/config.test.ts
pnpm typecheck
```

Dependencies: None.

### Slice 2: Ignore Schema And Glob Matcher

Status: `[x]` Done

Goal: Add a validated `ignore.paths` config field with predictable glob semantics.

Why here: The glob contract should be tested independently before it changes KB inventory output.

This slice should implement:

- Extend `topchesterConfigSchema` with `ignore.paths`.
- Validate that each path rule is a string and is workspace-relative.
- Add a small matcher helper using a standard glob library.
- Support negated rules while preserving built-in safety exclusions.
- Add focused tests for `*`, `**`, `?`, dotfiles, directory matches, braces or character classes if supported, and negation.

Expected output:

- Config can parse and normalize ignore path rules.
- The matcher can answer whether a workspace-relative path is ignored.

Verification:

```sh
pnpm test test/config.test.ts test/knowledge-compiler.test.ts
pnpm typecheck
```

Dependencies: Slice 1.

### Slice 3: KB Inventory Integration

Status: `[x]` Done

Goal: Apply `ignore.paths` to KB file inventory and L1 queueing.

Why here: This is the first user-visible behavior change and should happen after the config and matcher contract is stable.

This slice should implement:

- Add ignore options to `listProjectFilesForL1(...)`.
- Pass `appContext.config.ignore?.paths` or equivalent from the compiler boundary.
- Apply config ignores after `.gitignore` and before binary hashing.
- Ensure ignored directories are pruned before walking descendants.
- Add tests showing ignored files do not appear in inventory or L1 queue output.
- Add tests showing negation can re-include a config-ignored path but cannot re-include built-in excluded directories.

Expected output:

- Running `topchester kb compile` excludes configured paths from queueing and generated L1 entries.

Verification:

```sh
pnpm test test/knowledge-compiler.test.ts
pnpm typecheck
```

Dependencies: Slice 2.

### Slice 4: Diagnostics And Documentation

Status: `[x]` Done

Goal: Make ignored-path behavior visible and documented enough to debug.

Why here: Config ignores can make files disappear from the KB; users need a quick way to understand why.

This slice should implement:

- Update `docs/MODEL_CONFIG.md` with the `ignore.paths` section.
- Update `docs/cli.md` for `/kb compile` and `topchester kb compile` behavior.
- Add compile summary or manifest metadata for loaded config ignore rule count.
- Consider a future `topchester config explain` command, but do not implement it in V0.

Expected output:

- Docs show the chosen config filename, ignore examples, glob semantics, and local override path.
- Compile output gives at least a count of config ignore rules used.

Verification:

```sh
pnpm format:check
pnpm test test/knowledge-compiler.test.ts
```

Dependencies: Slice 3.

## Final Verification

Run the broader repo check after all slices land:

```sh
pnpm check
```

Manual checks:

- Create a temporary workspace with `topchester.jsonc` and `ignore.paths`.
- Run `topchester kb init`.
- Run `topchester kb compile`.
- Confirm ignored files are absent from `topchester-kb/l1-files/`.
- Confirm normal `.gitignore` and built-in exclusions still apply.

## Open Questions

1. Should V0 continue loading the current YAML config names as backward-compatible aliases, or should it switch hard to JSONC?
   - Likely answer: support YAML aliases for one release if any checked-in examples still use them, but make JSONC the documented path.
2. Should `ignore.paths` arrays concatenate across config layers or replace?
   - Recommended answer: concatenate, with later negated rules winning.
3. Should `topchester kb compile` report only the rule count, or also ignored file counts?
   - Recommended answer: start with rule count in V0, add reason-level diagnostics when a config explain command exists.
4. Should ignore rules apply to agent tools like `find_file` and `grep`?
   - Recommended answer: not in the first KB slice. The agent tools currently intentionally use `--no-ignore` for exhaustive workspace search. Changing that should be a separate tool-policy decision.

## Completion Notes

- Implemented JSONC config loading for `~/.config/topchester/config.jsonc`, `topchester.jsonc`, `.topchester/config.local.jsonc`, `TOPCHESTER_CONFIG`, and CLI `--config`, while keeping YAML aliases for current compatibility.
- Added validated `ignore.paths` with append-style merge semantics across config layers.
- Added `picomatch`-backed project ignore matching for workspace-relative POSIX globs, dotfiles, directory descendants, and config-level negation.
- Wired config ignore rules into KB inventory and compile from CLI and slash-command paths.
- Added `configIgnorePathCount` to compile results, CLI summary output, and KB manifests.
- Updated `docs/MODEL_CONFIG.md` and `docs/cli.md`.

Verification:

```sh
pnpm test test/config.test.ts test/knowledge-compiler.test.ts
pnpm typecheck
pnpm check
```

Manual artifact check:

- Temporary workspace with `topchester.jsonc` `ignore.paths: ["generated/**"]`, `.gitignore` `dist/`, `generated/client.ts`, `dist/bundle.js`, and `src/index.ts`.
- Ran KB initialization and compile through the compiler path with loaded config.
- Confirmed queued files were `.gitignore`, `src/index.ts`, and `topchester.jsonc`; `generated/client.ts` and `dist/bundle.js` were absent.
- Confirmed `manifest.configIgnorePathCount` was `1`.

## Next Slice

All V0 slices are complete.
