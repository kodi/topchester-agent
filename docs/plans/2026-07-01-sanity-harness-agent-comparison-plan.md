# SanityHarness Agent Comparison Follow-Up Plan

## Summary

Topchester and Pi were both run on the SanityHarness `core` suite with `openrouter/openai/gpt-5.4`, `--timeout 600`, `--no-sandbox`, and kept workspaces. Both scored 9/12, with the same weighted score (`10.62 / 14.36`, 74.0%) and the same broad shape: 3/4 passing in Go, Rust, and TypeScript.

This plan captures the useful differences and turns them into small Topchester improvements for the next pass. The goal is not to overfit the benchmark tasks, but to improve benchmark readiness, validation behavior, and hidden-test robustness for normal coding tasks.

## Current Results

Topchester run:

- Results: `eval-results/2026-07-01T003556-topchester`
- Pass rate: 9/12, 75.0%
- Weighted pass rate: 74.0%
- Total duration: 651.7s
- Agent duration: 325.3s
- Validation duration: 326.0s
- Self-test commands: 40 total, 8/12 tasks
- Out-of-workspace read attempts: 12 total, 12/12 tasks

Pi run:

- Results: `eval-results/2026-07-01T011143-pi-fixed`
- Pass rate: 9/12, 75.0%
- Weighted pass rate: 74.0%
- Total duration: 346.9s
- Agent duration: 332.5s
- Validation duration: 14.0s
- Self-test commands: 8 total, 8/12 tasks
- Out-of-workspace read attempts: 0 total, 0/12 tasks

The pass/fail result is essentially tied. Pi looked slightly better operationally because the run completed faster and avoided out-of-workspace-read telemetry, but Topchester made more visible self-test attempts.

## Failure Comparison

Both agents failed the same three tasks:

- `go/errgroup-limit`
- `rust/regex-lite`
- `typescript/promise-pool`

Failure themes:

- `go/errgroup-limit`: Hidden tests require stricter "stop scheduling after first error" semantics than visible tests prove. Topchester started goroutines eagerly and only stopped after task execution produced an error. Pi also failed this task, but in a different way, timing out waiting for expected initial tasks.
- `rust/regex-lite`: Topchester used recursive memoized DP and hidden validation hit stack overflow on long text. Pi avoided the stack overflow but still failed an alternating-star hidden case. The common lesson is that hidden tests stress both algorithmic performance and exact `*` semantics.
- `typescript/promise-pool`: Both failed hidden rejection/concurrency edge cases. Topchester also could not locally verify because `tsx` was unavailable in the temp workspace, so it stopped with known verification uncertainty.

## Decisions

- Treat this as a Topchester benchmark behavior follow-up, not as a SanityHarness task patch.
- Keep benchmark changes narrow and measurable.
- Do not add benchmark-specific prompt hacks that mention task names.
- Prefer improving tool policy, validation access, and general hidden-test reasoning.

## Scope

Included:

- Better local validation command support in benchmark workspaces.
- Reduced noisy out-of-workspace telemetry.
- Stronger guidance for edge-case self-tests after visible tests pass.
- Better cost/generation-id observability for OpenRouter runs.

Out of scope:

- Changing SanityHarness hidden tests.
- Editing generated benchmark solutions.
- Shipping public docs changes unless user-facing CLI behavior changes.

## Tool-Focused Speed Plan

The fastest useful path is to make validation a first-class tool path instead of letting common validators spill into approval-gated `bash`.

1. Expand `run_validator` for common benchmark ecosystems while preserving its strict no-shell contract.
   - Accept direct validators for Go, Rust/Cargo, Node test runner, and locally declared TypeScript test runners.
   - Reject shell syntax, install/package-resolution commands, destructive-looking commands, and output-writing validator variants.
   - Expected effect: fewer rejected tool calls, fewer bash approval events, and more complete local verification.
2. Make `bash` the fallback for real shell work, not routine validation.
   - Keep bash available for pipes, redirects, command chaining, one-off user shell commands, and package manager work that cannot fit validator policy.
   - Tell the model to use `run_validator` for strict test/check shapes before trying bash.
   - Expected effect: fewer tool retries and less finish-gate noise from bash calls that are really validators.
