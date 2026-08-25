# Model Reference Resolution

## Summary

Make one fully qualified model reference work consistently across interactive startup, one-shot runs, JSONC, and the TUI. The first supported zero-config path is:

```sh
OPENROUTER_API_KEY=... topchester -m openrouter/google/gemini-3.1-flash-lite
```

The invocation must resolve the built-in OpenRouter route in memory, use `OPENROUTER_API_KEY`, avoid writing config, and preserve the selected route in the new session.

## Decisions

- The canonical ref is `<provider>/<provider-native-model-id>` and parsing splits on the first `/` only.
- A fully qualified ref means the same thing in `-m`/`--model`, `topchester run`, `/model`, and JSONC.
- Known built-in providers can be materialized in memory without `/connect` or a provider config block.
- This iteration ships known-provider inference for the providers Topchester already owns: `openrouter` and `codex`.
- CLI and slash-command model selection are session/runtime overrides and do not edit JSONC.
- Existing config files, saved model choices, `/connect`, `/model all`, session restore, and reasoning overrides remain compatible.
- Explicit `-m` wins over a restored session model.

## Scope

Included:

- one shared model-ref resolver at the config/runtime boundary
- in-memory known-provider defaults for explicit refs and restored runtime overrides
- root `-m, --model` for the interactive TUI
- the same `-m, --model` behavior for `topchester run`
- direct `/model <provider/model>` selection without a saved choice
- runtime/session persistence for CLI-selected models
- focused tests and public CLI/model/TUI docs

Out of scope:

- last-used model persistence
- `topchester models set/list/status`
- changing global config precedence
- new native provider adapters
- aliases, fallback chains, or model variants
- removing `models.choices` or changing `/connect` credential storage

## Current State

- The interactive root command has no model flag.
- `topchester run --model` replaces only the raw model id and retains an already configured provider.
- A fresh empty config therefore cannot use `--model openrouter/...`, and a configured OpenRouter route can receive the incorrect full ref as its model id.
- `/model <ref>` only selects exact saved choices; otherwise it opens a filtered picker.
- Runtime overrides require the provider to exist in loaded JSONC, so a session cannot currently retain a zero-config built-in provider selection.

## Cross-Slice Rules

- Keep model refs provider-qualified at user-facing boundaries; retain bare model ids only for backward compatibility with an already unambiguous configured provider.
- Never persist environment credential values or write config as a side effect of resolution.
- Keep explicit custom providers config-backed.
- Use temporary homes/workspaces in fresh-install tests.
- Update public CLI and TUI docs in the same change as behavior.

## Slice 1: Shared Resolution And Runtime Provider Materialization

Status: `[x]` Done

Goal: Resolve a canonical ref into a provider, provider-native model id, and usable effective config without disk writes.

Why here: CLI and TUI entry points need one contract before their behavior changes.

This slice should implement:

- first-slash model-ref parsing
- known-provider lookup for OpenRouter and Codex
- runtime override application and restore support when a known provider is absent from JSONC
- focused config/runtime tests, including nested OpenRouter model ids and unknown providers

Expected output:

- shared config/runtime helpers used by later slices
- restored sessions can rematerialize known built-in providers

Verification:

```sh
mise run test -- test/config.test.ts test/config-runtime.test.ts
```

Passed 2026-08-25: 39 test files / 667 tests plus the production OpenTUI Bun renderer.

Dependencies: none.

## Slice 2: Unified CLI And TUI Entry Points

Status: `[x]` Done

Goal: Make the canonical ref usable from interactive startup, one-shot runs, and `/model`.

Why here: It depends on Slice 1's route contract.

This slice should implement:

- root `-m, --model`
- `topchester run -m, --model` through the shared resolver
- explicit CLI-over-resumed-session precedence
- direct `/model <provider/model>` selection without `models.choices`
- persistence of the selected model in newly created interactive and run sessions

Expected output:

- the fresh-install OpenRouter command resolves without config
- existing picker and `/connect` flows keep working

Verification:

```sh
mise run test -- test/cli.integration.test.ts test/tui-controller.test.ts test/session.test.ts
```

Passed 2026-08-25: 39 test files / 672 tests plus the production OpenTUI Bun renderer.

Dependencies: Slice 1.

## Slice 3: Documentation And Final Gate

Status: `[x]` Done

Goal: Document the new golden path and verify the complete repository.

This slice should implement:

- update the quickstart, model/provider config, CLI reference, TUI/slash-command docs, and troubleshooting guidance
- record exact focused and final verification

Expected output:

- public docs use the same canonical ref and clearly distinguish runtime selection from durable config
- final repository gate is clean

Verification:

```sh
mise run local-ci
mise run test
```

Dependencies: Slices 1 and 2.

## Working Notes

- 2026-08-25: The approved first iteration is deliberately narrower than last-used defaults and durable `models set` commands. Its acceptance boundary is explicit fully qualified refs working everywhere with built-in provider inference.
- 2026-08-25: Pi and OpenCode both expose root `--model` with provider-qualified refs. OpenClaw separately persists session selection and durable defaults. The current slice adopts only the common ref/override behavior.
- 2026-08-25: Known-provider runtime model and reasoning overrides now materialize provider defaults only in the effective config. Loaded `baseConfig` remains unchanged, so resolution causes no config write and restored sessions can rebuild the route.
- 2026-08-25: Slice 1 verification passed with `mise run test -- test/config.test.ts test/config-runtime.test.ts` (39 files / 667 tests plus the production OpenTUI Bun renderer).
- 2026-08-25: Root and run `-m/--model` now share `setRuntimeModelReference`; direct TUI refs bypass saved choices, while picker and `/connect` behavior remain intact. New and resumed sessions append the explicit runtime selection.
- 2026-08-25: Slice 2 verification passed with `mise run test -- test/cli.integration.test.ts test/tui-controller.test.ts test/config-runtime.test.ts test/session.test.ts` (39 files / 672 tests plus the production OpenTUI Bun renderer).
- 2026-08-25: Public onboarding, quickstart, configuration, CLI, TUI, session, slash-command, and troubleshooting docs now lead with the zero-config OpenRouter path and distinguish session overrides from durable JSONC.
- 2026-08-25: Final verification passed with `mise run local-ci`, then `mise run test` (39 files / 674 tests plus the production OpenTUI Bun renderer).

## Next Slice

None. The scoped model-reference iteration is complete. Last-used defaults,
durable `models` commands, aliases, variants, and fallback chains remain separate
follow-up work.
