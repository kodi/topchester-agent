# Git Tools Plan

## Summary

Implement first-class agent-facing Git tools for Topchester.

The target outcome is a structured, reviewable Git workflow inside the coding-agent loop: the model can inspect status, diffs, and recent history without shell-shaped parsing, then only stage or commit files through guarded mutation tools when the user explicitly asks. This plan follows the third item in the alpha tool gap analysis and keeps `inspect_command` as a read-only orientation escape hatch, not the primary Git workflow.

Git is a critical workflow surface. The end goal is not only unit coverage and `pnpm check`; the checked-in fake-API smoke battery must be green locally with Git scenarios included.

## Decisions

- Add dedicated read tools first: `git_status`, `git_diff`, and `git_log`.
- Implement Git execution in TypeScript application code using direct `git` process calls, not through the user shell.
- Use `git -c core.quotepath=false --no-optional-locks ...` style invocation for predictable path output and fewer background lock surprises.
- Keep all paths workspace-scoped and pass file path arguments after `--`.
- Treat non-Git workspaces and missing Git as normal tool results with clear messages, not model hallucination traps.
- Include untracked files in status.
- Include untracked file patches in `git_diff` when requested, using `git diff --no-index -- /dev/null <file>` style output.
- Make read tools visible before any mutation tool is registered.
- Add guarded mutation tools later: `git_add` and `git_commit`.
- Require explicit user intent before staging or committing.
- Never stage unrelated or untracked files by default.
- Do not add `git reset`, `git checkout`, `git clean`, `git push`, `git pull`, or PR creation in the first implementation.
- Do not treat these tools as KB updates; Git tools report repository state. File-write tools remain responsible for session overlay and `needs_sync`.
- Treat `pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --trials 1`, also available as `mise run smoke 1`, as safe to run locally and as the end-goal acceptance gate after all Git tool slices land.

## Scope

Included:

- `git_status` for branch/head metadata and structured changed-file status.
- `git_diff` for workspace, staged, file-scoped, and optional untracked diffs.
- `git_log` for bounded recent commit summaries.
- Shared Git helper module with path containment, process execution, timeout, output truncation, NUL-safe parsing, and non-Git handling.
- Model prompt guidance for when to use each Git tool.
- Runtime prompt formatting and compact TUI rows.
- Debug logs with metadata but not full diff content at debug level.
- Tests for normal repos, non-Git directories, repos without commits, staged/unstaged/untracked files, path quoting, workspace escapes, truncation, and missing Git behavior.
- Checked-in smoke scenarios under `scripts/smoke/scenarios` for read Git tools, guarded staging, and guarded commits.
- Docs updates after the tools ship.

Not included:

- Creating branches.
- Undo/reset/checkout/clean operations.
- Pull, push, fetch, merge, rebase, stash, tags, submodules, or worktrees.
- PR creation.
- GitHub/GitLab provider APIs.
- Commit-message generation beyond using the model's normal final answer and the explicit `git_commit` message argument.
- Interactive conflict resolution.
- A general shell or approval framework.

## Current State

Topchester currently exposes these workspace-scoped tools:

- `read_file`
- `list_files`
- `grep`
- `find_file`
- `edit_file`
- `inspect_command`

Relevant implementation surfaces:

- `src/agent/tools/types.ts` defines the shared tool contracts.
- `src/agent/tools/registry.ts` registers model-visible tools.
- `src/agent/tools/executor.ts` executes tools and logs metadata.
- `src/agent/tools/inspect-command.ts` shows the current safe process-execution pattern.
- `src/agent/tools/inspect-command-policy.ts` currently allows read-only `git status`, `git log`, `git diff`, `git show`, `git branch --show-current`, `git rev-parse --show-toplevel`, and `git ls-files` for orientation.
- `src/agent/prompts.ts` says dedicated tools should be preferred over shell-shaped commands.
- `src/agent/runtime.ts` formats tool results into follow-up model prompts and compact TUI labels.
- `src/tui/messages.ts` recognizes tool-call rows for subdued display.
- `test/tools.test.ts`, `test/inspect-command-tool.test.ts`, `test/commands.test.ts`, `test/tui.render.test.ts`, and `test/logging.test.ts` cover tool parsing, registry behavior, runtime loop behavior, TUI rendering, and logging boundaries.
- `docs/cli.md` tracks the user-visible interactive tool list.
- `docs/plans/kb-implementation-checklist.md` tracks tool execution progress.