3. Add benchmark-profile hidden-edge checks after visible validators pass.
   - Bound this to 2-4 checks and keep it general: concurrency rejection/scheduling, long input performance, recursive/star patterns, and non-positive limits.
   - Expected effect: improve hidden-test robustness without long exploratory loops.
4. Measure the tool loop directly.
   - Track rejected `run_validator` calls, bash calls that look like validators, validator duration, self-test count, and tool-call count per task.
   - Use this to decide whether a prompt nudge or policy change actually reduces turns.

## Improvement Slices

### Slice 1: Fix Validator Friction For Common Task Toolchains

Status: `[-]` In progress

Goal: Let Topchester use the obvious validator command for Go, Rust, and TypeScript tasks without falling back to generic bash or failing policy checks.

Why here: Several logs show rejected validator attempts such as `cargo test`, `go test ./...`, and `tsx --test ...`. Topchester often recovered with `bash`, but the friction wastes turns and sometimes leaves validation incomplete.

This slice should implement:

- [x] Review `run_validator` command policy for benchmark-compatible validators.
- [x] Allow safe test shapes for:
  - `go test ./...`
  - `go test -count=1 -race -v ./...`
  - `cargo test`
  - `cargo test --test <name>`
  - `node --test <files>`
  - `npx tsx --test <files>` when `tsx` is declared in the nearest `package.json`.
- [x] Keep install and package-resolution commands out of validator policy.
- [x] Update `run_validator` and `bash` tool prompts so strict validator shapes go to `run_validator` first.
- [ ] Rerun a SanityHarness task that previously hit validator friction.

Completed so far:

- Added direct `go test` validator support, while rejecting `go test -c`, `-exec`, and `-toolexec`.
- Added direct `cargo test` validator support.
- Added direct `tsx --test` and guarded `npx tsx --test` support; `npx tsx` is accepted only when `tsx` is declared locally.
- Added tests for the accepted benchmark command shapes and rejected package-resolution/destructive-adjacent shapes.
- Verified:
  - `mise run test -- test/bash-tool.test.ts test/tools.test.ts`
  - `mise run typecheck`

Expected output:

- Focused policy/test changes in the validator/tool command layer.
- Tests proving accepted and rejected command shapes.

Verification:

- `mise run test -- test/tools.test.ts`
- `mise run typecheck`
- One SanityHarness single-task rerun where previous validator friction appeared, such as `typescript/promise-pool`.

Dependencies: None.

### Slice 2: Stop Counting Internal Runtime Reads As Benchmark Out-Of-Workspace Reads

Status: `[ ]` Not started

Goal: Understand and reduce Topchester's 12/12 out-of-workspace-read telemetry without weakening benchmark isolation.

Why here: Pi had 0 out-of-workspace reads. Topchester had 1 on every task. The report marks them non-confident, but it is still a noisy benchmark signal and worth cleaning up.

This slice should implement:

- Inspect SanityHarness telemetry for what it counts as out-of-workspace reads in Topchester runs.
- Check whether Topchester startup is reading global config, auth state, skills, or `.agents` paths outside the temp workspace.
- If the reads are legitimate runtime config/auth reads, decide whether they can be moved into env/config passed by the wrapper for benchmark mode.
- If the telemetry is a harness false positive, document the evidence and consider a custom wrapper mode that avoids the signal.

Expected output:

- A short finding in this plan or a follow-up note.
- Optional wrapper/config adjustment if there is a simple safe fix.

Verification:

- Rerun one SanityHarness task and confirm `out_of_workspace_read_attempts` drops or is explained.

Dependencies: None.

### Slice 3: Add A Hidden-Edge Self-Test Prompt/Runtime Nudge

Status: `[ ]` Not started

Goal: Encourage one focused hidden-edge test pass after visible tests pass, especially for concurrency and performance tasks.

Why here: All three failures passed or appeared to pass visible tests, then failed hidden edge cases. The failures were not syntax or basic API mistakes; they were contract edge cases.

This slice should implement:

- Add benchmark-profile guidance, not global always-on behavior, that says:
  - after visible tests pass, create 2-4 small ad hoc checks for the riskiest hidden edge cases;
  - for concurrency pools/groups, test failed-task scheduling and non-positive limits;
  - for recursive/dynamic algorithms, test long inputs and repeated wildcard/star patterns;
  - stop after a small bounded set so the agent does not drift into long exploratory loops.
