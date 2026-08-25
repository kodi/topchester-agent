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
topchester session debug latest
topchester session debug 019e9029 --json
topchester --resume latest
topchester fork --last
topchester fork 019e9029-0000-7000-8000-000000000001
topchester run "Edit greeting.txt and change Hello to Goodbye."
topchester run /kb status
topchester run "/skill code-review review this diff"
topchester search "status bar"
topchester auth login codex --device
topchester auth status
topchester mcp list
topchester mcp list --json
topchester mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
topchester mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx -- npx -y @modelcontextprotocol/server-github

topchester kb init
topchester kb sync
topchester kb status
topchester kb search "post author update error"
topchester kb context "status bar" --json
topchester kb sync --full
topchester kb reset
```

## Global options

- `-c, --config <path>` selects an explicit profile after workspace and user config. It shadows `TOPCHESTER_CONFIG` rather than stacking with it.
- `--workspace <path>` uses this workspace root. Defaults to the current working directory.
- `--resume <session>` resumes a project-local session from `.agents/topchester/sessions/`. Use `latest` or an exact lowercase session ID.
- `--dev <flag>` enables a development-only UI or runtime flag. Can be repeated.
- `-V, --version` prints the CLI package version.
- `-h, --help` prints help.

## Command overview

| Command                    | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `topchester`               | Start the interactive coding agent.                      |
| `topchester auth`          | Manage global provider authentication.                   |
| `topchester fork`          | Fork a saved project-local session and open the fork.    |
| `topchester info`          | Show config validity and local runtime hints.            |
| `topchester mcp add`       | Add or replace a stdio MCP server in config.             |
| `topchester mcp list`      | List configured MCP servers without starting them.       |
| `topchester run`           | Run one prompt or slash command without opening the TUI. |
| `topchester session debug` | Show events and timing for one saved session.            |
| `topchester search`        | Search compiled L1 file knowledge.                       |
| `topchester kb init`       | Create the project knowledge folders.                    |
| `topchester kb context`    | Create an L1 context pack for a query.                   |
| `topchester kb dry-run`    | Preview which files would be synced.                     |
| `topchester kb search`     | Search compiled L1 file knowledge.                       |
| `topchester kb sync`       | Build or update L1 entries for non-clean files.          |
| `topchester kb reset`      | Delete the local knowledge base and cache.               |
| `topchester kb status`     | Show files that are not current in the knowledge base.   |
| `topchester update`        | Update Topchester with npm, pnpm, or bun.                |

## `topchester info`

`topchester info` is a lite doctor command. It does not open the TUI, contact model providers, start MCP servers, or create project state folders.

Reports config layers, the active selected profile and any environment profile shadowed by `--config`, whether the effective config is valid, configured model/provider hints, provider API key env presence, MCP server command presence, hook counts, and local session/log/knowledge paths.

If config is invalid, it prints the config error and exits nonzero.

All `topchester kb` commands target the current workspace's mutable project knowledge. Topchester product help comes from the packaged `topchester` skill and is not exposed as a second KB source.

Press `Ctrl-C` to stop an in-progress `topchester kb sync` or `topchester kb sync --full`. An interrupted sync exits with status 130 and keeps any written queue so the next sync can resume the unfinished work.

## `topchester session debug`

Shows the most detailed available diagnostic report for one project-local session:

```sh
topchester session debug latest
topchester session debug 019e9029
topchester session debug 019e9029-0000-7000-8000-000000000001 --json
```

The selector can be `latest`, an exact lowercase UUIDv7, or a unique lowercase ID prefix. The command loads the full child-session tree and reports:

- session span, active state, event counts, and artifact paths
- tool counts, failures, measured tool work, and longest tool call
- child-session status, span, event count, and tool count
- the longest gaps between persisted root-session events
- model, tool, subagent wait, hook, approval, setup, and other time as durations and percentages
- repeated hook-handler summaries and the ten slowest hook runs, plus every additional timed-out, aborted, spawn-failed, or nonzero-exit run
- timing coverage and warnings for missing, old, incomplete, or unscoped logs

Exact percentages require session-scoped timing records. Topchester writes these compact records when `TOPCHESTER_LOG_LEVEL=debug` or `trace` is set before the session work starts. `trace` adds full prompt, response, and tool-result content, but the debug command does not print that raw content. Old logs without session identifiers are not attributed because concurrent root and child work can be mixed.

`--json` prints the complete versioned report for scripts, including every hook run. Hook data includes a privacy-safe handler label and ordinal, the effective timeout, total duration, process-exit time, close wait, and outcome. It does not include the full configured hook command. The text and JSON reports distinguish active turn time from the full observed session span. Time between user messages is not treated as agent work. Child sessions get separate timing sections because parallel child work can exceed root wall time when summed.

In a terminal, the text report uses status icons, semantic colors, and compact percentage bars to separate the session summary, artifacts, timing, tools, subagents, event gaps, and notes. Color is disabled automatically when output is redirected and whenever `NO_COLOR` is set; `FORCE_COLOR=1` enables it explicitly. The icons and layout keep every status readable without color.

## `topchester auth login codex --device`

Starts the SSH-friendly Codex ChatGPT device login flow. Topchester prints a verification URL, one-time user code, expiry time, and phishing warning. Open the URL in any browser, enter the code, and return to the terminal while Topchester polls for approval.

On success, Topchester stores OAuth tokens in `~/.config/topchester/auth.json`, configures the global `codex` provider in `~/.config/topchester/config.jsonc`, and seeds starter Codex model choices. Token values are not printed.

`topchester auth --help` and `topchester auth login --help` list supported auth providers and examples. Bare `topchester auth login`, unsupported providers, and `topchester auth login codex` without `--device` print the `codex` provider, exact login command, and next help command instead of only reporting a missing argument.

## `topchester auth status`

Shows the global auth store path and redacted provider auth state. It reports whether stored access and refresh tokens exist, whether a provider needs refresh or relogin, and never prints token values.

## `topchester mcp add`

Adds or replaces a stdio MCP server entry:

```sh
topchester mcp add <server-name> --env KEY=VALUE -- <stdio server-command> [args...]
```

`--env KEY=VALUE` can be repeated. Server names use letters, numbers, `-`, and `_`. The command writes to `--config` when provided, otherwise to `~/.config/topchester/config.jsonc`.

## `topchester mcp list`

Lists MCP servers from the effective merged config without starting or connecting to them:

```sh
topchester mcp list
topchester mcp list --json
```

The text output shows each server's enabled state, transport, command and args, environment variable names, enabled tool filter, and configured timeout. Environment values are never printed. `--json` returns the same redacted information for scripts.

## `topchester fork`

`topchester fork --last` forks the newest project-local session. `topchester fork <session-id>` forks that exact project-local session. Bare `topchester fork` exits with a clear message until Topchester has a fork-specific saved-session picker.

The fork gets a fresh top-level session ID, opens through the normal resume hydration path, and records source-session lineage in metadata. The source session log is left untouched. Child `task` session folders are not copied in V0.

## `topchester run`

Runs one prompt or slash command without opening the TUI.

```sh
topchester run "Read data.txt and summarize it."
topchester run --json "Edit greeting.txt and change Hello to Goodbye."
topchester run --output-json /tmp/topchester-events.jsonl "Run /kb status"
topchester run --dangerously-auto-approve --json "Run the benchmark task."
topchester run --dangerously-auto-approve --benchmark-profile terminal-bench --json "Run the Terminal-Bench task."
topchester run /kb status
```

Options:

- `--model <model>` overrides the `agent.primary` model for this run.
- `--timeout <ms>` stops the run after this many milliseconds.
- `--json` writes JSONL run events to stdout.
- `--output-json <path>` writes JSONL run events to a file.
- `--dangerously-auto-approve` auto-approves prompt-gated tool calls for this non-interactive run.
- `--benchmark-profile <profile>` enables an explicit benchmark runtime profile. The supported profile is `terminal-bench`.

`--dangerously-auto-approve` is intended for benchmarks and automation that cannot answer approval prompts. It only bypasses prompts that would otherwise ask the user, currently approval-required `bash` calls. Hard policy rejects, deny rules, destructive command detection, workspace boundary failures, profile/tool-catalog denial, and hook `block` or `stop` responses still apply. Auto-approved bash commands are approved only for the current tool execution and are not written to `topchester.jsonc`.

`--benchmark-profile terminal-bench` is for disposable Terminal-Bench containers. It keeps configured bash deny rules, but allows broad shell commands through the `bash` tool so tasks can create files, run services, build archives, configure local system state, or perform other terminal work inside the benchmark sandbox. It also lets successful workspace-changing bash calls satisfy the non-interactive finish gate for non-code tasks.

Run JSON includes a per-run `runId`, `dangerouslyAutoApprove` and `benchmarkProfile` in the `run.started` event, and `permission_auto_approved` runtime events when a permission prompt is bypassed.

The agent can use `web_fetch` during `topchester` and `topchester run` sessions to read public HTTP(S) pages, including docs, changelogs, API references, issue pages, and package notes. `web_fetch` returns markdown by default, can return plain text or HTML, blocks localhost and private-network addresses, strips credentials from URLs, and stops at cross-host redirects so the next URL is visible as a separate tool call. Raw responses over 5 MB fail, and returned text is capped at 40,000 characters with a `[truncated]` marker. The tool is available to the primary agent and general subagents, but not the read-only explore subagent.