Important baseline:

- `inspect_command` is read-only and intentionally narrow.
- The model prompt already says not to commit unless the user explicitly asks.
- The worktree may contain user changes. Git tools must preserve that rule by making file scope explicit and avoiding bulk staging.

## Competitor Findings

Local checkouts were inspected as requested by `AGENTS.override.md`.

### Codex

Relevant files:

- `~/data/github/codex/codex-rs/git-utils/src/info.rs`
- `~/data/github/codex/codex-rs/tui/src/get_git_diff.rs`
- `~/data/github/codex/codex-rs/app-server/src/request_processors/git_processor.rs`

Useful patterns:

- Collect branch, commit hash, and remote URL through bounded direct `git` commands.
- Use a short timeout for Git metadata calls.
- Treat non-Git directories as an empty or unavailable state instead of crashing.
- Build diffs from both tracked changes and untracked files.
- Accept Git diff exit code `1` as a successful "there are differences" result.
- Add `--no-ext-diff`, `--no-textconv`, and `--` where appropriate.

### OpenCode

Relevant files:

- `~/data/github/opencode/packages/opencode/src/git/index.ts`
- `~/data/github/opencode/packages/opencode/src/project/vcs.ts`

Useful patterns:

- Use one Git service instead of scattering ad hoc commands.
- Add stable Git config flags such as `--no-optional-locks`, `core.quotepath=false`, and `core.fsmonitor=false`.
- Parse `git status --porcelain=v1 --untracked-files=all --no-renames -z -- .`.
- Parse `git diff --name-status -z` and `git diff --numstat -z`.
- Generate untracked file patches separately.
- Cap total patch output and report truncation.

### Cline

Relevant file:

- `~/data/github/cline/src/utils/git.ts`

Useful patterns:

- Check Git availability, repo availability, and whether the repo has commits before diff/log operations.
- Return plain messages for missing Git, non-Git directories, and empty histories.
- Bound working-state output before passing it to the model.

### Kilo Code

Relevant files:

- `~/data/github/kilocode/packages/opencode/src/git/index.ts`
- `~/data/github/kilocode/packages/opencode/src/kilocode/commit-message/git-context.ts`

Useful patterns:

- Keep structured `status`, `path`, and `diff` records for model context.
- Prefer staged changes for commit-message context when staged files exist.
- Treat binary diffs specially.
- Avoid feeding huge lockfile diffs into commit-message context.

Topchester should not copy Kilo's lockfile filtering as a default Git tool behavior. The user already corrected Topchester away from hardcoded lockfile ignores. If diff summarization needs file filters later, that should be explicit and configurable.

### Pi

Relevant files:

- `~/data/github/pi/packages/coding-agent/src/core/tools/bash.ts`
- `~/data/github/pi/packages/coding-agent/src/core/bash-executor.ts`

Useful patterns:

- Process output should be bounded and cancellable.
- Full output can be stored separately later, but V0 should return compact bounded content.
- Broad bash is useful but does not replace a structured Git tool surface for safety.

## Recommended Contract

### `git_status`

Suggested tool call:

```json
{
  "tool": "git_status",
  "args": {
    "path": ".",
    "include_untracked": true
  }
}
```

Suggested args:

```ts
interface GitStatusToolArgs {
  path?: string;
  include_untracked?: boolean;
}
```

Suggested result:

```ts
interface GitStatusToolResult extends ToolResult<"git_status"> {
  repoRoot: string | null;
  branch: string | null;
  head: string | null;
  hasHead: boolean;
  clean: boolean;
  files: GitChangedFile[];
  truncated: boolean;
}

interface GitChangedFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "unknown";
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}
```

Suggested output text:

```text
branch: main
head: abc1234
clean: false

 M src/agent/runtime.ts
?? test/git-tools.test.ts
```

### `git_diff`

Suggested tool call:

```json
{
  "tool": "git_diff",
  "args": {
    "scope": "all",
    "path": "src/agent/runtime.ts",
    "include_untracked": true,
    "context_lines": 3
  }
}
```

Suggested args:

```ts
interface GitDiffToolArgs {
  scope?: "all" | "unstaged" | "staged";
  path?: string;
  include_untracked?: boolean;
  context_lines?: number;
  max_bytes?: number;
}
```

Suggested result:

```ts
interface GitDiffToolResult extends ToolResult<"git_diff"> {
  repoRoot: string | null;
  scope: "all" | "unstaged" | "staged";
  path: string | null;
  fileCount: number;
  truncated: boolean;
}
```

Diff rules:

- `scope: "unstaged"` runs `git diff --no-ext-diff --no-renames --unified=N -- <path?>`.
- `scope: "staged"` runs `git diff --cached --no-ext-diff --no-renames --unified=N -- <path?>`.
- `scope: "all"` returns unstaged plus staged output, labeled if both exist.
- `include_untracked: true` appends untracked patches for files in scope.
- Git diff exit code `1` is success.
- Binary output gets a plain summary instead of unsafe or unreadable bytes.

### `git_log`

Suggested tool call:

```json
{
  "tool": "git_log",
  "args": {
    "limit": 10,
    "path": "src/agent/runtime.ts"
  }
}
```

Suggested args:

```ts
interface GitLogToolArgs {
  limit?: number;
  path?: string;
}
```

Suggested result:

```ts
interface GitLogToolResult extends ToolResult<"git_log"> {
  repoRoot: string | null;
  commits: GitCommitSummary[];
  truncated: boolean;
}

interface GitCommitSummary {
  sha: string;
  shortSha: string;
  timestamp: number;
  subject: string;
  authorName: string;
}
```

Use a delimiter-safe format such as:

```sh
git log -n <limit> --pretty=format:%H%x1f%h%x1f%ct%x1f%an%x1f%s -- <path?>
```

### `git_add`

Suggested later tool call:

```json
{
  "tool": "git_add",
  "args": {
    "paths": ["src/agent/tools/git-status.ts", "test/git-tools.test.ts"],
    "expected_status": [
      { "path": "src/agent/tools/git-status.ts", "status": "modified" },
      { "path": "test/git-tools.test.ts", "status": "untracked" }
    ]
  }
}
```

Guardrails:

- Require non-empty explicit `paths`.
- Reject `.` and glob-like broad staging in V0.
- Reject paths outside the workspace.
- Reject paths not present in `git_status`.
- Require `expected_status` so the model proves it inspected the current status.
- Return the exact staged paths and post-stage status.
- Do not stage ignored files unless a future explicit `force` option is added.

### `git_commit`

Suggested later tool call:

```json
{
  "tool": "git_commit",
  "args": {
    "message": "Add structured git status tool",
    "expected_staged_paths": ["src/agent/tools/git-status.ts", "test/git-tools.test.ts"]
  }
}
```

Guardrails:

- Require an explicit user request to commit, enforced first through prompt guidance and later through an approval/intent bit when Topchester has one.
- Require non-empty staged changes.
- Require `expected_staged_paths` to exactly match the staged file list.
- Reject when unstaged changes touch the same paths unless the user explicitly accepts that risk.
- Run `git diff --cached --stat` and `git diff --cached --name-status` before committing and include those facts in the tool result.
- Use `git commit --no-gpg-sign -m <message>` only if V0 needs to avoid interactive signing hangs. Otherwise preserve local Git config and document the behavior.
- Return commit SHA, subject, staged file list, and remaining worktree status.

## Implementation Shape

Add one shared Git helper layer before adding individual tool definitions:

- `src/agent/tools/git.ts`
  - `gitStatusArgsSchema`, `gitDiffArgsSchema`, `gitLogArgsSchema`
  - `gitStatusTool`, `gitDiffTool`, `gitLogTool`
  - shared types for changed files, commit summaries, and git command metadata
