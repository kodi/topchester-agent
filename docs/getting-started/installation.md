---
title: Installation
description: Install and update the Topchester CLI.
section: Intro
order: 30
public: true
---

# Installation

Topchester is distributed as the `topchester-ai` package. The executable is `topchester`.

The supported npm package targets are:

- macOS ARM64 and x64;
- glibc Linux ARM64 and x64.

Node.js `>=18` and npm are required to install the package. The installed `topchester` command is a standalone executable and does not require Bun. Windows and musl Linux are not included in the first standalone release.

```sh
npm install -g topchester-ai
topchester --version
```

Use npm for the supported standalone installation path. Bun `>=1.3` is required only when running or building Topchester from source.

## Update

Topchester can update itself through the package manager that installed the current CLI:

```sh
topchester update
topchester update --check
topchester update 0.15.0
```

`topchester upgrade` is an alias for `topchester update`.

After an update, restart any running Topchester process.
