---
title: CLI commands
description: Topchester command-line reference.
section: Reference
order: 10
public: true
---

# CLI commands

Common commands:

```sh
topchester
topchester info
topchester --resume latest
topchester fork --last
topchester fork 019e9029-0000-7000-8000-000000000001
topchester run "Edit greeting.txt and change Hello to Goodbye."
topchester run /kb status
topchester run "/skill code-review review this diff"
topchester search "status bar"

topchester kb init
topchester kb sync
topchester kb status
topchester kb search "post author update error"
topchester kb context "status bar" --json
topchester kb sync --full
topchester kb reset
```

## Global options

- `-c, --config <path>` uses an explicit config file.
- `--workspace <path>` uses this workspace root. Defaults to the current working directory.
- `--resume <session>` resumes a project-local session from `.agents/topchester/sessions/`. Use `latest` or an exact lowercase session ID.
- `--dev <flag>` enables a development-only UI or runtime flag. Can be repeated.
- `-V, --version` prints the CLI package version.
- `-h, --help` prints help.

## Command overview

| Command                 | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `topchester`            | Start the interactive coding agent.                      |
| `topchester fork`       | Fork a saved project-local session and open the fork.    |
| `topchester info`       | Show config validity and local runtime hints.            |
| `topchester run`        | Run one prompt or slash command without opening the TUI. |
| `topchester search`     | Search compiled L1 file knowledge.                       |
| `topchester kb init`    | Create the project knowledge folders.                    |
| `topchester kb context` | Create an L1 context pack for a query.                   |
| `topchester kb dry-run` | Preview which files would be synced.                     |
| `topchester kb search`  | Search compiled L1 file knowledge.                       |
| `topchester kb sync`    | Build or update L1 entries for non-clean files.          |
| `topchester kb reset`   | Delete the local knowledge base and cache.               |
| `topchester kb status`  | Show files that are not current in the knowledge base.   |
| `topchester update`     | Update Topchester with npm, pnpm, or bun.                |

## `topchester info`

`topchester info` is a lite doctor command. It does not open the TUI, contact model providers, start MCP servers, or create project state folders.

Reports config layers, whether the effective config is valid, configured model/provider hints, provider API key env presence, MCP server command presence, hook counts, and local session/log/knowledge paths.

If config is invalid, it prints the config error and exits nonzero.

## `topchester fork`

`topchester fork --last` forks the newest project-local session. `topchester fork <session-id>` forks that exact project-local session. Bare `topchester fork` exits with a clear message until Topchester has a saved-session picker.

The fork gets a fresh top-level session ID, opens through the normal resume hydration path, and records source-session lineage in metadata. The source session log is left untouched. Child `task` session folders are not copied in V0.