- `src/agent/tools/git-runner.ts`
  - `runGit(...)`
  - `resolveGitWorkdir(...)`
  - `ensureInsideWorkspace(...)`
  - `getRepoInfo(...)`
  - `parsePorcelainStatus(...)`
  - `parseGitLog(...)`
  - output truncation helpers

Execution rules:

1. Resolve `path` or `workdir` inside the workspace.
2. Check `git --version` or run the first Git command and convert `ENOENT` into a clear missing-Git result.
3. Check repository state with `git rev-parse --show-toplevel`, `git rev-parse --verify HEAD`, `git symbolic-ref --quiet --short HEAD`, and `git rev-parse --short HEAD`.
4. Run Git commands with `execFile` or `spawn`, never with the shell.
5. Set safe environment defaults:
   - `GIT_OPTIONAL_LOCKS=0`
   - `GIT_PAGER=cat`
   - `PAGER=cat`
   - `LESS=-F -X`
6. Add stable config flags to every invocation:
   - `--no-optional-locks`
   - `-c core.quotepath=false`
   - `-c core.fsmonitor=false`
7. Bound each command with a timeout and output byte cap.
8. Decode UTF-8 output conservatively and detect binary data.
9. Keep structured metadata separate from `content`.
10. Log debug-level metadata only; full diff content remains trace-level through the existing executor behavior.

Smoke harness additions:

- Add a scenario-level Git bootstrap option to `scripts/smoke/run-smoke.ts` instead of committing `.git` directories into templates.
- The bootstrap should initialize a repo, set local test identity, create an initial commit when requested, and then apply requested staged, unstaged, deleted, and untracked changes.
- Add Git assertions that can check staged paths, unstaged paths, untracked paths, latest commit subject, latest commit touched paths, and remaining worktree state.
- Keep smoke assertions shell-free or `execFile`-based, with `--` before pathspecs when paths are passed to Git.
- Keep `scripts/smoke/fake-api.ts` updated so fake-model smoke runs cover the dedicated Git tools directly.

## Files to Add

- `src/agent/tools/git.ts`
- `src/agent/tools/git-runner.ts`
- `test/git-tools.test.ts`
- `scripts/smoke/scenarios/12-git-read-tools/config.json`
- `scripts/smoke/scenarios/12-git-read-tools/template/README.md`
- `scripts/smoke/scenarios/13-git-add-guard/config.json`
- `scripts/smoke/scenarios/13-git-add-guard/template/README.md`
- `scripts/smoke/scenarios/14-git-commit-guard/config.json`
- `scripts/smoke/scenarios/14-git-commit-guard/template/README.md`

Optional if mutation tools are implemented in separate files:

- `src/agent/tools/git-mutation.ts`
- `test/git-mutation-tools.test.ts`

## Files to Change

- `src/agent/tools.ts`
- `src/agent/tools/registry.ts`
- `src/agent/tools/executor.ts`
- `src/agent/prompts.ts`
- `src/agent/runtime.ts`
- `src/tui/messages.ts`
- `test/tools.test.ts`
- `test/commands.test.ts`
- `test/tui.render.test.ts`
- `test/logging.test.ts`
- `scripts/smoke/run-smoke.ts`
- `scripts/smoke/fake-api.ts`
- `scripts/smoke/README.md`
- `docs/cli.md`
- `docs/plans/kb-implementation-checklist.md`

## Cross-Slice Rules

- Keep read tools and mutation tools in separate slices.
- Keep Git tools implemented as direct process calls, not `inspect_command` wrappers.
- Preserve the user's unrelated changes. Mutation tools must operate on explicit paths only.
- Always use `--` before pathspecs.
- Do not hardcode lockfile ignores or generated-file ignores in Git tools.
- Do not auto-stage or auto-commit after file edits.
- Do not expose broad Git mutation commands as command strings.
- Keep output bounded and mark truncation plainly.
- Keep diff content out of debug logs.
- Treat Git state as current working-tree evidence, not canonical KB truth.
- Update docs in the same implementation change that exposes model-visible Git tools.
- Git tools are not done until the smoke suite has checked-in coverage. Add or update smoke scenarios in the same slice that exposes each Git capability.

