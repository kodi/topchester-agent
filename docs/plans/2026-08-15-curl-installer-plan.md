# Curl Installer Plan

Status: core installer complete; curl-installed self-update follow-up planned

Created: 2026-08-15

Topchester baseline: `b83cfb569f46af1575fe9dbb2a9d06349e35261f`

OpenCode reference baseline: `0bc9a28b5eeac8f85e7e16e53cadb33498a02bbb`

Codex reference baseline: `4d4837c4951375c877986e239304c95ebbe14633`

## Summary

Add a host-ready shell installer that puts one standalone Topchester binary in an app-owned user directory. This avoids tying the command to whichever Node version or mise environment happened to run `npm install -g`.

The installer source will live in this repository and work when run from a local checkout or served over HTTPS. Hosting the script is not part of this change.

## Decisions

- Install the binary at `~/.topchester/bin/topchester` by default and allow `TOPCHESTER_INSTALL_DIR` or `--install-dir` to override it.
- Download Topchester's existing platform-tagged `topchester-ai` npm artifact. Do not add a second binary publishing pipeline.
- Support the same release matrix as `scripts/standalone/targets.ts`: Apple Silicon macOS and glibc Linux on ARM64 or x64.
- Write portable POSIX `sh` so the hosted command can use `curl ... | sh`.
- Resolve `latest` from the npm registry and allow an exact version through `--version` or `TOPCHESTER_VERSION`.
- Verify the registry checksum and run the staged binary's `--version` before replacing an existing install.
- Add one marked, idempotent shell-profile block that prepends the app-owned bin directory. Support `--no-modify-path` for managed environments.
- Keep `--binary` as a local/offline installation path so the installer can be tested without hosting or downloading.
- Do not uninstall existing npm/mise copies automatically. Report when another `topchester` currently wins command lookup so the user can remove old copies deliberately.

## Scope

Included:

- installer script and local usage notes in one dedicated folder
- platform and libc detection
- latest and exact-version downloads from the npm registry
- checksum, executable, and version validation
- atomic replacement that keeps the old binary when validation fails
- shell `PATH` setup for zsh, bash, fish, and a generic profile fallback
- a repository `mise` task that checks syntax, local binary installation, replacement, and failure behavior

Out of scope:

- choosing or configuring the public installer URL
- adding GitHub release archives or a new artifact host
- Windows, Intel macOS, or musl Linux support
- deleting npm packages from existing Node or mise installations
- changing Topchester's in-app update behavior

## Reference Findings

- Official Grok Build installs under `~/.grok`, selects a native OS/architecture binary, validates it before replacement, and manages a marked shell-profile block.
- Local OpenCode installs under `~/.opencode/bin`, supports exact versions and a local binary path, and can skip shell-profile edits.
- Local Codex uses POSIX `sh`, validates requested versions and downloaded checksums, stages updates before changing the visible command, and handles a stable user-owned command path.
- Topchester already publishes standalone native npm versions for every supported target. Reusing those artifacts keeps npm publishing as the one release source of truth while removing Node, npm, Bun, and mise from runtime lookup.

## Cross-Slice Rules

- `scripts/standalone/targets.ts` remains the supported-platform source of truth. Installer target names must match its npm dist tags.
- A failed download, checksum, extraction, or version check must leave the existing installed binary untouched.
- User-facing examples must use `~`, never a full home-directory path.
- Do not advertise a public curl URL until the script is actually hosted there.

## Files to Add

- `install/install.sh`
- `install/README.md`
- `install/check.sh`

## Files to Change

- `.mise.toml`
- this plan as slices are completed

### Slice 1: Installer contract and implementation

Status: `[x]` Done

Goal: provide a locally runnable and host-ready installer that owns one Topchester binary outside Node and mise environments.

Why here: download, verification, install location, and `PATH` behavior are the core contract. Documentation and broader checks should describe proven behavior rather than a proposed script.

This slice should implement:

- parse help, exact version, install directory, local binary, and no-profile-edit options
- map supported operating systems and architectures to Topchester's existing npm target names
- reject known musl Linux hosts clearly
- resolve and download the matching npm tarball
- check the registry digest, extract the binary, run `--version`, and replace atomically
- add or preserve a marked shell-profile `PATH` block
- report conflicting commands already earlier on `PATH`

Expected output: `install/install.sh` can install a local standalone binary and, with registry access, install the latest or a selected published version.

Verification: `sh -n install/install.sh`, local `--binary` install into a temporary home, and a live exact-version install into a temporary directory.

Completed:

- Added the POSIX installer with exact/latest npm resolution, target and musl checks, registry checksum verification, staged execution, and atomic replacement.
- Added local binary and custom install-directory paths plus opt-out shell-profile behavior.
- Added idempotent zsh, bash, fish, and generic profile setup and a warning when an older npm/mise command still wins the current shell lookup.
- Installed both the default `latest` resolution and an exact published `0.82.0` for Darwin ARM64 into temporary directories, then ran them successfully with `PATH=/usr/bin:/bin`.

Dependencies: existing standalone npm release artifacts.

### Slice 2: Repeatable checks and handoff notes

Status: `[x]` Done

Goal: make the installer safe to change and ready for the user to host.

Why here: these checks depend on the final option and install-path contract from Slice 1.

This slice should implement:

- add a local check covering help, invalid input, install, upgrade replacement, and no-profile-edit behavior
- expose the check through `mise run installer-check`
- document local execution, eventual hosted usage, options, environment variables, artifact source, and supported platforms
- run formatting plus the focused installer check

Expected output: the `install/` folder is self-contained for hosting handoff, and repository automation can validate it without network access.

Verification: `mise run installer-check` and `mise run format-check`.

Completed:

- Added `install/check.sh` and the `mise run installer-check` task.
- Covered help, invalid versions, local install, binary replacement, no-profile-edit behavior, idempotent profile setup, and rollback when a staged binary cannot run.
- Added the self-contained hosting and local-use handoff in `install/README.md`.
- `mise run installer-check`, `mise run format-check`, and `mise run local-ci` passed on 2026-08-15.

Dependencies: Slice 1.

## Final Verification

- `mise run installer-check`
- `mise run format-check`
- install the current published version into a temporary directory and run `topchester --version` with Node, Bun, and mise absent from `PATH`

## Open Question

- The canonical public installer URL is `https://topchester.com/install.sh`. `docs/ARCHITECTURE.md` still names `https://topchester.com/install` and must be corrected as part of this follow-up. The canonical route must be proven live before curl update guidance ships.

## Working Notes

- 2026-08-15: no Grok checkout exists under the configured local source directories, so the official hosted installer was inspected for that comparison. OpenCode and Codex were inspected only from their local checkouts.
- 2026-08-15: the existing release workflow publishes native npm versions but no GitHub release archives. The npm registry is therefore the only artifact source that works without expanding release scope.
- 2026-08-15: live registry checks resolved `latest` to `0.82.0` and installed both default-latest and exact-version `topchester-ai@0.82.0-darwin-arm64` packages. Each standalone command returned `0.82.0` with Node, Bun, npm, and mise absent from `PATH`.

## Follow-up: Curl-installed self-update

### Summary

Make `topchester update` and `topchester update --check` useful when the running command is a standalone executable installed by the shell installer. Package-manager installations must retain their current automatic update behavior. The v0 standalone path will not replace its own executable: it will check the npm release source when asked and print the exact canonical curl command the user should run.

This deliberately chooses a small, safe v0. Re-executing a downloaded installer or duplicating its checksum, extraction, validation, and atomic-replacement logic inside the TypeScript CLI would add a materially larger trust and failure surface. Automatic standalone replacement can be considered after the guidance path is shipped and proven.

### Decisions

- Keep npm, pnpm, and Bun update execution unchanged: `topchester update [target]` continues to run the detected manager's global install command.
- Treat a compiled executable with an embedded Bun module path and no concrete npm, pnpm, or Bun package path as a standalone install. This also gives a safely copied standalone binary the curl guidance path.
- Prefer concrete module/executable paths over an ambient `npm_config_user_agent`. Running a curl-installed binary from an npm script must not update an unrelated global npm copy.
- Keep source-checkout and otherwise ambiguous runtime paths unsupported rather than guessing that they are curl installs.
- For standalone installs, `topchester update --check [target]` resolves the target directly from the npm registry, compares it with the running version, and prints an exact curl install command when an update is available.
- For standalone installs, `topchester update [target]` does not mutate the binary in v0. It prints that automatic standalone updating is not supported yet, states that Topchester was not changed, and prints the curl command. This is a supported guidance result and exits successfully; the text must never claim that an update occurred.
- Use `https://topchester.com/install.sh` as the canonical installer URL only after a final live route check proves that it serves the reviewed `install/install.sh` content over HTTPS.
- Render `latest` as `curl -fsSL https://topchester.com/install.sh | sh`. Render an exact version as `curl -fsSL https://topchester.com/install.sh | sh -s -- --version <version>`.
- Resolve any non-semver npm dist tag, such as `next`, to its exact published version before rendering the installer command. Never interpolate an unvalidated target into a shell command.
- Defer automatic standalone replacement. A later implementation must reuse the installer's validation and atomicity guarantees rather than adding a weaker update path.

### Scope

Included:

- standalone-versus-package-manager installation detection
- registry-backed standalone `update --check`
- manual curl guidance for standalone `update`
- exact-version guidance for semver versions and resolved npm dist tags
- focused detection, registry, formatting, and failure tests
- compiled standalone/package regression proof
- CLI, installation, and installer documentation updates
- live verification of the canonical installer route before release

Out of scope:

- automatically replacing a running standalone executable
- downloading and executing the hosted installer from inside Topchester
- duplicating tarball selection, checksum verification, extraction, or atomic replacement in `src/cli/self-update.ts`
- changing the package-manager update commands
- adding a second release artifact source
- inferring that arbitrary source or development runtimes are curl installs

### Current State and Behavior to Preserve

- `src/cli/self-update.ts` currently detects only npm, pnpm, and Bun from `npm_config_user_agent`, the module path, or `process.execPath`.
- Both update paths require that detection. A curl-installed `~/.topchester/bin/topchester` therefore fails before checking the registry or changing a file.
- Package-manager `update --check` runs `<manager> view topchester-ai@<target> version`; package-manager `update` runs `<manager> install -g topchester-ai@<target>`.
- `install/install.sh` resolves `latest` or an exact version from the npm registry, validates the registry checksum and staged binary, and atomically replaces the destination.
- The installer supports a custom install directory. Standalone detection must therefore be based on the compiled runtime shape, not only the default `~/.topchester/bin/topchester` path.
- An older npm or mise copy can remain on disk. Only the executable actually invoked should determine update behavior.

### Implementation Shape

Replace the package-manager-only assumption with a typed update strategy:

- a package-manager strategy carries the existing manager command, arguments, display string, and target
- a standalone strategy carries the normalized target and canonical installer guidance
- unsupported remains distinct so a source checkout does not silently become a standalone install

Keep command construction and formatting pure. Add a small injectable registry resolver for the standalone path that reads `topchester-ai/<target>` metadata, requires a successful HTTP response, validates the returned `version`, and returns an exact version. Do not pass registry data through a shell.

`runSelfUpdate` should return a discriminated result so the CLI can distinguish `executed` from `manual-guidance`; `formatSelfUpdateSuccess` must only accept the executed result. `checkSelfUpdate` should return a strategy-neutral check result with current version, available version, availability, and an update instruction suitable for that strategy.

### Data Flow

```text
topchester update [target]
  -> detect concrete package path
     -> npm/pnpm/bun: execute existing global install command
  -> otherwise detect compiled standalone runtime
     -> latest or exact semver: format curl guidance
     -> other dist tag: resolve exact version, then format curl guidance
  -> otherwise: keep unsupported-install message

topchester update --check [target]
  -> package-manager strategy: preserve manager-backed version lookup
  -> standalone strategy: resolve target from npm registry over HTTP
  -> compare normalized current and available versions
  -> print up-to-date state or exact strategy-appropriate update instruction
```

### Edge Cases

- A curl-installed binary invoked inside an npm lifecycle process may inherit `npm_config_user_agent`; its concrete standalone executable shape must win.
- A packaged npm/pnpm/Bun executable also has an embedded Bun module path; its concrete package path must win before the standalone fallback.
- `v0.83.0` should normalize to `0.83.0`; an empty target should normalize to `latest` as it does today.
- `latest` should use the short curl command. Exact semver and resolved dist tags should use `--version` with a validated exact version.
- Registry network failures, non-2xx responses, malformed JSON, missing versions, and invalid versions must produce readable errors without suggesting that anything was updated.
- A failed `--check` must not invoke the installer or change the executable.
- Manual guidance must not execute a shell command, edit profiles, or touch the installed binary.
- When an old npm command wins `PATH`, its concrete npm path should retain npm behavior; documentation should tell users to confirm `command -v topchester` when behavior is unexpected.

### Files to Change

- `src/cli/self-update.ts`
- `src/cli.ts`
- `test/self-update.test.ts`
- `scripts/package/check-standalone.ts` if the current package harness can cover the manual-guidance path without broad restructuring
- `README.md`
- `docs/getting-started/installation.md`
- `docs/cli.md`
- `docs/ARCHITECTURE.md`
- `install/README.md`
- this plan as each slice completes

### Slice 2.1: Standalone strategy and guidance contract

Status: `[ ]` Not started

Goal: represent standalone installs explicitly and generate safe, exact curl guidance without changing current package-manager execution.

Why here: detection precedence and result types are the contract boundary. Registry access and CLI output should build on that contract rather than adding more package-manager special cases.

This slice should implement:

- refactor package-manager detection into a strategy detector with explicit package-manager, standalone, and unsupported outcomes
- make concrete package paths win over standalone detection and ambient package-manager user-agent hints
- recognize unpackaged compiled executables independently of the default install directory
- add a pure canonical installer-command builder for `latest` and validated exact versions
- add discriminated executed/manual update results so success formatting cannot describe guidance as a completed update
- preserve every existing npm, pnpm, and Bun command and display string
- add focused tests for default and custom standalone paths, copied standalone binaries, package-manager compiled paths, ambient user-agent conflicts, source checkout paths, and shell-safe command formatting

Expected output: self-update code can identify a curl-style standalone binary and return manual curl guidance, while all existing package-manager unit tests retain their behavior.

Verification: `vp test run test/self-update.test.ts` and `mise run typecheck`.

Dependencies: completed core curl installer; canonical installer URL confirmed as `https://topchester.com/install.sh`.

### Slice 2.2: Standalone registry check and CLI behavior

Status: `[ ]` Not started

Goal: make both public update commands useful for standalone installs without automatically replacing the executable.

Why here: this slice depends on the strategy and formatting contract from Slice 2.1 and adds the only new network behavior.

This slice should implement:

- add an injectable HTTP registry resolver for standalone targets
- validate HTTP status, response shape, and exact returned version
- make standalone `topchester update --check [target]` report current and available versions and the curl instruction when needed
- make standalone `topchester update [target]` print the manual-update explanation and curl instruction without executing it
- resolve non-semver dist tags to exact versions before formatting guidance
- keep package-manager `update` and `update --check` behavior unchanged
- keep unsupported source/development runtime behavior explicit
- add focused success, already-current, exact-version, dist-tag, offline, malformed-response, and no-mutation tests

Expected output: a curl-installed binary no longer emits irrelevant npm-install guidance; `--check` works without npm, and `update` gives one copyable command while clearly stating that no update was performed.

Verification: `vp test run test/self-update.test.ts`, the narrowest available CLI integration test, and `mise run typecheck`.

Dependencies: Slice 2.1; npm registry metadata remains the release source of truth.

### Slice 2.3: Compiled proof, documentation, and release gate

Status: `[ ]` Not started

Goal: prove the behavior through the shipped executable and make the install/update contract consistent everywhere users can read it.

Why here: compiled-runtime detection and public wording should be finalized only after the focused behavior and failure paths pass.

This slice should implement:

- extend the standalone package check when feasible to assert that an unpackaged compiled binary prints curl guidance and does not invoke npm, pnpm, or Bun
- verify before and after hashes or file metadata to prove `topchester update` did not replace the binary
- update README quick start to present the hosted curl path without requiring Node/npm, while retaining npm as an alternative distribution path
- update installation and CLI docs with the package-manager and standalone update behaviors, exact outputs, target handling, and `command -v topchester` troubleshooting
- reconcile `docs/ARCHITECTURE.md` and `install/README.md` around the canonical hosted URL
- correct the stale `https://topchester.com/install` architecture example to `https://topchester.com/install.sh`
- verify that `https://topchester.com/install.sh` serves the intended POSIX installer before merging or releasing the user-facing command
- record actual commands and results in this plan

Expected output: packaged behavior, public docs, and the live installer route agree; no documentation claims that standalone auto-update exists.

Verification: `mise run installer-check`, `mise run standalone-check`, `mise run local-ci-extended`, and `curl -fsSL https://topchester.com/install.sh | sh -s -- --help`.

Dependencies: Slices 2.1 and 2.2; deployment ownership for the canonical HTTPS installer route.

### Follow-up Final Verification

- `vp test run test/self-update.test.ts`
- `mise run installer-check`
- `mise run standalone-check`
- `mise run local-ci-extended`
- build or extract a standalone executable outside every `node_modules`, npm, pnpm, Bun, and mise install path
- with npm, pnpm, Bun, and mise absent from `PATH`, confirm `topchester update --check` reports the current and available versions from the registry
- confirm `topchester update` prints the canonical curl command, exits successfully, does not spawn a package manager, and leaves the executable unchanged
- confirm an npm-installed executable still performs the existing npm update/check commands in injected or isolated tests
- confirm `curl -fsSL https://topchester.com/install.sh | sh -s -- --help` returns the reviewed installer help before publishing the CLI behavior

### Deferred Slice 2.4: Automatic standalone replacement

Status: `[ ]` Not started; deferred beyond v0

Goal: evaluate opt-in automatic replacement only if manual curl guidance proves insufficient.

This slice must not begin by spawning `curl | sh`. First choose and document a trust model that either invokes a verified local installer asset or shares one implementation of target resolution, registry checksum verification, staged executable validation, atomic replacement, custom install-directory preservation, signals, and rollback. It must add failure-injection and packaged-binary tests before becoming the default.

Dependencies: Slices 2.1–2.3 shipped and observed; explicit product approval to expand the updater's mutation and remote-code boundary.
