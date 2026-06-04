# Codex Reasoning Effort Slash Commands

## Summary

Topchester's Codex provider is working through ChatGPT OAuth, but there is no way to set a reasoning effort level. The target outcome is:

- durable config for reasoning effort;
- `/effort` and `/reasoning` slash commands as aliases;
- Codex Responses requests include the selected effort;
- the TUI status/model surface shows the active effort clearly enough that users can tell what will be sent.

This plan exists because the change crosses config schema, global config mutation, slash command routing, model gateway provider options, the Codex request adapter, TUI display, docs, and tests.

## Competitor Findings

### OpenCode

OpenCode does not appear to expose `/effort` or `/reasoning` as direct slash commands. Its comparable surface is model variants:

- `/models` opens the model switcher.
- `/variants` opens a model-variant selector.
- `variant.cycle` cycles the selected variant.
- Local TUI state persists per-model variants in `model.json`.
- Config can define model `variants`, and each variant is an option object.
- Request construction merges base provider/model options, agent options, and the selected variant.

Relevant reference files:

- `/Users/kodisha/data/github/opencode/packages/opencode/src/config/provider.ts`
- `/Users/kodisha/data/github/opencode/packages/opencode/src/session/llm.ts`
- `/Users/kodisha/data/github/opencode/packages/opencode/src/cli/cmd/tui/context/local.tsx`
- `/Users/kodisha/data/github/opencode/packages/opencode/src/cli/cmd/tui/app.tsx`
- `/Users/kodisha/data/github/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-variant.tsx`

Interpretation: OpenCode treats reasoning effort as a model/provider option variant rather than as a dedicated one-off command. The UI persists the choice locally and displays the active variant next to the model.

### Pi

Pi has the cleanest provider abstraction for this feature:

- a normalized simple option named `reasoning`;
- canonical levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`;
- model-level `thinkingLevelMap` for unsupported or provider-specific mappings;
- provider-specific output fields, including Codex Responses `reasoning: { effort, summary }`, OpenAI-compatible `reasoning_effort`, and OpenRouter `reasoning: { effort }`;
- silently ignores reasoning options for non-reasoning models.

Relevant reference files:

- `/Users/kodisha/data/github/pi/packages/ai/README.md`
- `/Users/kodisha/data/github/pi/packages/ai/src/providers/openai-codex-responses.ts`
- `/Users/kodisha/data/github/pi/packages/ai/src/providers/openai-completions.ts`
- `/Users/kodisha/data/github/pi/packages/ai/src/types.ts`

Interpretation: Topchester should use a normalized effort enum internally, then map it to provider-specific request fields. For Codex Responses, send `reasoning: { effort, summary: "auto" }`.

### Codex CLI / App Server

Codex exposes reasoning effort as first-class model/session metadata:

- canonical efforts: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`;
- config key: `model_reasoning_effort`;
- model list responses include supported and default reasoning efforts;
- app-server turn start accepts `effort` to override current and subsequent turns;
- persisted threads remember `reasoningEffort`.

Relevant reference files:

- `/Users/kodisha/data/github/codex/codex-rs/protocol/src/openai_models.rs`
- `/Users/kodisha/data/github/codex/codex-rs/app-server/README.md`
- `/Users/kodisha/data/github/codex/codex-rs/app-server-protocol/schema/typescript/ReasoningEffort.ts`
- `/Users/kodisha/data/github/codex/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts`

Interpretation: Use Codex's exact effort vocabulary. Prefer durable config over UI-only state because Codex itself treats effort as configuration/session state.

### Roo Code and Goose

Roo has a provider transform layer that maps a selected `reasoningEffort` into provider-specific params:

- OpenAI-style `reasoning_effort`;
- OpenRouter-style `reasoning`;
- Gemini-style thinking levels and budgets.

Goose includes model metadata for reasoning support and strips effort suffixes when resolving model names, but it is less directly applicable to Topchester's current OpenAI-compatible/Codex path.

## Current Topchester State

Topchester currently has:

- provider config fields for `service_tier`, `includeUsage`, `promptCaching`, `toolProtocol`, and `openRouterToolRouting`;
- model assignments and choices;
- global mutation helpers for `/connect` and `/model`;
- TUI-only `/model` and `/connect` handling in `src/tui/shell.ts`;
- non-interactive slash command fallbacks in `src/agent/commands.ts`;
- a Codex adapter that rewrites chat completions to Codex Responses.