## Slices

### Slice 1: Shared Git Runner And Parsers

Status: `[x]` Completed

Goal: Create the reusable Git execution and parsing boundary without registering any new model-visible tools.

Why here: Git safety depends on consistent process execution, path containment, timeout behavior, and parsing. Prove that layer before the model can call it.

This slice should implement:

- `runGit(...)` using direct process execution.
- Stable Git config/env defaults.
- Workspace-contained workdir and path resolution.
- Repo metadata helpers for repo root, branch, HEAD, and has-HEAD state.
- Status parser for `--porcelain=v1 -z`.
- Log parser for delimiter-separated output.
- Diff command helper that treats exit code `1` as success.
- Untracked file discovery helper.
- Output truncation and binary-output detection helpers.

Expected output:

- New shared Git helper module.
- Tests that do not depend on the agent registry.
- Coverage for non-Git directories, missing commits, staged/unstaged/untracked status, quoted paths, filenames with spaces, output truncation, and workspace escape rejection.

Verification:

```sh
pnpm test test/git-tools.test.ts
pnpm typecheck
```

Dependencies: None.

### Slice 2: Read Tool Contracts

Status: `[x]` Completed

Goal: Implement `git_status`, `git_diff`, and `git_log` as tool definitions while keeping them unregistered until runtime formatting is ready.

Why here: The tool contracts should be tested directly before they become model-visible.

This slice should implement:

- Zod schemas for the three read tools.
- `gitStatusTool`.
- `gitDiffTool`.
- `gitLogTool`.
- Structured result metadata.
- Clear non-Git, no-commit, clean-worktree, and missing-Git outputs.
- File-scoped diff/log support.
- Optional untracked diff support.

Expected output:

- Direct tool tests can execute each read tool.
- `git_diff` reports `truncated: true` when capped.
- `git_status` returns clean/dirty state plus structured changed files.
- `git_log` returns bounded recent commits without raw shell parsing.

Verification:

```sh
pnpm test test/git-tools.test.ts
pnpm typecheck
```

Dependencies: Slice 1.

### Slice 3: Registry, Prompt, Runtime, And TUI Integration

Status: `[x]` Completed

Goal: Expose read Git tools to the model and show compact Git rows in the thread.

Why here: The model should only see the tools after the core contract and result formatting are stable.

This slice should implement:

- Export the Git tools from `src/agent/tools.ts`.
- Register read tools in `src/agent/tools/registry.ts`.
- Add concise tool prompt lines with example calls.
- Update `src/agent/prompts.ts` to prefer Git tools over `inspect_command` for Git state.
- Add runtime prompt formatting for status, diff, and log results.
- Add compact labels:
  - `git_status: 2 changed`
  - `git_diff: all (2 files, truncated)`
  - `git_log: 10 commits`
- Add TUI message recognition for the new tool rows.
- Add executor metadata summarization for Git results.
- Add smoke scenario `12-git-read-tools`.
- Extend the smoke harness only as needed to initialize a temporary Git repo in a scenario workspace before Topchester runs.
- Extend `scripts/smoke/fake-api.ts` so fake smoke runs exercise `git_status` and `git_diff`, not `inspect_command`.

Expected output:

- The model can call read Git tools through native or text tool protocols.
- The transcript shows compact Git rows.
- Follow-up model prompts receive enough structured Git facts to continue safely.
- `mise run smoke-scenario 12-git-read-tools 1` validates that the model uses dedicated Git read tools against a dirty repo.

Verification:

```sh
pnpm test test/tools.test.ts test/git-tools.test.ts test/commands.test.ts test/tui.render.test.ts
pnpm exec tsx scripts/smoke/run-smoke.ts --dry-run
pnpm typecheck
```

Dependencies: Slice 2.

### Slice 4: Read Tool Docs And Checklist

Status: `[x]` Completed

Goal: Update user-facing docs after read Git tools ship.

