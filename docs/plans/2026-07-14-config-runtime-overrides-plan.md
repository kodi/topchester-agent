# Config Sources And Runtime Overrides

## Summary

Make every Topchester feature behave consistently regardless of whether its effective model and provider configuration came from workspace config, user config, `TOPCHESTER_CONFIG`, or `--config`.

The target state separates immutable configuration input from mutable runtime selection:

- JSONC files define startup defaults, providers, policy, hooks, MCP servers, and model choices.
- Topchester resolves those files through a retained load specification.
- `/model` and `/effort` change session runtime overrides without editing JSONC.
- Session restore and fork restore the runtime overrides that were active in that session.
- Commands that intentionally persist configuration continue to name a deterministic destination instead of guessing which merged source owns a value.
- `TOPCHESTER_CONFIG` and `--config` select one optional profile slot rather than stacking two independent late override layers.

This plan exists because the current loader and writers have incompatible assumptions. The loader merges up to four files, while TUI model and reasoning commands mutate only the global user file. A reload can also drop the original CLI config path. Fixing one command at a time would preserve the underlying ambiguity.

Implementation completed on 2026-07-14. Slice results and verification evidence are recorded below.

## Decisions

- Treat every loaded config file as immutable during a running TUI session.
- Keep `--config <path>` as a supported explicit profile selector.
- Treat `TOPCHESTER_CONFIG` as the environment form of the same selected-profile slot. If both are present, `--config` selects the profile and the environment path is not also merged.
- Preserve the existing workspace and user config layers. The selected profile remains later and therefore higher precedence than both.
- Do not infer a writable owner from the merged effective config. Object fields and concatenated arrays can have multiple source owners, and selected files may be shared or read-only.
- Make `/model`, `/models`, `/effort`, and `/reasoning` session-scoped runtime controls.
- Make `/effort clear` and `/reasoning clear` remove only the session override so the loaded provider default becomes visible again.
- Persist runtime overrides in project-local session events so `--resume`, `/restore`, and `/fork` can recover the same runtime selection.
- Do not add a general-purpose `topchester config set` command in this migration. Durable model and effort defaults remain explicit JSONC edits until a separate command UX is justified.
- Keep provider/auth provisioning separate from runtime selection. `/connect openrouter` and Codex auth may update global provider availability and choices, but they should not rely on a global default-model write to switch the active TUI model.
- Keep persistent bash approval targeted at workspace `topchester.jsonc`.
- Keep `topchester mcp add` targeted at `--config` when supplied and global user config otherwise; it is already an explicit durable CLI mutation.
- Keep normal `topchester run`, KB model resolution, `topchester info`, and non-interactive commands driven by loaded config only unless a future CLI option explicitly supplies a runtime override.
- Avoid a fifth config file for mutable preferences. A global override file would leak choices across unrelated profiles and recreate precedence problems.

## Scope

Included:

- A retained config load/profile specification in `AppContext`.
- A small runtime override model for active model selection and per-provider reasoning effort.
- One rebuild path that derives effective config and `ModelGateway` from immutable loaded config plus runtime overrides.
- TUI `/model`, `/models`, `/effort`, and `/reasoning` migration away from global config writes.
- `/connect openrouter` adjustment so setup and active selection remain separate.
- Session event persistence and rehydration for runtime overrides.
- `--resume`, `/restore`, `/fork`, and `/new` behavior for runtime overrides.
- Simplified `TOPCHESTER_CONFIG` and `--config` profile-selection semantics.
- Config, TUI, session, CLI integration, request-shape, and documentation coverage.
- Removal or narrowing of obsolete global default-model and reasoning-effort mutation helpers after callers migrate.

Out of scope:

- Changing the JSONC schema for normal config files.
- Splitting project policy and model/provider profiles into different schemas.
- Reordering workspace config and global user config.
- Adding includes/imports inside JSONC.
- Adding profile names or a profile registry.
- Automatically writing back to a config source selected through environment or CLI.
- A generic path-based config editing command.
- Persisting arbitrary provider fields as runtime overrides.
- Persisting secrets, auth tokens, headers, API keys, MCP configuration, hooks, or bash policy in session events.
- Changing Codex OAuth storage or provider request adaptation.
- Changing VibeProxy reasoning syntax; this plan only ensures Topchester can override the resolved provider at runtime.

## Current State

### Config loading

`src/config/index.ts` currently loads and deep-merges these sources in order:

