# Safe Discovery Command Tool Plan

## Summary

Add a narrow command tool that lets the agent run familiar, read-only terminal commands for orientation, such as:

```sh
pwd && rg --files docs/plans | head -20
```

The goal is not to add a general shell. The goal is to give Topchester one safe escape hatch for quick repo discovery when `list_files`, `grep`, `find_file`, and `read_file` are too clumsy for a common terminal pattern.

## Decisions

- Add a new agent tool named `inspect_command`.
- Treat it as a discovery tool, not a general `bash` or `shell` tool.
- Accept a command string because the model/user thinks in shell-shaped snippets.
- Do not execute through the user shell in V0.
- Parse a small shell-like subset ourselves, validate every segment, then run known executables with `execFile`/`spawn`.
- Allow only known read-only commands and safe flag forms.
- Allow simple sequencing and pipelines: `&&`, `||`, `;`, and `|`.
- Reject redirects, heredocs, command substitution, process substitution, variables, glob expansion, aliases, functions, background jobs, multiline scripts, and subshells.
- Reject `cd`; use the tool's `workdir` argument instead.
- Keep all paths inside the workspace unless a command argument is clearly pathless metadata, such as `git status`.
- Do not prompt for approval inside this tool. Unsafe commands fail with a plain reason.
- Keep dedicated tools preferred for exact reads, search, and edits.

## Scope

Included:

- `inspect_command` model tool for safe orientation commands.
- Hard allowlist and per-command argument validators.
- Workspace-scoped `workdir`.
- Short timeout and output limits.
- Structured result metadata for command, cwd, exit code, duration, timeout, truncation, and validator decision.
- Debug logs that record decision metadata but not full output unless trace logging is enabled.
- Prompt updates so the model knows this tool is for orientation only.
- Tests for accepted commands, rejected unsafe shell syntax, rejected dangerous flags, workspace path containment, timeout, output truncation, and registry/runtime formatting.
- `docs/cli.md` update when the tool ships.

Not included:

- A general shell.
- Interactive commands or PTY support.
- Package installs, builds, tests, network access, Docker, editors, interpreters, or process managers.
- User approval UI for unsafe commands.
- OS-level sandboxing.
- Windows/PowerShell parity in V0.
- File creation, editing, deletion, moving, chmod, or git mutation.

## Current State

Topchester already exposes these workspace-scoped tools:

- `read_file`
- `list_files`
- `grep`
- `find_file`
- `edit_file`

Useful files:

- `src/agent/tools/registry.ts` registers tools.
- `src/agent/tools/types.ts` defines tool contracts.
- `src/agent/tools/executor.ts` executes tools and logs metadata.
- `src/agent/tools/grep.ts` already finds native `rg`/`grep` and runs them safely with `execFile`.
- `src/agent/prompts.ts` tells the model to prefer specific tools and use command/test tools when available.
- `src/agent/runtime.ts` formats tool results into the follow-up prompt and chat row.
- `test/tools.test.ts` covers parser, registry, prompt lines, logging, and tool behavior.
- `docs/cli.md` tracks implemented interactive tool behavior.

The file list tool works and should stay the normal path for simple listing. The new tool is for combined read-only terminal idioms that are cheap, familiar, and hard to express with one dedicated tool.

## Competitor Findings

Local checkouts were inspected as requested by `AGENTS.override.md`.

### Codex

Relevant files:

- `/Users/kodi/data/github/codex/codex-rs/core/src/tools/handlers/shell_spec.rs`
- `/Users/kodi/data/github/codex/codex-rs/core/src/tools/handlers/shell/shell_command.rs`
- `/Users/kodi/data/github/codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs`
- `/Users/kodi/data/github/codex/codex-rs/shell-command/src/command_safety/is_safe_command.rs`

Codex has the strongest pattern for this feature. It classifies known-safe commands, allows common read commands, and rejects dangerous flags such as `find -delete`, `find -exec`, and risky `rg` options. It can parse simple `bash -lc` command chains only when every command stays in a conservative safe subset.

Topchester should copy the idea of a hard known-safe classifier, but avoid launching through shell first.

### OpenCode

Relevant files:

- `/Users/kodi/data/github/opencode/packages/opencode/src/tool/shell.ts`
- `/Users/kodi/data/github/opencode/packages/opencode/src/shell/shell.ts`
- `/Users/kodi/data/github/opencode/packages/opencode/src/config/permission.ts`
- `/Users/kodi/data/github/opencode/packages/opencode/src/permission/evaluate.ts`

