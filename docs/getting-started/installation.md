---
title: Installation
description: Install and update the Topchester CLI.
section: Intro
order: 30
public: true
---

# Installation

Topchester is distributed as the `topchester-ai` package. The executable is `topchester`.

```sh
npm install -g topchester-ai
topchester --version
```

If you installed with pnpm or bun, use the matching global install command for your setup.

## Update

Topchester can update itself through the package manager that installed the current CLI:

```sh
topchester update
topchester update --check
topchester update 0.15.0
```

`topchester upgrade` is an alias for `topchester update`.

After an update, restart any running Topchester process.