1. `<workspace>/topchester.jsonc`
2. `~/.config/topchester/config.jsonc`
3. `TOPCHESTER_CONFIG`
4. CLI `--config`

Later scalar and object values override earlier values. Selected policy arrays and hook arrays concatenate.

`ConfigLoadOptions` contains `workspaceRoot` and optional `configPath`, but `AppContext` retains only `workspaceRoot`, effective `config`, and the derived `modelGateway`.

### TUI mutations

- `setGlobalDefaultModel()` always edits `~/.config/topchester/config.jsonc`.
- `setGlobalReasoningEffort()` always edits the same global file and requires the active provider definition to exist in that file.
- `/model` calls `setGlobalDefaultModel()` even when a later `--config` model remains authoritative.
- `/effort` resolves the provider from effective config, then asks the global writer to mutate that provider. It fails when the provider exists only in workspace, environment, or CLI config.
- `/connect openrouter` writes provider setup and choices globally, then may write a global default model.

### Reload behavior

`TopchesterTuiShell.reloadModelConfig()` currently calls:

```ts
loadTopchesterConfig({ workspaceRoot: this.context.workspaceRoot });
```

It does not pass the `configPath` used to create the app context. After a successful `/model`, `/connect`, or `/effort` mutation, a TUI started with `--config` can silently rebuild without that selected config.

### Session behavior

Session events persist messages, tool calls, task plans, status, choices, hooks, and subagent lifecycle events. `rehydrateSession()` does not currently return model or reasoning selection.

`--resume`, `/restore`, and `/fork` already share session load/rehydration paths. Those paths are the correct place to recover runtime overrides instead of creating TUI-only state files.

### Durable writes that already have a clear destination

- Persistent bash approval writes workspace `topchester.jsonc` and updates in-memory policy.
- `topchester mcp add` writes CLI `--config` when present and global config otherwise.
- Codex auth writes the auth store, not normal config secrets.

These targeted operations should remain distinct from session model selection.

## Target Behavior

| User action                             | Target behavior                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Start without profile selector          | Load workspace, user, then no selected profile                                                                            |
| Start with `TOPCHESTER_CONFIG`          | Load workspace, user, then the environment-selected profile                                                               |
| Start with `--config`                   | Load workspace, user, then the CLI-selected profile                                                                       |
| Supply both environment and CLI profile | Use CLI profile; report environment profile as shadowed, not merged                                                       |
| `/model <choice>`                       | Select model for the current session and rebuild the gateway                                                              |
| `/effort high`                          | Override the resolved active provider for the current session                                                             |
| `/effort clear`                         | Remove the session override and reveal the configured effort/default                                                      |
| `/connect openrouter`                   | Provision global provider/choices, reload the same source stack, optionally select a starter model in the current session |
| `/new`                                  | Start with fresh runtime overrides derived from the current loaded config                                                 |
| `--resume`, `/restore`                  | Apply the selected session's latest runtime override snapshot before the next model call                                  |
| `/fork`                                 | Copy and retain the source session's runtime override history                                                             |
| Exit and start a fresh session          | Use JSONC defaults; do not inherit another session's transient choices                                                    |
| Edit JSONC while TUI is running         | No implicit watch/reload in this plan; an explicit rebuild path may be exposed later                                      |

## Recommended Architecture

Add one config runtime/controller boundary instead of letting the TUI load files and replace gateway fields directly.

Suggested shape:

```ts
export interface ConfigLoadSpec {
  workspaceRoot: string;
  selectedProfile?: {
    source: "env" | "cli";
    path: string;
  };
}

export interface RuntimeConfigOverrides {
  activeModel?: ModelChoiceConfig;
  reasoningEffortByProvider: Record<string, ReasoningEffort>;
}

export interface ConfigRuntime {
  readonly loadSpec: ConfigLoadSpec;
  readonly baseConfig: TopchesterConfig;
  readonly overrides: RuntimeConfigOverrides;
  readonly effectiveConfig: TopchesterConfig;
  readonly modelGateway: ModelGateway;
}
```

The concrete implementation can be a class or pure functions owned by `AppContext`. The important contract is one rebuild operation:

```text
retain load spec
  -> load immutable base config from the same sources
  -> apply validated runtime overrides
  -> derive effective config
  -> create ModelGateway from effective config
  -> replace context config/gateway together
```

Do not expose half-updated state where `context.config` and `context.modelGateway` describe different selections.

