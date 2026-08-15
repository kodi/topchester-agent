# Curl Installer Plan

Status: complete; implementation and final verification passed

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

- The final public HTTPS URL is intentionally left to the user after this folder is ready.

## Working Notes

- 2026-08-15: no Grok checkout exists under the configured local source directories, so the official hosted installer was inspected for that comparison. OpenCode and Codex were inspected only from their local checkouts.
- 2026-08-15: the existing release workflow publishes native npm versions but no GitHub release archives. The npm registry is therefore the only artifact source that works without expanding release scope.
- 2026-08-15: live registry checks resolved `latest` to `0.82.0` and installed both default-latest and exact-version `topchester-ai@0.82.0-darwin-arm64` packages. Each standalone command returned `0.82.0` with Node, Bun, npm, and mise absent from `PATH`.
