# Alpha Tool Gap Analysis Plan

## Summary

Topchester has the right shape for a terminal coding agent, but its external tool surface is still thinner than the current alpha bar set by Claude Code, Codex CLI, Gemini CLI, Cursor, Aider, GitHub Copilot, and Amp.

Do not count Topchester's internal KB tools, KB MCP adapter work, or KB compiler/status/sync commands as part of this gap analysis. This plan only tracks user-visible external tools the coding agent can use to inspect, change, verify, and research a normal repository.

## Current Topchester Tools

Topchester currently exposes these workspace-scoped agent tools:

- `read_file` — read a UTF-8 file inside the workspace and return hash metadata.
- `list_files` — list files and folders inside a workspace folder.
- `grep` — search text inside workspace file contents.
- `find_file` — find existing workspace files by fuzzy path or filename.
- `edit_file` — edit existing UTF-8 files with exact `old_text` and `new_text` replacements.
- `write_file` — create new UTF-8 files by default, with guarded whole-file overwrite support.
- `git_status`, `git_diff`, `git_log`, `git_add`, and `git_commit` — inspect Git state and perform guarded explicit staging/commit operations.
- `inspect_command` — run a small allowlisted set of read-only discovery commands.
- `web_fetch` — fetch public HTTP(S) pages with private-network blocking, redirect visibility, size caps, and markdown/text/html output.
- `plan_todo` — keep a visible session-only task plan for multi-step work.

Important limits:

- No general command execution.
- No test, lint, typecheck, or build runner.
- No directory creation tool.
- No web search tool.
- No browser automation.
- No external MCP/custom tool support beyond the KB architecture.

## Competitor Snapshot

| Competitor                  | External tools and surfaces found                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                 | File read/edit/write, shell, grep/glob, web fetch/search, image input, git/PR workflows, MCP, Chrome/browser automation, todos, subagents, hooks, skills, `CLAUDE.md` memory.             |
| OpenAI Codex CLI            | File read/edit, local command execution, web search, image input/generation/editing, MCP, subagents, custom agents, GitHub/cloud PR workflows, `AGENTS.md`, memories.                     |
| Google Gemini CLI           | Shell, glob, grep, list/read/write files, web search/fetch, text/image/audio/PDF reads, MCP, plan mode, extensions, skills, subagents, `GEMINI.md`.                                       |
| Cursor Agent/CLI            | Terminal, file/search/semantic search, web search, browser automation with screenshots/console/network, media reads, MCP, rules, hooks, subagents, cloud agents, PR review.               |
| Aider                       | File edits, repo map, multi-file edits, git auto-commit/diff/undo, dirty-file protection, `/run`, `/test`, `/lint`, `/git`, `/web`, URL scrape, image/screenshot input, convention files. |
| GitHub Copilot coding agent | File and shell agent mode, Actions-backed tests, branch/PR work, issue-to-PR workflows, MCP, custom agents, repository instructions, prompt files, memory, code review.                   |
| Amp                         | File edits, shell/git, web search/page retrieval, image/PDF support, image generation/editing, MCP, skills/toolboxes, plugins, subagents, `AGENTS.md`, thread search.                     |

## Table-Stakes Tool Categories

Across competitors, these are the common tool categories:

1. File read, search, edit, and write.
2. Shell or terminal command execution with approvals, policy, or sandboxing.
3. Codebase search through grep/glob, repo maps, semantic search, or search agents.
4. Git-aware workflows for status, diff, commits, branches, PRs, and review.
5. Test, lint, typecheck, and build integration.
6. Project instruction files or persistent rules.
7. MCP, extensions, skills, plugins, or custom tools.
8. Web fetch/search and image/screenshot input.

## Top 5 Missing Tools For Alpha

### 1. `run_command` / `run_validator`

Weight: `30`

This is the biggest alpha blocker. Topchester can edit code but cannot run tests, lint, typecheck, builds, package scripts, or focused verification commands.

Suggested scope:

- Add a command runner that can execute project scripts and common validators.
- Require approval or a strict policy for risky commands.
- Return command, cwd, exit code, duration, timeout, truncation, stdout, and stderr.
- Prefer a separate `run_validator` affordance for test/lint/typecheck/build commands so verification is first-class in the TUI.
- Preserve `inspect_command` as read-only orientation, not a shortcut to command execution.

Why first:

- Every serious coding task needs verification.
- Competitors all expose command execution or validation loops.
- Without this, Topchester cannot close the loop after code edits.

### 2. `write_file` / `create_file` / `mkdir`

Weight: `24`

Topchester's `edit_file` can only change existing UTF-8 files. Alpha users need the agent to add tests, new source files, config files, fixtures, and generated project files.