### Base config versus effective config

- `baseConfig` is the normalized merge of loaded JSONC.
- `overrides` contains only session-selectable values.
- `effectiveConfig` is a derived value consumed by status, model choice resolution, KB fallback resolution where appropriate, and `ModelGateway` construction.
- `effectiveConfig` must not be serialized back to JSONC. Normalization and known-provider defaults can synthesize fields that did not originate in one file.

### Runtime override application

Apply overrides after normal config normalization:

1. Clone the normalized base config rather than mutating it.
2. If `activeModel` exists, replace only the active/default model assignment used by the TUI agent and fallback behavior already attached to `default`.
3. For each `reasoningEffortByProvider` entry, require a provider with that id in effective provider definitions, clone that provider, and apply `reasoningEffort`.
4. Reparse or validate the derived effective config before gateway construction.
5. Reject an override whose provider or model provider no longer exists after a base reload, leaving the previous working runtime intact and showing an actionable error.

Do not encode “clear” as a Zod config value. Clearing deletes the key from `RuntimeConfigOverrides`, allowing the base config value to flow through.

### Provider identity

Use the resolved provider id as the runtime effort key for V0. Do not use only a base URL, because model assignments and request option routing already use provider ids.

Session overrides are isolated per session, so the same provider id in two CLI profiles does not leak effort between them. On resume, validate the stored provider id against the currently loaded profile before applying it.

## Config Source Contract

Keep three conceptual layers:

```text
workspace config
  + user config
  + one selected profile (--config OR TOPCHESTER_CONFIG)
  + session runtime overrides
```

Resolution rules:

- Resolve relative CLI `--config` paths using the invocation working directory, preserving current behavior.
- Resolve `TOPCHESTER_CONFIG` consistently with the current loader contract; document whether relative environment paths are workspace-relative before changing it.
- If `--config` is present, do not parse or merge `TOPCHESTER_CONFIG`.
- `topchester info` should display both selectors when both were supplied, marking the environment selector as shadowed by CLI selection.
- A missing selected profile should keep the existing missing-source reporting/error contract unless tests prove current behavior differs between `info` and startup.
- Keep workspace/user/profile merge semantics unchanged within the remaining active layers.

This is a compatibility change for users who intentionally stack `TOPCHESTER_CONFIG` and `--config`. Document it in the changelog and config reference. The repo is still pre-1.0, so prefer a direct, explicit contract over a long-lived dual mode.

## Runtime And Session Data Flow

### New session

```text
CLI parses workspace and selected profile
  -> create ConfigRuntime with empty overrides
  -> create session
  -> render configured model/effort
  -> slash command changes overrides
  -> append runtime_config event
  -> rebuild effective config and gateway
```

### Resume

```text
CLI parses the current workspace/profile
  -> load session events
  -> rehydrate messages, task plan, status, runtime overrides
  -> create or update ConfigRuntime with rehydrated overrides
  -> validate overrides against currently loaded providers/choices
  -> construct TUI/runtime with one consistent effective config
```

Apply rehydrated overrides before running the first model request and before rendering the model label. Session-start hooks that depend on the model should also see the effective runtime selection.

### Restore

When `/restore` switches sessions:

1. Load and rehydrate the selected session.
2. Replace current runtime overrides with the selected session snapshot.
3. Rebuild effective config and gateway.
4. Replace transcript/task plan/status.
5. Update the model label.
6. Append the existing restore notice only after the switch succeeds.

If stored overrides are invalid for the currently selected profile, keep the selected session but fall back to base config and show one warning. Do not make an old session impossible to open because a provider was removed.

### Fork

`forkSession()` copies source events, so a runtime config snapshot should naturally be present in the fork. Verify that the fork rehydrates the latest snapshot and that later changes append only to the fork.

### New session

`/new` should reset overrides to an empty snapshot and rebuild from the retained base/load specification. It must not retain the previous session's model or effort through a shared mutable context object.

## Session Event Contract

Add one internal event that stores the complete runtime override snapshot after a successful runtime change:

```ts
const runtimeConfigPayloadSchema = z.object({
  kind: z.literal("runtime_config"),
  activeModel: modelChoiceAssignmentSchema.optional(),
  reasoningEffortByProvider: z.record(z.string().min(1), reasoningEffortSchema),
});
```

Recommended rules:

- Append a full snapshot, not a patch. Rehydration then takes the last valid `runtime_config` event.
- Keep the event internal: it should not render in the transcript or enter model context.
- Do not include provider URLs, headers, API keys, auth records, or normalized provider objects.
- Append only after override validation and gateway rebuild succeed.
- If session persistence fails after the runtime switch, keep the runtime switch active and show the existing persistence warning pattern. Record the exact ordering chosen during implementation.
- Old sessions without this event rehydrate with empty overrides.
- Preserve session event version compatibility if adding a union member does not require an envelope version bump. Only bump the version if the existing reader cannot remain backward compatible.

`RehydratedSession` should gain `runtimeConfigOverrides`, allowing CLI resume and TUI restore/fork paths to share one contract.

## Durable Mutation Policy

| Operation                              | Destination policy                                             |
| -------------------------------------- | -------------------------------------------------------------- |
| `/model`, `/models`                    | Session runtime only                                           |
| `/effort`, `/reasoning`                | Session runtime only                                           |
| `/connect openrouter`                  | Global provider and choices; current selection is runtime only |
| `topchester auth login codex --device` | Global auth store and non-secret global provider/choices       |
| Persistent bash approval               | Workspace `topchester.jsonc`                                   |
| `topchester mcp add`                   | CLI `--config` when present, otherwise global user config      |
| Manual durable model/effort default    | Edit the intended JSONC file                                   |

Rename writer helpers to describe their durable destination and restrict their call sites. For example, global provider provisioning can remain explicitly global, while `setGlobalDefaultModel()` and `setGlobalReasoningEffort()` should have no TUI callers and can be removed if no other supported command needs them.

## Behavior To Preserve

- Normal startup without environment or CLI profile uses existing workspace + user behavior.
- Explicit provider-qualified model choices continue to resolve the same provider and model name.
- Model gateway request mapping remains unchanged:
  - Codex provider uses Responses-native reasoning metadata.
  - OpenRouter uses nested `reasoning.effort`.
  - Generic OpenAI-compatible providers use `reasoning_effort` best-effort pass-through.
- Provider config and auth secrets never enter session events.
- `ignore.paths`, bash policy arrays, and hook arrays keep their current merge behavior across active sources.
- MCP and hook initialization use the effective loaded config.
- Knowledge model fallbacks keep their current relationship to the default model unless a focused test proves runtime active-model selection should not affect KB fallback.
- Agent profiles keep their current purpose routing: changing the default model updates the same primary/fallback slots as today's normalized `models.default`, while an explicitly configured `agent.fast` remains separate.
- A runtime effort override remains provider-level. Other agent, fast, or KB model purposes using the same provider id observe that effort, matching the current provider config contract.
- Existing sessions remain readable.
- Existing JSONC files remain valid.
- Existing config parse errors retain the source path and useful Zod issue location.

## Edge Cases

- Active provider exists only in CLI profile.
- Active provider exists only in `TOPCHESTER_CONFIG` profile.
- Active model is defined in user config while provider details are completed by selected profile.
- Same provider id exists in user and selected profile with merged fields.
- Both `TOPCHESTER_CONFIG` and `--config` are supplied.
- Selected profile disappears or becomes invalid during an explicit reload.
- `/effort` is called for a model without a resolved provider.
- `/effort clear` reveals a non-empty reasoning effort configured in JSONC.
- `/model` selects a choice whose provider is missing.
- `/model all` adds choices globally while a selected profile supplies its own `models.choices` array and therefore shadows the new global list.
- `/connect openrouter` runs while selected profile defines a different active model.
- Runtime gateway rebuild fails after a valid-looking override.
- Session event append fails after a successful runtime change.
- Resume uses a different selected profile from the one used when the session was created.
- Restored session names a model choice no longer present but its provider still exists.
- Restored session names a removed provider.
- `/new` follows a session with non-empty overrides.
- Fork copies runtime config history, then changes effort independently.
- A primary-model override must not replace an explicitly configured `agent.fast`; subagents using `agent.primary` should observe the override, while fast-profile subagents keep `agent.fast`.
- A provider effort override affects every model purpose using that provider id, not only the command-time active model.
- Non-interactive stdout rendering uses the runtime override supplied through resume before exiting.
- Provider id is `openai` with a local VibeProxy base URL and exists only in CLI profile.
- Configured model id already encodes effort, such as `gpt-5.5(low)`, while a runtime provider effort is also selected. Topchester should display both sources clearly or document proxy-specific precedence rather than silently claiming which one wins.