Current gap:

- `OpenAICompatibleProviderConfig` has no reasoning effort field.
- `chatCompletionsBodyToCodexResponsesBody()` does not forward reasoning options.
- The current `buildProviderOptions()` only emits provider options for service tier and prompt cache.
- `/model` updates global config, but there is no equivalent for reasoning effort.
- Status/model label does not include reasoning effort.

## Decisions

1. Add both `/effort` and `/reasoning` as aliases. They should share implementation and behavior.
2. Use Codex-compatible values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
3. Store the setting durably in config, not only in ephemeral TUI state.
4. Prefer a provider-level config field for V0: `providers.<id>.reasoningEffort`.
5. Use one generic config field and map it at the provider edge:
   - Codex Responses: `reasoning: { effort, summary: "auto" }`;
   - OpenRouter: `reasoning: { effort }`;
   - generic OpenAI-compatible fallback: `reasoning_effort`.
6. Keep the implementation scoped to request parameters and config. Do not alter prompt wording to simulate effort.

## Scope

Included:

- Config schema/type updates.
- Global config helper to set/clear reasoning effort.
- Slash suggestions and slash command fallback text.
- TUI handling for `/effort` and `/reasoning`.
- Model gateway/provider option plumbing.
- Codex request adapter support.
- Status/model label display.
- Docs and focused tests.

Out of scope:

- A full OpenCode-style model variant system.
- Provider catalog support for per-model supported effort lists.
- Provider-specific reasoning support beyond Codex Responses, OpenRouter, and the generic OpenAI-compatible fallback.
- Session-specific effort that differs from global config.
- Changing model selection behavior.

## Recommended Implementation Shape

Add a `ReasoningEffort` type near the model config layer:

```ts
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

Add `reasoningEffort?: ReasoningEffort` to `OpenAICompatibleProviderConfig`.

For request generation:

- Add a small provider-edge mapper, for example:

```ts
type ReasoningParamStyle = "codex-responses" | "openrouter" | "openai-compatible";
```

- Choose `codex-responses` for `isCodexProvider(...)`.
- Choose `openrouter` for `isOpenRouterProvider(...)`.
- Use `openai-compatible` as the fallback for any other OpenAI-compatible endpoint.
- `buildProviderOptions()` should include provider-specific reasoning for OpenRouter and generic OpenAI-compatible providers.
- `chatCompletionsBodyToCodexResponsesBody()` should understand reasoning metadata emitted from provider options or a request body extension and produce Codex Responses `reasoning`.
- The simplest robust implementation is to add `reasoningEffort` to the provider config, pass it through `buildProviderOptions()` for non-Codex providers, and extend `createCodexProviderFetch()` options with `reasoningEffort` so the Codex adapter can inject Responses-native reasoning directly.
- Keep the mapper deliberately small. Do not infer support from model names in V0; if a user configures effort for an unsupported model, let the provider return its normal validation error.

For commands:

- `/effort` with no args shows the current setting and accepted values.
- `/reasoning` with no args behaves identically.
- `/effort high` sets the active/default provider's effort in global config.
- `/reasoning medium` does the same.
- `/effort default`, `/effort clear`, and `/effort none` need a deliberate distinction:
  - `none` should send explicit `effort: "none"`;
  - `clear` or `default` should remove the config field and let provider/model defaults apply.

Recommended command messages:

- `Reasoning effort set to high.`
- `Reasoning effort cleared; provider defaults will apply.`
- `Current reasoning effort: high. Values: none, minimal, low, medium, high, xhigh.`

## Behavior To Preserve

- Existing `/model` and `/connect` behavior remains unchanged.
- Existing OpenRouter and non-Codex providers must continue working when no reasoning effort is configured.
- Codex auth must remain OAuth-backed; no auth config changes.
- `toolProtocol: "text-json"` remains the Codex default unless separately verified.
- Slash-command rows should remain visible-only session entries like current interactive commands, not model context messages.
- Non-interactive command dispatch should return a clear interactive-only message for commands that require TUI config mutation unless a CLI-safe path is intentionally added.

## Edge Cases

- Invalid level: show accepted values and do not mutate config.
- No provider configured: show setup guidance, likely `Run /connect codex` or configure a provider first.
- Default provider is a string alias or missing: resolve the same provider used by `agent.primary`.
- Current model uses a non-default provider: prefer the resolved active model provider over `providers.default` if they differ.
- `none` is an explicit value and must not be treated as clearing the field.
- `clear` removes the field and must not leave `reasoningEffort: undefined` serialized into JSON.
- OpenRouter must receive nested `reasoning: { effort }`, not `reasoning_effort`, because that is OpenRouter's normalized cross-provider control surface.
- Generic OpenAI-compatible fallback uses `reasoning_effort`; this may not work for every proxy/model, so docs should describe it as best-effort provider pass-through.

## Files To Change

- `src/config/index.ts`
- `src/model/index.ts`
- `src/model/codex.ts`
- `src/agent/commands.ts`
- `src/tui/shell.ts`
- `src/tui/status.ts`
- `docs/reference/model-config.md`
- `docs/features/slash-commands.md`
- `test/config.test.ts`
- `test/model.test.ts`
- `test/codex-provider.test.ts`
- `test/commands.test.ts`
- `test/tui.render.test.ts` if status/modal rendering changes

## Cross-Slice Rules

- Use one canonical effort enum everywhere.
- Use a provider-edge mapper for request field shapes; do not bake Codex-only or OpenRouter-only names into the config field.
- Keep `/effort` and `/reasoning` behavior identical.
- Prefer active resolved model provider over raw `providers.default` when deciding which provider config to mutate.
- Treat `none` as explicit effort and `clear` as removal.
- Do not add an OpenCode-style variant abstraction in this change.
- Do not simulate reasoning level through prompts.

## Slices

### Slice 1: Config Contract

Status: `[ ]` Not started

Goal: Add a durable, validated reasoning effort config field.

Why here: Runtime and slash commands need one schema-backed source of truth before they can mutate or consume effort.

This slice should implement:

- Add `reasoningEffort` schema enum to provider config.
- Export or colocate a reusable `ReasoningEffort` type.
- Add config tests for valid values and invalid values.
- Update config docs with the field and semantics.

Expected output:

- `TopchesterConfig.providers.<id>.reasoningEffort` parses and is typed.
- Invalid effort values fail config validation with a clear error.

Verification:

```sh
pnpm exec vitest test/config.test.ts
```

Dependencies: none.

### Slice 2: Request Plumbing

Status: `[ ]` Not started

Goal: Make configured reasoning effort reach model requests without changing user-visible commands yet.

Why here: The setting must actually affect Codex and OpenRouter before adding slash command UI.

This slice should implement:

- Add `reasoningEffort` to `OpenAICompatibleProviderConfig`.
- Thread the configured effort into the Codex provider fetch wrapper.
- Add Codex Responses body output: `reasoning: { effort, summary: "auto" }`.
- Add OpenRouter body/provider options output: `reasoning: { effort }`.
- Add generic OpenAI-compatible body/provider options output: `reasoning_effort`.
- Add focused tests proving configured reasoning is emitted in the correct shape for Codex, OpenRouter, and the generic fallback, and omitted when not configured.

Expected output:

- Codex OAuth requests include the expected `reasoning` object when `providers.codex.reasoningEffort` is set.
- OpenRouter requests include `reasoning: { effort }` when `providers.openrouter.reasoningEffort` is set.
- Other OpenAI-compatible requests include `reasoning_effort` when configured.
- Existing non-Codex provider tests still pass.

Verification:

```sh
pnpm exec vitest test/codex-provider.test.ts test/model.test.ts
```

Dependencies: Slice 1.

### Slice 3: Config Mutation Helper

Status: `[ ]` Not started

Goal: Add a small helper that sets or clears reasoning effort in the same global config file used by `/model`.

Why here: TUI command handling should call a focused config helper instead of editing JSON inline.

This slice should implement:

- Add `setGlobalReasoningEffort(providerId, effort | undefined)` or equivalent.
- Resolve the provider to mutate from the active model/provider context, not only `providers.default`.
- Keep JSON output stable and omit the field on clear.
- Add tests for set, overwrite, clear, and missing provider behavior.

Expected output:

- A reusable helper returns `{ path, providerId, reasoningEffort }` or similar for user-facing messages.

Verification:

```sh
pnpm exec vitest test/config.test.ts
```

Dependencies: Slice 1.

### Slice 4: Slash Command Surface

Status: `[ ]` Not started

Goal: Expose `/effort` and `/reasoning` as aliases in command suggestions and non-interactive fallback.

Why here: The command registry should know the commands before the TUI-specific mutation path intercepts them.

This slice should implement:

- Add suggestions for `/effort`, `/effort high`, `/reasoning`, and `/reasoning high`.
- Add slash command entries for both names.
- Outside the TUI, return an interactive-only message unless the implementation intentionally supports global config mutation in non-interactive mode.
- Update unknown-command helper text if needed.
- Add command tests for parsing and fallback behavior.

Expected output:

- Slash suggestions include the new aliases.
- Non-interactive execution is clear and non-mutating.

Verification:

```sh
pnpm exec vitest test/commands.test.ts
```

Dependencies: none, but best implemented after Slice 3.

### Slice 5: TUI Command Handling

Status: `[ ]` Not started

Goal: Implement interactive `/effort` and `/reasoning` behavior.

Why here: The TUI owns current `/model` config mutation and runtime reload.

This slice should implement:

- Detect both `/effort` and `/reasoning` before generic runtime slash command submission.
- With no args, show current effort and accepted values.
- With a valid effort, update global config, reload model config, refresh status/model label, and show a concise system message.
- With `clear` or `default`, remove the configured effort.
- With invalid args, show accepted values.
- Add focused TUI tests around command handling and rendered feedback.

Expected output:

- Users can set, inspect, and clear reasoning effort from the TUI.
- The active model gateway is reloaded immediately after mutation.

Verification:

```sh
pnpm exec vitest test/tui.render.test.ts test/commands.test.ts
```

Dependencies: Slices 1, 2, and 3.

### Slice 6: Status Display

Status: `[ ]` Not started

Goal: Make the active reasoning effort visible without crowding the prompt/status line.

Why here: Users need feedback that the setting persisted and will be sent.

This slice should implement:

- Update status/model label formatting to include configured effort, likely as `model [provider] · effort high` or a short equivalent.
- Include effort in `/status` or model setup details if status already has a provider section.
- Keep the display omitted when no effort is configured.
- Add render/status tests.

Expected output:

- The active effort is visible in the TUI after setting it and disappears after clearing.

Verification:

```sh
pnpm exec vitest test/tui.render.test.ts
```

Dependencies: Slice 5.

### Slice 7: Docs And Final Verification

Status: `[ ]` Not started

Goal: Document the feature and run the broader confidence pass.

Why here: User-facing command/config behavior changes should be documented after implementation details settle.

This slice should implement:

- Update `docs/features/slash-commands.md`.
- Update `docs/reference/model-config.md`.
- Mention Codex-specific behavior and the difference between `none` and `clear`.
- Add any release/changelog note if that is the current docs convention.

Expected output:

- Docs match command behavior and config semantics.

Verification:

```sh
pnpm exec vitest test/config.test.ts test/model.test.ts test/codex-provider.test.ts test/commands.test.ts test/tui.render.test.ts
mise run local-ci
```

Dependencies: Slices 1-6.

## Open Questions

1. Should `/effort <level>` mutate the active resolved provider or always mutate `providers.default`? Recommendation: active resolved provider.
2. Should `/effort` be available outside the TUI as a direct config command? Recommendation: no for V0; keep it aligned with `/model`.
3. Should Topchester expose reasoning effort per model assignment instead of provider config? Recommendation: provider config for V0, revisit if users need different effort per model.
4. Should OpenRouter receive reasoning options in V0? Decision: yes. Implement it through the same generic mapper, using OpenRouter's normalized `reasoning: { effort }` shape.
5. Should `summary` be configurable? Recommendation: hardcode `summary: "auto"` for Codex in V0 and avoid a second command axis.

## Final Verification

After all slices:

```sh
pnpm exec vitest test/config.test.ts test/model.test.ts test/codex-provider.test.ts test/commands.test.ts test/tui.render.test.ts
mise run local-ci
```

Manual check:

- Start TUI with Codex configured.
- Run `/effort high`.
- Confirm status/model display changes.
- Send a simple prompt.
- Confirm captured Codex request body includes `reasoning: { effort: "high", summary: "auto" }`.
- Run `/reasoning clear`.
- Confirm the display clears and the next request omits `reasoning`.

## Progress Log

- 2026-06-04: Created plan after inspecting Topchester's current config/model/TUI paths and competitor references from OpenCode, Pi, Codex, Roo, and Goose.
