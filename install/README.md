# Topchester shell installer

This folder is the host-ready source for installing one standalone Topchester command outside Node, npm, Bun, and mise environments.

## Intended hosted use

After `install.sh` is served from the public HTTPS URL, the install command can be:

```sh
curl -fsSL <installer-url> | sh
```

The URL is intentionally not chosen in this repository change.

Install a specific published version by passing arguments to the downloaded script:

```sh
curl -fsSL <installer-url> | sh -s -- --version 0.82.0
```

The default destination is `~/.topchester/bin/topchester`. The installer adds that directory to the front of the current shell's future `PATH` through a marked profile block. It does not remove older npm or mise installations; once the new path is active, those copies can be removed deliberately.

## Local use

Run the installer directly from this checkout:

```sh
sh install/install.sh
```

Use an already-built standalone binary without network access:

```sh
sh install/install.sh \
  --binary dist/standalone/topchester-darwin-arm64/bin/topchester
```

Use `--no-modify-path` in a managed shell environment. Use `--install-dir DIR` or `TOPCHESTER_INSTALL_DIR=DIR` to choose another destination.

## Artifact source and supported systems

The installer resolves `topchester-ai/latest` from the npm registry and downloads the matching platform-tagged package. It verifies the registry checksum and runs the staged binary before replacing the current command.

The supported systems match `scripts/standalone/targets.ts`:

- Apple Silicon macOS
- glibc Linux on ARM64
- glibc Linux on x64

Intel macOS, Windows, and musl Linux are rejected with a clear error.

## Local check

Run the network-free installer check through the repository toolchain:

```sh
mise run installer-check
```

The check covers syntax, help, invalid input, local installation, replacement, profile idempotency, `--no-modify-path`, and preserving the working binary after a failed update.