## Files To Add

Likely additions:

- `src/config/runtime.ts`: runtime override schema/types, immutable application, validation, and effective-config rebuild helpers.
- `test/config-runtime.test.ts`: focused unit coverage for override application and atomic rebuild behavior.

The implementation may keep this logic in `src/app/context.ts` if it remains small, but it should not return to `src/tui/shell.ts` as ad hoc config mutation.

## Files To Change

Expected changes:

- `src/config/index.ts`
  - formalize selected-profile resolution
  - stop stacking environment and CLI profiles
  - export only schema/types needed by runtime override validation
  - remove or narrow obsolete global selection writers
- `src/app/context.ts`
  - retain load specification and base config
  - expose atomic reload/apply/reset runtime operations
  - rebuild config and gateway together
- `src/cli.ts`
  - create context from the resolved selected-profile contract
  - apply rehydrated overrides during `--resume`
- `src/cli/info.ts`
  - report the selected profile and shadowed environment selector
  - distinguish loaded defaults from session runtime state only where a session-aware info surface exists
- `src/tui/shell.ts`
  - migrate model/effort commands to runtime operations
  - keep selected profile during reload
  - separate OpenRouter provisioning from current-session selection
  - apply/reset overrides during restore/new/fork
- `src/tui/status.ts`
  - render active model/effort from effective config
  - optionally label session overrides when useful
- `src/session/events.ts`
  - add the internal `runtime_config` payload
- `src/session/store.ts`
  - rehydrate the latest runtime config snapshot
- `src/tui/session-persistence.ts`
  - add a helper only if runtime config persistence fits the existing warning path
- `test/config.test.ts`
  - update source precedence/profile-selector coverage
  - keep durable provisioning coverage
- `test/session.test.ts`
  - add backward-compatible runtime config rehydration tests
- `test/tui.render.test.ts`
  - cover model/effort runtime changes, new/restore/fork behavior, labels, and persistence warnings
- `test/model.test.ts`
  - verify runtime reasoning override request shapes for generic and OpenRouter providers
- `test/codex-provider.test.ts`
  - verify runtime Codex effort still reaches Responses metadata
- `test/cli.integration.test.ts`
  - cover selected-profile resolution, info output, resume, and non-interactive startup
- `docs/config.md`
- `docs/configuration/config-files.md`
- `docs/configuration/models-and-providers.md`
- `docs/reference/config-schema.md`
- `docs/reference/model-config.md`
- `docs/reference/cli.md`
- `docs/tui.md`
- `docs/features/sessions.md`
- `docs/reference/changelog.md`

## Cross-Slice Rules

- Keep loaded config immutable. Never write `effectiveConfig` back to disk.
- Preserve the selected profile path in every reload/rebuild path.
- Update config and model gateway atomically.
- Keep runtime override logic outside the TUI rendering layer.
- Store only model references and effort enum values in sessions; never store provider definitions or credentials.
- Keep old session events and existing JSONC readable.
- Keep durable writes explicit about destination.
- Do not add source-provenance tracking merely to choose a write target.
- Do not change provider request shapes while moving where effort is selected.
- Do not let `/connect` silently replace a model explicitly selected by the active profile; use a current-session selection only when setup needs a starter model.
- Add black-box coverage for providers defined only in `--config`, because that is the regression that exposed this design flaw.
- Update this plan after every slice with findings, actual files changed, and exact verification commands that passed.

## Slices

### Slice 1: Retained Load Specification And Regression Contract

Status: `[x]` Done

Goal: Preserve the exact config source selection for the lifetime of `AppContext` and encode the current `--config` failures as tests.

Why here: Runtime overrides cannot be reliable if a rebuild silently changes its input sources. This is a small correctness foundation that can land without changing `/model` or `/effort` persistence yet.

This slice should implement:

- Add a retained load specification or equivalent immutable context field containing workspace root and resolved profile inputs.
- Route initial load and every explicit reload through the same helper.
- Replace `TopchesterTuiShell.reloadModelConfig()` with a context-owned rebuild that preserves current inputs.
- Add regression tests proving a CLI-only provider remains configured after rebuild.
- Add a regression test demonstrating that the same provider id need not exist in global config to remain part of the effective runtime.
- Keep current source stacking semantics temporarily in this slice; selected-profile simplification lands after runtime commands no longer depend on disk mutation.

Expected output:

- `AppContext` owns enough immutable load information to reproduce its base config.
- TUI code no longer calls `loadTopchesterConfig()` with an incomplete options object.
- Focused tests fail if `--config` is dropped during rebuild.

Verification:

```sh
vp test run test/config.test.ts test/tui.render.test.ts
mise run typecheck
```

Dependencies: none.

### Slice 2: Runtime Override Foundation

Status: `[x]` Done

Goal: Add a tested, UI-independent runtime override layer and one atomic context rebuild operation.

Why here: Model and effort commands should migrate onto a stable contract rather than each inventing an in-memory patch.

This slice should implement:

- Define `RuntimeConfigOverrides` with optional active model and per-provider effort.
- Add pure override application and validation helpers.
- Preserve immutable `baseConfig` separately from derived `effectiveConfig`.
- Add context operations to apply a complete override snapshot, update one selection, clear overrides, and reload base config.
- Rebuild `ModelGateway` only after the derived config validates.
- Leave previous effective config/gateway active if rebuild fails.
- Make status/model label consumers continue reading the effective config through `context.config` or a clearly renamed equivalent.

Expected output:

- Runtime config can be changed without touching JSONC.
- Provider-only-in-CLI effort overrides validate and reach a rebuilt gateway.
- Atomicity and clear/fallback behavior have focused unit tests.

Verification:

```sh
vp test run test/config-runtime.test.ts test/config.test.ts test/model.test.ts test/codex-provider.test.ts
mise run typecheck
```

Dependencies: Slice 1.

### Slice 3: Migrate TUI Model Selection And Provider Setup

Status: `[x]` Done

Goal: Make `/model` and `/models` session-scoped and separate `/connect openrouter` provisioning from active model selection.

Why here: Model selection is the broadest current global mutation and exercises provider choices, gateway rebuild, status rendering, and connect setup before session persistence is added.

This slice should implement:

- Change direct and picker-based model selection to update runtime overrides.
- Stop calling `setGlobalDefaultModel()` from TUI model selection.
- Keep global model choices as discovery/setup data where currently required.
- After `/connect openrouter`, reload the retained base source stack and select a starter model only as a runtime override when no usable active model exists.
- Ensure a selected CLI profile remains active after connect and model changes.
- Update TUI success text so it says the model changed for the current session and no longer claims a JSONC path was edited.
- Decide and test how `/model all` behaves when selected-profile `models.choices` shadows global choices; do not hide the limitation.

Expected output:

- `/model` works with choices/providers from any loaded source.
- No TUI model-selection path writes a default model to global config.
- Connect remains durable provider provisioning without becoming a hidden profile switch.

Verification:

```sh
vp test run test/config-runtime.test.ts test/config.test.ts test/tui.render.test.ts test/commands.test.ts
mise run typecheck
```

Dependencies: Slice 2.

### Slice 4: Migrate Reasoning Effort Commands

Status: `[x]` Done

Goal: Make `/effort` and `/reasoning` operate on the resolved active provider regardless of config source.

Why here: The runtime override and model-selection paths must be stable before effort follows the model as it changes.

This slice should implement:

- Replace `setGlobalReasoningEffort()` calls with runtime override updates.
- Resolve the provider from the current effective active model.
- Make `clear`/`default` remove the session override and reveal configured provider effort.
- Update status/model label immediately after atomic rebuild.
- Update feedback text to distinguish session override from configured default.
- Add black-box coverage for an `openai` provider defined only in CLI config with a VibeProxy-like local URL.
- Verify request bodies remain correct for Codex, OpenRouter, and generic OpenAI-compatible providers.
- Verify provider-level effort reaches primary, fast, and KB requests that share the provider, without changing their model assignments.
- Remove `setGlobalReasoningEffort()` if no supported durable caller remains.

Expected output:

- The originally reported `No provider configured for model provider "openai"` path is eliminated for a valid effective provider.
- `/effort` never edits global config.
- Clearing returns to config-defined effort without restarting.

Verification:

```sh
vp test run test/config-runtime.test.ts test/tui.render.test.ts test/model.test.ts test/codex-provider.test.ts
mise run typecheck
```

Dependencies: Slices 2 and 3.

### Slice 5: Session Persistence, Resume, Restore, Fork, And New

Status: `[x]` Done

Goal: Persist and recover runtime override snapshots through every session lifecycle path.

