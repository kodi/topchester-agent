# Bash-Only Command Execution Plan

## Summary

Remove `run_validator` and its command-shape policy. Use the existing approval-gated `bash` tool for tests, lint, type checks, builds, smoke checks, package-manager commands, and all other shell work.

The strict validator parser rejects valid repository commands as package managers, task runners, monorepos, and test frameworks add new command forms. Its script-name classification is also not a strong safety boundary because a repository controls what named scripts execute. The existing bash approval, deny-rule, workspace, hook, timeout, and output boundaries remain the command safety model.

## Decisions

- `bash` is the only model-visible command execution tool.
- Delete `run_validator`; do not keep an alias or compatibility parser.
- Delete the validator-only command policy instead of expanding it for more command variants.
- Verification failures from `bash` remain normal command results that the model must inspect and fix.
- Preserve `tools.bash.allow`, `allowExact`, and `deny` behavior.
- Preserve current interactive approval behavior: run once, exact command for the session, or exact command for the repo.
- Preserve historical plans and changelog entries that describe the old tool.

## Scope

Included:

- tool registry, public exports, prompt guidance, runtime formatting, logging, and child-agent guidance;
- validator-only implementation and policy removal;
- tests and fake-model smoke coverage;
- current public and internal documentation;
- exact full-gate verification through Mise.

Out of scope:

- changing bash approval matching or adding interactive prefix-choice actions;
- changing destructive-command detection, sandboxing, hooks, or workspace boundaries;
- rewriting historical plans, checklists, and changelog entries.

## Behavior To Preserve

- Unknown bash commands use the existing interactive approval flow.
- Project and user config can allow exact commands or command prefixes, with deny rules taking precedence.
- Bash commands stay inside the workspace-selected working directory.
- Output remains bounded and reports exit code, duration, timeout, abort, and truncation state.
- Non-zero command exits remain evidence, not tool transport failures.
- Dedicated read, search, edit, write, and Git tools remain preferred for their own work.

## Cross-Slice Rules

- Do not edit the unrelated local change in `config/gpt-5.6-sol.jsonc`.
- Use only Mise tasks for repository checks.
- Do not leave a second validator-shaped execution path behind under another name.
- Keep historical documentation intact unless it incorrectly presents old behavior as current.

### Slice 1: Runtime and model contract

Status: `[x]` Complete

Goal: Remove `run_validator` from every live tool and prompt path.

This slice should implement:

- delete the validator tool and validator-only command policy;
- remove registry entries, exports, runtime formatting, and logging branches;
- update model and child-agent guidance to use `bash` for verification;
- keep bash execution metadata and approval behavior unchanged.

Verification:

- `mise run typecheck` passed with 202 files.
- `mise run test-node -- test/tools.test.ts test/bash-tool.test.ts test/logging.test.ts` passed with 4 files and 139 tests.

Dependencies: none.

### Slice 2: Tests and smoke contract

Status: `[x]` Complete

Goal: Make automated coverage prove the bash-only command surface.

This slice should implement:

- remove validator parser/policy tests;
- update tool catalog, prompt, logging, and runtime expectations;
- replace the validator smoke scenario with bash verification coverage or remove duplicate coverage when the existing bash smoke already proves it;
- assert `run_validator` is absent from model-visible tools.

Verification:

- `mise run test` passed with 38 files and 609 Node tests, plus the production OpenTUI Bun renderer test.
- `mise run smoke` passed all 19 remaining scenarios.

Dependencies: Slice 1.

### Slice 3: Current documentation

Status: `[x]` Complete

Goal: Document one shell tool and one approval model.

This slice should implement:

- update current CLI, TUI, configuration, model-config, hooks, and architecture references;
- explain that tests and builds use `bash` and follow normal approval rules;
- keep historical plans and changelog entries unchanged.

Verification:

- `mise run local-ci` passed format checking, type checking, and lint.
- `git diff --check` passed.

Dependencies: Slices 1 and 2.

### Slice 4: Full verification and handoff

Status: `[x]` Complete

Goal: Prove the repository works without the validator surface.

Verification:

- `mise run local-ci` passed.
- `mise run test` passed.
- `mise run smoke` passed.
- `git diff --check` passed.

Dependencies: Slices 1 through 3.

## Running Findings

- 2026-08-15: A real Gantempo call used `pnpm --filter @gantempo/playground build`. The validator treated `--filter` as a package script and rejected the valid pnpm command before execution.
- 2026-08-15: The local Pi, OpenCode, Codex, Cline, Kilo Code, Hermes Agent, and OpenClaw checkouts expose a general shell or exec tool. They put safety around execution with approval, sandbox, allowlist, hook, or dangerous-command layers instead of maintaining a separate test-command grammar.
- 2026-08-15: Topchester already supports configured prefix rules under `tools.bash.allow`, but interactive session/repo approval actions persist exact commands only. That behavior is not changed by this plan.
- 2026-08-15: The first full Node test run hit sandbox-only `EPERM` errors while binding localhost. The same `mise run test-node` task passed outside that sandbox with 38 files and 609 tests.
- 2026-08-15: The repository has no `docs-check` Mise task. Current documentation is covered by `mise run local-ci` and `git diff --check`.
- 2026-08-15: Full verification passed: local CI, 609 Node tests, the production OpenTUI Bun renderer test, and all 19 smoke scenarios.

## Next Slice

None. The bash-only command execution change is implemented and verified.