Why here: Model-visible tool behavior is part of the CLI/TUI product surface.

This slice should implement:

- Update `docs/cli.md` Agent Tools section.
- Update `docs/plans/kb-implementation-checklist.md` Tool Execution section.
- Mention that mutation tools are intentionally not available yet.
- Mention that `inspect_command` can still inspect read-only Git commands but dedicated Git tools are preferred.

Expected output:

- Docs match the shipped read-tool behavior.
- The checklist records shipped Git read tools and remaining mutation work.

Verification:

```sh
pnpm check
```

Dependencies: Slice 3.

### Slice 5: Guarded `git_add`

Status: `[x]` Completed

Goal: Add explicit-path staging after read tools have proven the current Git state contract.

Why here: Staging is the first mutation boundary. It must depend on structured status and path validation.

This slice should implement:

- `gitAddTool` with explicit `paths` and `expected_status`.
- Path containment and `--` pathspec handling.
- Rejection of empty paths, `.`, broad globs, and paths absent from current status.
- Rejection when `expected_status` does not match current status.
- Post-stage status output.
- Prompt guidance that staging requires explicit user intent.
- Runtime and TUI labels such as `git_add: 2 files staged`.
- Add smoke scenario `13-git-add-guard` with at least two dirty files where the prompt asks to stage exactly one file.

Expected output:

- The model can stage only named files whose current status it has acknowledged.
- Unrelated files stay untouched.
- `mise run smoke-scenario 13-git-add-guard 1` validates that only the requested path becomes staged.

Verification:

```sh
pnpm test test/git-tools.test.ts test/tools.test.ts test/commands.test.ts
pnpm exec tsx scripts/smoke/run-smoke.ts --dry-run
pnpm typecheck
```

Dependencies: Slices 1-4.

### Slice 6: Guarded `git_commit`

Status: `[x]` Completed

Goal: Add explicit commit support with staged-file verification.

Why here: Commit creation is valuable, but it should only land after staging is safe and reviewable.

This slice should implement:

- `gitCommitTool` with `message` and `expected_staged_paths`.
- Staged-file status check before commit.
- Exact staged-path match requirement.
- Pre-commit staged diff/stat summary in the result.
- Clear rejection when there are no staged changes.
- Clear rejection when staged files differ from expected paths.
- Clear handling of Git hooks, signing prompts, or commit failures.
- Runtime and TUI labels such as `git_commit: abc1234 Add structured git status tool`.
- Add smoke scenario `14-git-commit-guard` where the prompt stages and commits exactly one file while an unrelated dirty file remains outside the commit.

Expected output:

- The model can commit only an explicitly staged and acknowledged file set.
- The tool returns the new commit SHA and remaining worktree state.
- `mise run smoke-scenario 14-git-commit-guard 1` validates that the commit contains only the expected file and leaves unrelated worktree changes intact.

Verification:

```sh
pnpm test test/git-tools.test.ts test/tools.test.ts test/commands.test.ts test/tui.render.test.ts
pnpm exec tsx scripts/smoke/run-smoke.ts --dry-run
pnpm check
```

Dependencies: Slice 5.

### Slice 7: Branch And PR Follow-Up Decision

Status: `[x]` Completed

Goal: Decide whether branch creation and PR creation belong in the same Git tool family or in a separate provider integration.

Why here: Branch and PR workflows cross from local repository mutation into remote/provider behavior. They need a product decision after local Git tools are proven.

This slice should evaluate:

- `git_checkout_new_branch` as a narrow local branch creation tool.
- Whether branch creation should require clean status.
- `create_pr` through `gh`, GitHub app APIs, or provider-specific adapters.
- How Topchester should display remote/network operations in the TUI.
- Whether PR creation should depend on a future approval framework.

Expected output:

- A short follow-up plan or an update to this plan with the chosen direction.

Decision:

- Keep branch creation and PR creation out of the V0 Git tool family.
- Treat local branch creation as a future narrow `git_checkout_new_branch` tool only after the approval/intent contract exists.
- Treat PR creation as a provider integration, not a direct Git tool. Prefer GitHub app APIs or a provider adapter over exposing `gh` command strings to the model.
- Require a future approval framework before any network or remote mutation tool such as push, pull, fetch, or PR creation is model-visible.