Why here: Interactive behavior should be correct before adding a durable session event contract. This slice then makes session-scoped semantics complete rather than process-scoped.

This slice should implement:

- Add backward-compatible `runtime_config` session events.
- Rehydrate the latest snapshot into `RehydratedSession`.
- Apply rehydrated overrides before initial model-label rendering and model requests in `--resume`.
- Apply selected session overrides during `/restore`.
- Verify forks inherit source runtime state through copied events and then diverge independently.
- Make `/new` reset to empty runtime overrides and current base config.
- Ignore runtime config events in transcript/model-context reconstruction.
- Add fallback/warning behavior for missing model/provider references under a different current profile.

Expected output:

- Session model and effort survive exit/resume.
- Restore and fork use the selected session's runtime, not the previously active session's mutable context.
- Old sessions continue loading with empty overrides.

Verification:

```sh
vp test run test/session.test.ts test/tui.render.test.ts test/cli.integration.test.ts
mise run typecheck
```

Dependencies: Slices 3 and 4.

### Slice 6: One Selected Profile Slot

Status: `[x]` Done

Goal: Simplify late config selection so environment and CLI selectors cannot stack into two hidden profile layers.

Why here: Changing source precedence before runtime commands stop writing/reloading config would make existing failures harder to distinguish. With runtime selection complete, profile simplification is isolated to loader and reporting behavior.

This slice should implement:

- Introduce explicit selected-profile resolution.
- Use CLI `--config` when present; otherwise use `TOPCHESTER_CONFIG`; otherwise use no selected profile.
- Do not parse the environment-selected profile when CLI selection is present.
- Update config source metadata so `topchester info` reports active and shadowed selectors clearly.
- Update precedence tests, including policy arrays and hooks, for workspace + user + one profile.
- Add a changelog note for the pre-1.0 compatibility change.
- Remove wording that describes environment and CLI as two separately merged layers.

Expected output:

- Users can predict the active profile from one rule.
- `--config` remains authoritative without accumulating another environment override below it.
- Info/debug output makes selection visible.

Verification:

```sh
vp test run test/config.test.ts test/cli.integration.test.ts
mise run typecheck
```

Dependencies: Slices 1 through 5.

### Slice 7: Cleanup, Documentation, And Final Verification

Status: `[x]` Done

Goal: Remove obsolete mutation paths, document the new mental model, and run the full repository gate.

Why here: Cleanup should happen after parity and lifecycle behavior are proven so temporary compatibility helpers do not disappear too early.

This slice should implement:

- Remove unused global default-model/reasoning-effort writers and stale tests.
- Rename remaining durable writers so their destination is obvious.
- Document immutable config inputs, selected profiles, session runtime controls, clear/default semantics, and resume behavior.
- Document that durable model/effort defaults require editing the intended JSONC file.
- Document `/connect`, persistent bash approval, and MCP destination policies separately from runtime selection.
- Update examples using `--config`, including local OpenAI/VibeProxy configuration.
- Add or update changelog entries.
- Search for stale claims that `/model` or `/effort` always edits global config.
- Update this plan with actual completed slices, findings, and verification results.

Expected output:

- One documented config mental model matches code and tests.
- No TUI selection feature guesses a writable config owner.
- No obsolete reload path can discard `--config`.

Verification:

```sh
rg -n "setGlobalDefaultModel|setGlobalReasoningEffort|reloadModelConfig|sets? .*global.*config|TOPCHESTER_CONFIG.*--config" src test docs
mise run format-check
mise run local-ci
```

Manual TUI checks:

1. Start with a provider that exists only in `--config`.
2. Run `/effort high`, send a request, and confirm the status label and request behavior use high effort.
3. Run `/effort clear` and confirm the configured/provider default returns.
4. Select another model, exit, and resume the session; confirm model and effort restore.
5. Start a new session and confirm it uses JSONC defaults rather than the previous session's overrides.
6. Run `/connect openrouter` while a CLI profile is active and confirm the profile remains selected.
7. Set both `TOPCHESTER_CONFIG` and `--config`; confirm info reports CLI active and environment shadowed.

Dependencies: Slices 1 through 6.

## Final Verification

Focused confidence pass:

```sh
vp test run test/config-runtime.test.ts test/config.test.ts test/session.test.ts test/tui.render.test.ts test/commands.test.ts test/model.test.ts test/codex-provider.test.ts test/cli.integration.test.ts
```

Repository gate:

```sh
mise run local-ci
```