OpenCode exposes a broad shell tool and uses tree-sitter parsing plus permission prompts. It is useful for permission UX and path scanning, but its own security notes say it is not sandboxed.

Topchester should not copy a broad shell as the default. Permission prompts are helpful later, but this tool should reject unsafe commands outright.

### Cline

Relevant files:

- `/Users/kodi/data/github/cline/src/core/prompts/system-prompt/tools/execute_command.ts`
- `/Users/kodi/data/github/cline/src/core/permissions/CommandPermissionController.ts`
- `/Users/kodi/data/github/cline/src/integrations/terminal/CommandExecutor.ts`

Cline supports command allow/deny config and validates chained command segments. It also handles timeouts, cancellation, and large output.

Topchester should copy segment-by-segment validation and output handling, but should not rely on model-provided safety labels like `requires_approval`.

### Kilo Code

Relevant files:

- `/Users/kodi/data/github/kilocode/packages/opencode/src/tool/bash.ts`
- `/Users/kodi/data/github/kilocode/packages/opencode/src/permission/index.ts`

Kilo is OpenCode-derived and adds useful access metadata and stronger protected-path behavior. It still exposes broad bash behind permissions.

Topchester should copy the idea of returning access/decision metadata, not the broad bash surface.

### Pi

Relevant files:

- `/Users/kodi/data/github/pi/packages/coding-agent/src/core/tools/bash.ts`
- `/Users/kodi/data/github/pi/packages/coding-agent/src/core/bash-executor.ts`
- `/Users/kodi/data/github/pi/packages/coding-agent/src/core/tools/ls.ts`
- `/Users/kodi/data/github/pi/packages/coding-agent/src/core/tools/grep.ts`
- `/Users/kodi/data/github/pi/packages/coding-agent/examples/extensions/sandbox/index.ts`

Pi has a small bash executor, separate read-only tools, a read-only tool mode, and an optional sandbox extension example.

Topchester should keep the dedicated read-only tool split and borrow the small Node execution shape. A sandboxed full shell can be a future feature, not this one.

## Recommended Approach

Implement `inspect_command` as a small command runner with a strict parser and allowlist.

Suggested tool call shape:

```json
{
  "tool": "inspect_command",
  "args": {
    "command": "pwd && rg --files docs/plans | head -20",
    "workdir": ".",
    "timeout_ms": 10000
  }
}
```

Suggested result shape:

```ts
interface InspectCommandToolResult extends ToolResult<"inspect_command"> {
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  decision: {
    allowed: true;
    reason: string;
    commands: string[];
  };
}
```

Unsafe commands should throw a normal tool error with a clear message:

```text
inspect_command rejected this command because redirects are not allowed.
```

## Command Grammar

V0 should support only:

- words
- single-quoted words
- double-quoted words without expansion
- simple commands
- pipelines with `|`
- command lists with `&&`, `||`, and `;`

V0 should reject:

- `>`, `>>`, `<`, `2>`, `&>`, `|&`
- `<<` heredocs
- `$VAR`, `${VAR}`, `$()`
- backticks
- `(` and `)` subshells
- `{}` command groups
- `&` background jobs
- newlines
- shell functions
- aliases
- globs that require shell expansion

The parser does not need to be a full bash parser. It only needs to parse enough safe syntax and reject the rest.

## Initial Allowlist

Allow commands that are useful for read-only repo orientation:

- `pwd`
- `ls`
- `rg`
- `grep`
- `find`
- `fd`
- `cat`
- `head`
- `tail`
- `wc`
- `stat`
- `file`
- `du`
- `git`

Command-specific rules:

- `pwd`: no path arguments.
- `ls`: allow path arguments and display/sort flags; reject weird shell-dependent forms.
- `rg`: allow normal search/list flags; reject `--pre`, `--pre-glob`, `--hostname-bin`, `--search-zip`, `-z`, and paths outside the workspace.
- `grep`: allow read/search flags; reject recursive device tricks and paths outside the workspace.
- `find`: allow name/type/maxdepth/mindepth/print style queries; reject `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, output-writing actions, and paths outside the workspace.
- `fd`: allow search flags and workspace paths; reject command-execution options.
- `cat`, `head`, `tail`, `wc`, `stat`, `file`, `du`: allow file/path reads inside the workspace and common read flags.
- `git`: allow `status`, `log`, `diff`, `show`, `branch --show-current`, `rev-parse --show-toplevel`, and `ls-files`; reject mutation subcommands and external helpers.

Do not allow:

- `npm`, `pnpm`, `yarn`, `bun`
- `node`, `python`, `ruby`, `perl`, `sh`, `bash`, `zsh`
- `curl`, `wget`, `ssh`, `scp`
- `docker`, `kubectl`, cloud CLIs
- `rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`
- editors and pagers such as `vim`, `nano`, `less`, `more`
- process controls such as `kill`, `pkill`, `ps` in V0

Package scripts and test commands are useful, but they belong in a future `run_command` or verification tool with different policy, not this orientation tool.

## Data Flow

1. Model requests `inspect_command`.
2. Tool validates `workdir` stays inside `workspaceRoot`.
3. Tool parses the command string into command segments and operators.
4. Tool validates syntax and every command segment.
5. Tool resolves each executable from `PATH`, except built-ins like `pwd`.
6. Tool executes segments without a shell.
7. Pipelines pass stdout from one process into stdin of the next process.
8. `&&`, `||`, and `;` apply normal shell-like exit-code control.
9. Tool enforces timeout, output byte limit, and output line limit.
10. Tool returns stdout plus compact stderr/metadata.
11. Debug logs include command, cwd, parsed segments, decision reason, duration, exit code, and output sizes.
12. Trace logs may include full output, matching existing tool logging behavior.

## Edge Cases

- Missing executable: return a clear unavailable-tool warning rather than pretending the command ran.
- No output: return `(no output)` plus metadata.
- Stderr with exit code `0`: include stderr below stdout with a label so the model sees warnings.
- Non-zero exit code: return output and exit code; do not throw unless execution itself failed.
- Timeout: kill the process tree when possible and return `timedOut: true`.
- Large output: truncate and set `truncated: true`.
- Binary output: strip control characters or replace with a warning.
- Symlinked workdir or path args: resolve real paths where practical and keep them inside the workspace.
- Git commands run from nested folders should still stay scoped to the workspace.

## Files to Add

- `src/agent/tools/inspect-command.ts`
- `src/agent/tools/inspect-command-parser.ts`
- `src/agent/tools/inspect-command-policy.ts`
- `test/inspect-command-tool.test.ts`

## Files to Change

- `src/agent/tools.ts`
- `src/agent/tools/registry.ts`
- `src/agent/tools/executor.ts`
- `src/agent/tools/types.ts` if extra shared metadata is needed.
- `src/agent/prompts.ts`
- `src/agent/runtime.ts`
- `docs/cli.md`
- `docs/plans/kb-implementation-checklist.md` if this becomes part of the active KB/tool roadmap.

## Cross-Slice Rules

- Keep `inspect_command` read-only.
- Prefer existing dedicated tools in prompt wording.
- Never execute rejected syntax through a fallback shell.
- Every allowed command must have a positive rule and tests.
- Every denied command class must have at least one test.
- Keep output bounded in every execution path.
- Do not add a dependency unless the implementation proves the small parser is too risky.
- Preserve the KB invariant: command output is orientation evidence, not a replacement for KB-backed reasoning or current-file reads before edits.

## Testing Plan

Per-slice tests should use temporary workspaces and fake executable directories where possible.

Final verification:

```sh
pnpm check
```

Manual smoke check after implementation:

```sh
pnpm build
node dist/cli.mjs --dev disable-kb-check-modal
```

Then ask the agent a repo-orientation question and confirm it can call:

```sh
pwd && rg --files docs/plans | head -20
```

## Slices

### Slice 1: Parser and Policy Contract

Status: `[x]` Completed

Goal: Define the supported command subset and prove unsafe syntax is rejected before any process execution exists.

Why here: The parser and allowlist are the safety boundary. They should be tested before wiring execution.

This slice should implement:

- `InspectCommandArgs` schema.
- Command AST types for simple commands, pipelines, and command lists.
- Parser for words, quotes, `|`, `&&`, `||`, and `;`.
- Syntax rejection for redirects, command substitution, variables, background jobs, subshells, and multiline scripts.
- Policy result type with allowed commands and rejection reason.
- Initial command allowlist with per-command validators.

Expected output:

- Pure parser and policy modules.
- Tests that do not spawn processes.

Verification:

```sh
pnpm test test/inspect-command-tool.test.ts
pnpm typecheck
```

Dependencies: None.

### Slice 2: Safe Execution Engine

Status: `[x]` Completed

Goal: Execute already-validated command plans without invoking a shell.

Why here: Execution should rely on the parser/policy contract from Slice 1 and add timeout/output controls separately.

This slice should implement:

- Workspace-scoped `workdir` resolution.
- Executable lookup using `PATH`.
- Built-in `pwd`.
- `execFile`/`spawn` runner for simple commands.
- Pipeline execution for `|`.
- Control-flow execution for `&&`, `||`, and `;`.
- Timeout handling.
- Output byte/line truncation.
- Environment hardening: `PAGER=cat`, `GIT_PAGER=cat`, `LESS=-F -X`, `stdin` ignored unless receiving pipeline input.

Expected output:

- A reusable execution helper that returns stdout, stderr, exit code, duration, timeout, and truncation metadata.

Verification:

```sh
pnpm test test/inspect-command-tool.test.ts
pnpm typecheck
```

Dependencies: Slice 1.

### Slice 3: Tool Registry and Runtime Integration

Status: `[x]` Completed

Goal: Expose `inspect_command` to the model and display its results clearly.

Why here: The safe core should exist before the model can call it.

This slice should implement:

- `inspectCommandTool` definition.
- Registry export and `src/agent/tools.ts` export.
- Tool prompt line that says it is for read-only orientation only.
- Runtime formatting for prompt feedback.
- Chat row formatting like `Tool inspect_command: pwd && rg --files docs/plans | head -20`.
- Executor log summarization for decision metadata and output sizes.

Expected output:

- The agent can parse, execute, log, and feed back safe inspect command results.

Verification:

```sh
pnpm test test/tools.test.ts test/inspect-command-tool.test.ts
pnpm typecheck
```

Dependencies: Slice 2.

### Slice 4: Prompt, Docs, and Behavior Guardrails

Status: `[x]` Completed

Goal: Teach the agent when to use the tool and keep user-facing command behavior documented.

Why here: A safe tool can still be misused if the model treats it like a general shell.

This slice should implement:

- Prompt guidance to prefer `list_files`, `grep`, `find_file`, and `read_file` for exact tasks.
- Prompt guidance to use `inspect_command` only for quick read-only orientation commands.
- Prompt warning that unsafe commands are not available through this tool.
- `docs/cli.md` update for the new interactive tool and its safety limits.
- Any roadmap/checklist update if this tool changes the KB/tool plan.

Expected output:

- Model-facing and user-facing docs match the implemented behavior.

Verification:

```sh
pnpm test test/tools.test.ts test/inspect-command-tool.test.ts
pnpm format-check
```

Dependencies: Slice 3.

### Slice 5: Integration Hardening

Status: `[x]` Completed

Goal: Cover real repo-orientation examples and denial cases end to end.

Why here: The feature is useful only if common shell-shaped discovery commands work and risky nearby commands fail plainly.

This slice should implement:

- End-to-end tests for:
  - `pwd`
  - `rg --files docs/plans | head -20`
  - `pwd && rg --files docs/plans | head -20`
  - `git status --short`
  - denied `rm -rf dist`
  - denied `find . -delete`
  - denied `rg --pre`
  - denied `cat package.json > /tmp/out`
  - denied `bash -lc "pwd"`
- Logging tests that debug logs do not include full output.
- Truncation tests for large output.
- Timeout tests with a fake command if possible.

Expected output:

- Confidence that the useful happy path works and the dangerous near misses fail.

Verification:

```sh
pnpm check
```

Dependencies: Slice 4.

## Follow-Up Options

These are intentionally out of V0:

- A separate `run_command` tool for tests/builds with approval and stronger runtime controls.
- OS-level sandboxing for broader commands.
- Tree-sitter bash parsing if the hand-written safe subset becomes too hard to maintain.
- PowerShell support.
- Session-level remembered command approvals.
- KB ingestion of useful command observations as session overlay facts.

## Open Questions

- Should `git diff` be allowed by default even though output may be large?
- Should `du` be allowed in V0, or deferred because it can be expensive on large repos?
- Should `ps` be allowed for environment orientation, or omitted because it leaks unrelated machine state?
- Should the tool save full truncated output to `.agents/topchester/` later, or only return bounded content in V0?

## Next Slice

Start with Slice 1.
