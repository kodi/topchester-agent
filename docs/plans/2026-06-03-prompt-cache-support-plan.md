# Prompt Cache Support

## Summary

Topchester should make provider-side prompt caching work by default for OpenAI-compatible providers while keeping a provider-level escape hatch for proxies that reject cache-specific request fields. The target state is stable per-session cache keys, conservative cache markers on stable prompt blocks, and visible cache-read/cache-write usage when `TOPCHESTER_SHOW_TOKEN_USAGE` is enabled.

## Decisions

- Enable prompt-cache hints by default for configured OpenAI-compatible providers.
- Add a provider config disable option instead of requiring users to opt in.
- Use the persisted Topchester session id as the stable cache key.
- Keep the display behind the existing `TOPCHESTER_SHOW_TOKEN_USAGE` environment flag.
- Do not implement local token caching; providers and proxies own actual cache storage, lookup, and billing.

## Scope

Included:

- OpenAI-compatible gateway request shape.
- Provider config schema and docs.
- Runtime pass-through of session ids to model calls.
- Cache-read/cache-write usage normalization and metadata display.
- Focused tests for request body, config, and display behavior.

Out of scope:

- Native Anthropic/Bedrock/Gemini provider implementations.
- Provider-specific long-cache retention policies.
- Live-provider validation without API keys.
- Persisting token usage in session history.

## Current State

- `ModelGateway` uses `@ai-sdk/openai-compatible`.
- `buildProviderOptions` only passes `service_tier`.
- Native agent steps use OpenRouter routing hints and `parallel_tool_calls: false`.
- `TOPCHESTER_SHOW_TOKEN_USAGE=1` shows input/output tokens and cost only.
- Persisted sessions already have stable UUIDv7 session ids.

## Implementation Shape

- Add `promptCaching?: boolean` to OpenAI-compatible provider config; default is enabled.
- Add `sessionId?: string` to model requests and use it as `prompt_cache_key`.
- Build SDK `messages` instead of `system` + `prompt` when cache markers are enabled, so message-level `providerOptions.openaiCompatible.cache_control` can become provider request fields.
- Mark the system message and current user message with `{ type: "ephemeral" }` cache controls when prompt caching is enabled.
- Normalize cache usage from both AI SDK usage details and raw provider response bodies.

## Edge Cases

- Providers that reject `prompt_cache_key` or `cache_control`: set `models.providers.<id>.promptCaching: false`.
- Runs without persisted session: omit `prompt_cache_key` but still allow cache markers.
- Cached tokens may already be included in `inputTokens`; display cache counts separately rather than subtracting from existing totals.
- Cache-write fields are inconsistent across proxies, so raw-body extraction should accept common names.

## Slices

### Slice 1: Config and Request Contract

Status: `[x]` Done

Goal: Add provider-level prompt-cache configuration and carry session ids into model requests.

Why here: Cache behavior must be disableable before any default request fields are emitted.

This slice should implement:

- `promptCaching?: boolean` in config schema and model provider config.
- Runtime `sessionId` pass-through for agent primary model calls.
- Request option helpers that omit cache fields when `promptCaching: false`.

Expected output:

- Config loads the new option.
- Model requests can include a stable session id.

Verification:

- Passed: `pnpm test test/config.test.ts test/model.test.ts test/commands.test.ts`

Dependencies:

- None.

### Slice 2: Cache Keys and Markers

Status: `[x]` Done

Goal: Emit stable prompt-cache keys and conservative cache-control markers by default.

Why here: The request contract and disable path must exist first.

This slice should implement:

- Top-level `prompt_cache_key` from session id.
- Message-level OpenAI-compatible `cache_control: { type: "ephemeral" }` markers on system and user messages.
- Tests proving cache fields appear by default and disappear when disabled.

Expected output:

- Providers/proxies that support these hints can reuse prompt cache across loop iterations and resumed session turns.

Verification:

- Passed: `pnpm test test/config.test.ts test/model.test.ts test/commands.test.ts`

Dependencies:

- Slice 1.

### Slice 3: Cache Usage Display

Status: `[x]` Done

Goal: Show cache-read/cache-write counts only when `TOPCHESTER_SHOW_TOKEN_USAGE` is enabled.

Why here: Display should reflect the new usage fields after request support exists.

This slice should implement:

- Extend `ModelTokenUsage` and turn totals with cache-read/cache-write counts.
- Extract common cache fields from AI SDK usage details and raw provider bodies.
- Append cache counts to the existing assistant metadata token line.

Expected output:

- Example metadata: `1,545 input / 97 output tokens / 1,200 cache read / 300 cache write / $0.00056`.

Verification:

- Passed: `pnpm test test/config.test.ts test/model.test.ts test/commands.test.ts`

Dependencies:

- Slice 1.

### Slice 4: Docs and Final Verification

Status: `[x]` Done

Goal: Document prompt caching behavior and complete repo-standard checks.

Why here: Users need the disable option documented before default cache hints ship.

This slice should implement:

- Update model config docs and TUI/CLI env docs.
- Mark completed slices with actual verification.

Expected output:

- A future maintainer can resume from this plan and see what passed.

Verification:

- Passed: `pnpm test test/config.test.ts test/model.test.ts test/commands.test.ts`
- Passed: `pnpm run typecheck`
- Passed: `pnpm check`

Dependencies:

- Slices 1-3.

## Open Questions

- Should Topchester later support configurable cache retention such as `24h`, or keep this provider-specific until more live validation exists?
- Should tool definitions receive cache markers once the AI SDK tool provider-options path is confirmed for OpenAI-compatible tools?