Final stale-contract search:

```sh
rg -n "setGlobalDefaultModel|setGlobalReasoningEffort|reloadModelConfig|four.*config|loads? config in this order|global user config" src test docs README.md
```

Record exact passed commands and dates in this plan. If live VibeProxy verification is unavailable, record request-shape unit coverage separately from proxy acceptance instead of claiming live compatibility.

## Resolved Questions

1. Runtime active-model selection replaces `agent.primary` and `fallback` while preserving explicit `agent.fast` and `kb.summarize` assignments.
2. `topchester info` remains config-only in V0 because it has no session id; session state stays in the TUI and session log.
3. A resumed model remains usable when it is absent from `models.choices` as long as its provider still exists; choices are picker inventory, not an execution allowlist.
4. Resume drops only invalid model/effort entries, retains valid entries, and shows warnings.
5. CLI resume applies overrides before shell construction and session-start hooks so runtime consumers see one effective configuration.
6. `/model all` provisions OpenRouter, adds the selection to the global catalog, and selects it for the session. A selected-profile choices array may continue to shadow the global catalog.
7. The status label shows the effective Topchester provider effort while leaving any proxy-specific effort suffix visible in the model name; proxy precedence remains external.

## Working Notes

- 2026-07-14: The reported VibeProxy failure was traced to `setGlobalReasoningEffort()` resolving provider `openai` from effective config and then requiring `providers.openai` in global user config.
- 2026-07-14: `TopchesterTuiShell.reloadModelConfig()` was confirmed to drop CLI `configPath`, so a successful TUI config mutation can rebuild from a different source stack.
- 2026-07-14: `/model` has the same precedence problem as `/effort`: it writes the global default even when a later selected config remains authoritative.
- 2026-07-14: Session events currently have no runtime config payload; `rehydrateSession()` is the shared extension point for resume/restore/fork behavior.
- 2026-07-14: Persistent bash approval and `topchester mcp add` already have explicit destination policies and should not be generalized into provenance-based writes.
- 2026-07-14: Slice 1 completed with retained `ConfigLoadSpec` state in `AppContext`, context-owned base reloads, and CLI-profile retention coverage in `test/config-runtime.test.ts`.
- 2026-07-14: Slice 2 completed with `src/config/runtime.ts`, immutable base/effective config separation, atomic gateway replacement, invalid-snapshot filtering, and primary/fallback versus fast/KB coverage.
- 2026-07-14: Slices 3 and 4 completed by moving `/model`, `/models`, `/effort`, and `/reasoning` to session runtime overrides. `/connect openrouter` keeps durable provider/choice provisioning but retains the selected profile and does not replace its active model. Obsolete global default-model and effort writers were removed.
- 2026-07-14: Slice 5 completed with backward-compatible `runtime_config` snapshot events, shared rehydration, resume-before-render behavior, restore/fork switching, `/new` reset behavior, invalid-provider warnings, and transcript exclusion.
- 2026-07-14: Slice 6 completed with one selected profile slot. CLI `--config` shadows `TOPCHESTER_CONFIG`; `topchester info` reports active and shadowed selectors, and a shadowed invalid environment file is not parsed.
- 2026-07-14: Slice 7 completed across config, model, TUI, CLI, session, schema, quickstart, and changelog documentation. Durable bash approval and MCP destination policies remain unchanged and explicit.
- 2026-07-14: Focused and lifecycle coverage passed as part of the full suite: `vp test run --dir test` (33 files, 731 tests). Socket-backed model and web-fetch tests required the normal host test environment because the workspace sandbox rejects localhost listeners.
- 2026-07-14: Final repository gate passed: `mise run local-ci` (376 files formatted; 175 files with no warnings, lint errors, or type errors). The objective's spelling `mise rul local-ci` was also checked and is not a valid mise command (`no task rul found`); `mise run local-ci` is the repository task command.
- 2026-07-14: Live VibeProxy acceptance was not available. Runtime tests cover a CLI-only `openai` provider at `http://127.0.0.1:8317/v1`, provider-wide effort resolution for primary/fast/KB purposes, and existing request-shape tests cover generic `reasoning_effort`, OpenRouter nested reasoning, and Codex Responses metadata.
- 2026-07-14: Runtime changes rebuild config and gateway first, then append the full session snapshot. If the append fails, the runtime selection remains active and the TUI shows `Session save failed`; focused coverage verifies this ordering.