Verification:

```sh
pnpm check
```

Dependencies: Slices 1-6.

## Testing Plan

Per-slice tests are listed above.

Focused test fixtures should create temporary Git repositories with:

- no `.git` directory,
- a Git repo with no commits,
- a clean repo with one commit,
- unstaged tracked modifications,
- staged modifications,
- deleted files,
- renamed files if V0 chooses to preserve rename status,
- untracked files,
- filenames with spaces,
- paths that look like flags, such as `--help.txt`,
- binary files,
- large diffs that force truncation.

Final confidence pass after read tools:

```sh
pnpm check
pnpm exec tsx scripts/smoke/run-smoke.ts --dry-run
pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --scenario 12-git-read-tools --trials 1
```

Final confidence pass after mutation tools:

```sh
pnpm check
pnpm exec tsx scripts/smoke/run-smoke.ts --dry-run
pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --trials 1
```

Required checked-in smoke scenarios:

- `12-git-read-tools`
  - Workspace starts as a Git repo with one committed file, one modified tracked file, one staged file, and one untracked file.
  - Prompt: `Show me the current git status and summarize the diff.`
  - Required tool calls: `git_status`, `git_diff`.
  - Forbidden tool calls: `inspect_command`.
  - Assertions: no staged or unstaged state changes are introduced by the run.
- `13-git-add-guard`
  - Workspace starts as a Git repo with at least two dirty files.
  - Prompt asks to stage exactly one named file and leave the other file alone.
  - Required tool calls: `git_status`, `git_add`.
  - Assertions: only the named file is staged; unrelated dirty and untracked files remain unstaged.
- `14-git-commit-guard`
  - Workspace starts as a Git repo with at least two dirty files.
  - Prompt asks to stage and commit exactly one named file with a fixed message.
  - Required tool calls: `git_status`, `git_add`, `git_commit`.
  - Assertions: latest commit subject matches the prompt, latest commit touched paths match the expected file set, and unrelated worktree changes remain outside the commit.

Manual smoke prompt after read tools:

```text
Show me the current git status and summarize the diff.
```

Expected read-tool smoke behavior:

- The model calls `git_status`.
- The model calls `git_diff` if changes exist.
- The TUI shows compact Git tool rows.
- The answer reports changed files and truncation, if any.
- No files are staged or committed.

Manual smoke prompt after mutation tools:

```text
Stage only docs/plans/2026-05-14-git-tools-plan.md and commit it with message "Plan structured git tools".
```

Expected mutation-tool smoke behavior:

- The model calls `git_status`.
- The model calls `git_diff` or reports the staged candidate before mutation.
- The model calls `git_add` with exactly that path.
- The model calls `git_commit` only after staged paths match the expected list.
- Unrelated modified or untracked files remain unstaged.

Smoke execution policy:

- Implementation slices must keep `pnpm exec tsx scripts/smoke/run-smoke.ts --dry-run` green.
- It is safe to run the local deterministic smoke battery with `pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --trials 1`; the equivalent mise wrapper is `mise run smoke 1`.
- The end-goal requirement for this plan is a green fake-API smoke battery with the Git scenarios included.
- Do not require CI to run `mise run smoke` in this plan.

## Open Questions

- Should `git_diff` default to `scope: "all"` or `scope: "unstaged"`?
- Should untracked diffs be included by default, or only when `include_untracked: true`?
- Should `git_status` include ahead/behind counts in V0?
- Should `git_log` support `grep` or author filtering now, or wait until a history-search use case appears?
- Should `git_commit` preserve local signing hooks by default, or use `--no-gpg-sign` to avoid interactive hangs?
- Should the mutation tools require a runtime-level user-intent token once Topchester has an approval framework?
- Should large diff output be saved under `.agents/topchester/` for later expansion, or is bounded inline output enough for V0?

## Next Slice

Start with Slice 1: Shared Git Runner And Parsers.
