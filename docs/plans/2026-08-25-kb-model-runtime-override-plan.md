# KB Model Runtime Overrides

## Summary

Make the knowledge-base summarization model as easy to choose temporarily as the
main chat model. The primary startup path is:

```sh
topchester -m openrouter/anthropic/claude-sonnet-4.5 \
  --kb-model openrouter/google/gemini-3.1-flash-lite
```

The KB choice must affect only `kb.summarize`, work without JSONC for built-in
providers, persist with the session, and never rewrite config.

## Decisions

- Add root and `run` `--kb-model <provider/model>` options.
- Add `/kb-model <provider/model>`, bare `/kb-model`, `/kb-model all [search]`,
  and `/kb-model clear`.
- Bare `/kb-model` reuses the saved model picker but targets `kb.summarize`.
- `topchester kb sync --model <provider/model>` is a command-local one-shot
  override and does not create session state.
- Generalize runtime model overrides by model purpose so `agent.fast` can gain
  the same surface later without another persistence refactor.
- Preserve existing `activeModel` session events on read. New runtime events use
  purpose-keyed model overrides while retaining compatibility with old sessions.
- An explicit CLI override wins over restored session state. Clearing the KB
  override returns to configured `kb.summarize`, then the existing `default`
  fallback.
- Do not add the KB model to the permanent status line. Selection messages and
  KB sync output should make the effective route clear where it matters.

## Scope

Included:

- purpose-keyed runtime model overrides and session persistence
- backward-compatible restore of `activeModel`
- root/run `--kb-model`
- `kb sync --model`
- `/kb-model` direct selection, picker, catalog, current-state, and clear flows
- focused tests and public docs

Out of scope:

- `--fast-model` and `/fast-model`
- durable config-writing model commands
- changing JSONC slot names or fallback rules
- permanent footer expansion
- custom-provider inference without JSONC

## Cross-Slice Rules

- Reuse the shared provider-qualified model resolver.
- Keep the existing main-model behavior and old sessions working.
- Never persist credentials or write JSONC as a side effect.
- Keep standalone `kb sync --model` ephemeral.
- Preserve unrelated worktree changes.
- Update CLI, TUI, session, and model configuration docs with behavior changes.

## Slice 1: Purpose-Keyed Runtime And Session Contract

Status: `[x]` Done

Goal: Represent runtime model selections by purpose and restore old and new
session events safely.

Why here: Every new flag and slash command depends on a runtime override that
changes only `kb.summarize`.

This slice should implement:

- purpose-keyed runtime model override schema and helpers
- compatibility mapping from legacy `activeModel` to `agent.primary`
- effective-config application for primary, fast, and KB purposes
- config-runtime and session rehydration coverage

Verification:

```sh
mise run test-node -- test/config-runtime.test.ts test/session.test.ts
```

Dependencies: none.

Passed 2026-08-25: `mise run test-node -- test/config-runtime.test.ts
test/session.test.ts` (2 files / 50 tests).

## Slice 2: CLI And TUI Selection Surfaces

Status: `[x]` Done

Goal: Add startup, one-shot, standalone KB sync, and interactive KB model
selection.

Why here: It depends on Slice 1's purpose-specific runtime contract.

This slice should implement:

- root and `run` `--kb-model`
- `kb sync --model`
- `/kb-model` direct, picker, catalog, current-state, and clear behavior
- explicit CLI-over-restored-session precedence
- focused CLI and controller tests

Verification:

```sh
mise run test-node -- test/cli.integration.test.ts test/tui-controller.test.ts
```

Dependencies: Slice 1.

Passed 2026-08-25: `mise run test-node -- test/config-runtime.test.ts
test/session.test.ts test/cli.integration.test.ts test/tui-controller.test.ts
test/commands.test.ts` (5 files / 207 tests).

## Slice 3: Documentation And Final Gate

Status: `[x]` Done

Goal: Document the temporary KB model workflow and verify the repository.

This slice should implement:

- update model/provider, CLI, slash-command, TUI, session, quickstart, and
  troubleshooting docs where relevant
- record exact verification results

Verification:

```sh
mise run local-ci
mise run test
```

Dependencies: Slices 1 and 2.

Passed 2026-08-25: `mise run local-ci`, then `mise run test` (39 test files /
684 tests plus the production OpenTUI Bun renderer).

## Working Notes

- 2026-08-25: OpenCode and Kilo expose a broader `small_model` config concept,
  but Topchester keeps the KB route explicit because it is a product-specific,
  high-volume semantic workload.
- 2026-08-25: The worktree already contains unrelated self-update edits. They
  must remain untouched and excluded from this feature's reasoning and handoff.
- 2026-08-25: Runtime overrides now use a purpose-keyed map. New session events
  write that map, while rehydration maps legacy `activeModel` events to
  `agent.primary`.
- 2026-08-25: Root/run `--kb-model`, standalone `kb sync --model`, direct and
  picker `/kb-model`, catalog selection, clear-to-fallback behavior, and
  explicit-over-restored precedence are covered by focused tests.
- 2026-08-25: Public quickstart, model/provider, KB, TUI, slash-command,
  session, CLI, onboarding, and troubleshooting docs now describe the temporary
  KB model path and its fallback and persistence rules.
- 2026-08-25: Final verification passed with `mise run local-ci`, then
  `mise run test` (39 files / 684 tests plus the production OpenTUI Bun
  renderer).

## Next Slice

None. The scoped KB model runtime override work is complete. `--fast-model` and
`/fast-model` remain a separate follow-up built on the purpose-keyed runtime
contract.