Suggested scope:

- Add `write_file` for new UTF-8 files inside the workspace.
- Reject overwrites unless explicitly allowed by an expected state argument.
- Add `mkdir` or let `write_file` create parent directories only when requested.
- Return created path, hash, byte count, and KB dirty state.
- Keep exact-diff behavior for existing-file edits.

Why second:

- Adding tests and new modules is a normal coding-agent task.
- File creation is table-stakes in Claude Code, Codex, Gemini CLI, Cursor, Aider, Copilot, and Amp.

### 3. First-Class Git Tools

Weight: `18`

Topchester can inspect some git state through `inspect_command`, but it has no structured git workflow tools.

Suggested scope:

- Add read tools first: `git_status`, `git_diff`, and `git_log`.
- Then add guarded mutation tools: `git_add`, `git_commit`, and maybe `git_checkout_new_branch`.
- Later add `create_pr` through `gh` or provider APIs.
- Always show exact files and diffs before commit operations.
- Never stage unrelated or untracked files without explicit user intent.

Why third:

- Competitors are git-aware by default.
- Reviewable diffs and commits are central to terminal coding-agent trust.
- Git tools help enforce repository safety better than arbitrary shell calls.

### 4. `web_fetch` / `web_search`

Weight: `15`

Status: `web_fetch` shipped in the `2026-07-08-web-fetch-tool-v0-plan.md` implementation. `web_search` remains open.

Coding agents regularly need current docs, changelogs, API references, issue pages, package behavior, and public examples.

Suggested scope:

- Add `web_fetch` for user-provided or model-selected HTTP(S) URLs.
- Add `web_search` for public web search when model knowledge may be stale.
- Block local, private-network, file, SSH, and malformed URLs.
- Return title, URL, extracted text, and truncation metadata.
- Keep network access visible in the TUI.

Why fourth:

- Web tools are now common across Claude Code, Codex, Gemini CLI, Cursor, Aider, and Amp.
- This prevents the agent from guessing about current package and platform behavior.

### 5. `plan_todo`

Weight: `13`

Topchester's prompt tells the model to make an internal plan, but users cannot see or trust that plan as work progresses.

Status: shipped in the `2026-05-14-plan-todo-tool-plan.md` implementation. The remaining work in this gap area is product refinement, not V0 capability.

Suggested scope:

- Add a lightweight task tracker tool with statuses such as `pending`, `in_progress`, and `completed`.
- Show the current plan in the TUI during multi-step work.
- Require one active task at a time.
- Update after major tool results.
- Keep this separate from the KB; it is session task state, not canonical project knowledge.

Why fifth:

- Long tasks become easier to follow and recover.
- Claude, Codex, Gemini CLI, Cursor, and Amp all expose plan, todo, subagent, or task-state mechanics.
- It improves alpha trust without requiring a full plugin ecosystem.

## Recommended Alpha Order

1. Ship `run_command` / `run_validator`.
2. Ship `write_file` and directory creation.
3. Ship structured git read tools, then guarded git mutation tools.
4. Ship web fetch/search. `web_fetch` shipped; `web_search` remains open.
5. Ship visible planning/todo state. `[x]`

## Just Outside The Top 5

### External MCP / Custom Tools

MCP and extension systems are common now, but they should come after the core alpha loop works. External tools multiply capability, but they also multiply policy, permissions, prompt budget, and failure modes.

Do not count the KB MCP adapter here. That is an internal access surface for Topchester's own KB contract.

### Browser Automation

Browser automation is a strong differentiator for web app work, especially with screenshots, console logs, network requests, and form interaction. It should come after command execution, file creation, git, web, and planning are solid.

### Subagents

Subagents help with parallel research and context isolation, but they are less urgent than the core edit-and-verify loop.

## Acceptance Bar For Alpha

Topchester is much closer to alpha when it can handle this normal task without outside help:

1. Read and search the repo.
2. Make edits across existing and new files.
3. Run focused tests or validators.
4. Inspect git status and diff.
5. Fetch current docs when needed.
6. Keep a visible task plan while working.
7. Report changed files, validation results, and remaining risk plainly.

## Sources Checked

- Claude Code docs: `https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview`
- Codex CLI docs: `https://developers.openai.com/codex/cli/features`
- Gemini CLI tools docs: `https://geminicli.com/docs/reference/tools/`
- Cursor docs: `https://cursor.com/docs`
- Aider docs: `https://aider.chat/docs/`
- GitHub Copilot docs: `https://docs.github.com/en/copilot/get-started/features`
- Amp manual: `https://ampcode.com/manual`
