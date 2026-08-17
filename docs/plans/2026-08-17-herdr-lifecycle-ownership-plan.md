# Herdr lifecycle ownership hardening

## Summary

Prevent tests and nested subprocesses from claiming a live Herdr pane as `topchester`, and guarantee that a real Topchester process releases its lifecycle claim after both orderly and forced termination.

## Decisions

- A reporter may claim a pane only when it is running in the root Topchester CLI process and Herdr confirms that exact PID is a foreground process in the pane.
- The root-process marker alone is insufficient because packed PTY tests inherit the parent pane environment.
- Normal shutdown keeps using the in-process release path.
- A detached lifecycle guard watches the confirmed owner PID and performs an idempotent, retried release after any process death, including `SIGKILL`.
- Lifecycle sources are PID-scoped so an old guard cannot release a newer process's claim in the same pane.
- Herdr reporting remains best effort and must not prevent Topchester startup or shutdown.

## Scope

Included:

- Herdr ownership validation
- root CLI ownership marker
- forced-termination cleanup guard
- focused regression tests
- cleanup of the currently stale pane claim after verification

Out of scope:

- changes to Herdr itself
- changing Herdr's agent detection rules
- changing Topchester's user-facing CLI

## Slice 1: Foreground ownership contract

Status: `[x]` Done

- require an internal owner PID matching the reporter process
- ask Herdr for pane process information and require the current PID in the foreground process list
- verify inherited tests and nested processes cannot report

Verification: `mise run test-node -- test/herdr.test.ts` — 10 tests passed.

## Slice 2: Process-death cleanup

Status: `[x]` Done

- start one detached lifecycle guard after the first successful report
- have the guard watch the owning PID and release the exact source/agent claim after it exits
- preserve normal controller and run-command release behavior

Verification: `mise run test-node -- test/herdr.test.ts` — includes a real child terminated with `SIGKILL`.

Dependency: Slice 1

## Slice 3: Repository and live-pane verification

Status: `[x]` Done

- run focused tests, formatting, lint, type checking, and the repository test gate
- confirm no test run changes the live pane agent label
- release the pre-existing stale `topchester:lifecycle` claim

Verification: `mise run local-ci-extended`, `git diff --check`, and live `herdr pane get`

Dependency: Slices 1 and 2

## Verified results

- `mise run test-node -- test/herdr.test.ts` — 10 tests passed, including an actual child killed with `SIGKILL` and bounded cleanup retry.
- `mise run local-ci-extended` — formatting, lint, type checking, 659 product tests, the production renderer, native package installation, and packed PTY smoke all passed.
- `git diff --check` — passed.
- The stale `topchester:lifecycle` claim on the active pane was released with a newer sequence.
- After both the full product suite and packed PTY smoke inherited the live Herdr environment, `herdr pane get` still showed no `topchester` agent claim and the server log showed no test-originated lifecycle API calls.