- Keep the guidance general, not task-name specific.

Expected output:

- Benchmark prompt/profile change with tests or snapshots if available.
- No change to normal user-facing prompt unless benchmark mode is active.

Verification:

- `mise run test -- test/commands.test.ts` or nearest prompt/runtime tests.
- Rerun `go/errgroup-limit`, `rust/regex-lite`, and `typescript/promise-pool` as targeted SanityHarness tasks.

Dependencies: Slice 1 helps because the extra checks need reliable validators.

### Slice 4: Improve OpenRouter Cost And Generation Observability

Status: `[-]` In progress

Goal: Preserve OpenRouter generation IDs and cost data in benchmark artifacts so later analysis can compare quality, duration, and spend.

Why here: We could not recover exact cost for the completed Gemini run because generation IDs were not persisted. A partial code change now adds `providerResponseId` to model results and logs.

Completed so far:

- Added `providerResponseId?: string` to `ModelTextResult`.
- Extracted response ids from OpenAI-compatible response shapes.
- Logged `providerResponseId` on `model_response`.
- Added focused test coverage in `test/model.test.ts`.
- Verified:
  - `mise run test -- test/model.test.ts`
  - `mise run typecheck`

This slice should finish:

- Build/reinstall or point benchmark wrappers at the patched Topchester build.
- Confirm `agent.log` includes `"providerResponseId"` for OpenRouter calls.
- Add a helper script or documented command to query `/api/v1/generation?id=...` and sum costs across a run.

Expected output:

- Generation IDs visible in SanityHarness artifacts.
- A repeatable cost extraction command.

Verification:

- Single-task SanityHarness run with `TOPCHESTER_LOG_LEVEL=debug`.
- `rg '"providerResponseId"' eval-results/<run>/**/agent.log`
- Query one returned id with OpenRouter generation endpoint.

Dependencies: Current source patch should be built or installed for benchmark use.

### Slice 5: Compare Agent Loop Shape Against Pi

Status: `[ ]` Not started

Goal: Identify useful Pi behaviors that Topchester can adopt without losing Topchester's stronger logging and KB-first shape.

Why here: Pi and Topchester tied on pass rate, but Pi had fewer self-test commands, no out-of-workspace telemetry, and much shorter validation time in this run. Some of that may be run variance or Docker caching, but the difference is worth inspecting.

This slice should implement:

- Compare successful task logs for the same task across both runs.
- Look for:
  - number of tool calls before first edit;
  - whether Pi reads fewer files;
  - whether Pi runs one broad validator instead of multiple failed validator attempts;
  - whether Topchester's benchmark profile adds unnecessary setup/status work.
- Keep only generalizable changes.

Expected output:

- Short findings section added to this plan.
- One or two small runtime/prompt changes if the comparison shows clear wins.

Verification:

- Rerun a representative passing task such as `rust/circular-buffer` and a failing task such as `typescript/promise-pool`.

Dependencies: Slices 1 and 2 make this comparison cleaner.

## Final Verification

After slices 1-4, rerun:

```sh
cd ~/data/prod_projects/SanityHarness
TOPCHESTER_CONFIG=~/data/prod_projects/topchester-agent/bench/mini-bench/config/openrouter-gpt-5.4-mini.jsonc \
./sanity eval --agent topchester \
  --model openrouter/openai/gpt-5.4 \
  --tier core \
  --timeout 600 \
  --no-sandbox --keep-workspaces
```

Compare against:

- `eval-results/2026-07-01T003556-topchester`
- `eval-results/2026-07-01T011143-pi-fixed`

Success is not only pass rate. Track:

- pass rate and weighted pass rate;
- task-level regressions;
- agent duration;
- validation duration;
- self-test command count;
- out-of-workspace-read count;
- OpenRouter generation IDs and cost.

## Open Questions

- Is Topchester's out-of-workspace-read telemetry a real issue or a harness false positive from reading global config/auth?
- Should benchmark mode prefer one broad validator command over several narrow attempts?
- Should TypeScript task workspaces include enough local tooling for `npx tsx --test`, or should Topchester learn the exact `node --test` form for these fixtures?
- Should Topchester aggregate per-turn cost in session events, or is debug-log `providerResponseId` enough?
