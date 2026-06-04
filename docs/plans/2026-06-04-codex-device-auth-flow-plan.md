# Codex Device Auth Flow

## Summary

Add first-class Codex ChatGPT login support to Topchester using Codex's SSH-friendly device-code flow and refresh-token based runtime auth. The target state is that a user can run a Topchester auth/connect command from a remote shell, open the displayed verification URL on any browser, enter the device code, and then use Codex-backed models from the normal model picker without exposing tokens in project config.

This plan is documentation only. No implementation has started.

## Decisions

- Start with Codex only. Antigravity SSO remains out of scope until there is a documented, supportable device or token flow.
- Use Codex's device-code flow as the primary login path, not localhost browser redirect.
- Build the command-line device login only for V0. It is the simpler SSH-native path and should prove auth storage, polling, token exchange, provider setup, and runtime use before any interactive TUI wrapper is considered.
- Store OAuth tokens in a Topchester global auth store, not in `topchester.jsonc`, session files, logs, or the knowledge base.
- Reuse the existing OpenAI-compatible model gateway where possible by passing a provider-specific `fetch` implementation through `@ai-sdk/openai-compatible`.
- Keep the provider configuration declarative and non-secret. Runtime credentials should resolve from the auth store or environment.
- Treat Codex as a provider integration, not as generic OpenAI API-key auth. The runtime needs Codex-specific token refresh, request headers, and backend URL routing.

## Scope

Included:

- Global auth store foundation for OAuth credentials.
- Codex device-code login and token refresh.
- Codex provider config defaults and model choices.
- Codex request adaptation for the OpenAI-compatible AI SDK path.
- CLI connect flow that works over SSH.
- Status output that reports auth source without leaking secrets.
- Focused unit tests and docs updates.

Out of scope:

- Antigravity OAuth/SSO.
- Reusing `~/.codex/auth.json` or another tool's private login cache.
- Native OS keychain support.
- Browser localhost callback login.
- TUI `/connect codex`; keep it as a future improvement after the CLI/runtime path is proven.
- Revocation/logout UI beyond a minimal stored-token removal command if needed for cleanup.
- A live integration test that requires a real ChatGPT account.

## Current State

Topchester currently supports static OpenAI-compatible providers:

- `src/config/index.ts` accepts provider fields such as `baseURL`, `apiKeyEnv`, `apiKey`, `headers`, `includeUsage`, `promptCaching`, and tool protocol flags.
- `src/model/index.ts` calls `createOpenAICompatible(...)` with a static `apiKey`, static `headers`, and no custom `fetch`.
- `src/tui/shell.ts` exposes `/connect openrouter` only.
- `src/cli.ts`, `src/cli/info.ts`, and `src/tui/status.ts` report provider auth as env, inline, or none.
- `docs/plans/2026-05-15-model-connect-openrouter-v0-plan.md` already identified the need for a global auth store, but that slice is still not started.

## Competitor Findings

Codex local checkout:

- `/Users/kodi/data/github/codex/codex-rs/login/src/device_code_auth.rs` implements the headless flow:
  - POST `{issuer}/api/accounts/deviceauth/usercode` with the Codex client id.
  - Show `{issuer}/codex/device` and the returned user code.
  - Poll `{issuer}/api/accounts/deviceauth/token`.
  - Exchange the returned authorization code at `{issuer}/oauth/token` using redirect URI `{issuer}/deviceauth/callback`.
  - Persist `id_token`, `access_token`, and `refresh_token`.
- `/Users/kodi/data/github/codex/codex-rs/login/src/auth/manager.rs` uses refresh URL `https://auth.openai.com/oauth/token` and the default ChatGPT backend base URL `https://chatgpt.com/backend-api`.

OpenCode local checkout:

- `/Users/kodi/data/github/opencode/packages/opencode/src/plugin/openai/codex.ts` confirms the same Codex client id, issuer, device-code endpoints, and token exchange shape.
- OpenCode's Codex plugin injects `Authorization: Bearer <access>` and `ChatGPT-Account-Id` when available.
- OpenCode rewrites AI SDK-style `/v1/responses` or `/chat/completions` requests to `https://chatgpt.com/backend-api/codex/responses`.
- OpenCode filters available OAuth-backed models to Codex-supported GPT models and sets zero cost metadata for those entries.

## Implementation Shape

Add a small auth subsystem and wire it into the existing provider pipeline:

```text
topchester auth login codex --device
  -> request device code from auth.openai.com
  -> show verification URL and one-time code
  -> poll until approved or timed out
  -> exchange authorization code for tokens
  -> store tokens in ~/.config/topchester/auth.json

ModelGateway.resolveModel("codex/...")
  -> load stored Codex OAuth record
  -> refresh access token when expired
  -> create OpenAI-compatible provider with custom fetch
  -> inject Bearer token and ChatGPT-Account-Id
  -> route chat/responses requests to ChatGPT Codex backend
```

Recommended auth store shape:

```json
{
  "version": 1,
  "providers": {
    "codex": {
      "type": "oauth_codex",
      "issuer": "https://auth.openai.com",
      "refreshToken": "...",
      "accessToken": "...",
      "idToken": "...",
      "expiresAt": 1790000000000,
      "accountId": "..."
    }
  }
}
```

Rules:

- Create `~/.config/topchester/` with mode `0700` where possible.
- Write `~/.config/topchester/auth.json` with mode `0600`.
- Keep writes atomic enough that an interrupted refresh does not corrupt the auth file.
- Never print token values.
- Refresh with a small safety window before `expiresAt`.
- Serialize concurrent refreshes for the same provider to avoid refresh-token races.

## Data Flow

Device-code login:

1. Build Codex auth constants: issuer `https://auth.openai.com`, client id `app_EMoamEEZ73f0CkXaXp7hrann`, verification URL path `/codex/device`, device redirect path `/deviceauth/callback`.
2. POST JSON `{ "client_id": "<client id>" }` to `https://auth.openai.com/api/accounts/deviceauth/usercode`.
3. Display the verification URL, user code, expiry, and phishing warning.
4. Poll `https://auth.openai.com/api/accounts/deviceauth/token` with `device_auth_id` and `user_code`.
5. On success, exchange `authorization_code` and `code_verifier` at `https://auth.openai.com/oauth/token`.
6. Extract `accountId` from `id_token` first, then `access_token` as a fallback.
7. Persist OAuth tokens and configure the global `codex` provider plus starter model choices.

Runtime request:

1. Resolve `models.providers.codex`.
2. Resolve OAuth auth from the global auth store.
3. Refresh access token if missing or expired.
4. Pass custom `fetch` to `createOpenAICompatible`.
5. Remove any stale `Authorization` header from the SDK request.
6. Add `Authorization: Bearer <accessToken>`.
7. Add `ChatGPT-Account-Id: <accountId>` when available.
8. Rewrite `/v1/responses` and `/chat/completions` to the Codex backend endpoint.

## Edge Cases

- Device login endpoint returns 404: report that device-code login is unavailable for the current Codex auth server.
- Polling keeps returning pending statuses: continue until the 15-minute timeout.
- Polling returns an unexpected non-pending status: fail with a short actionable error.
- Token exchange fails: leave existing stored auth untouched.
- Refresh token is revoked, reused, expired, or account-mismatched: mark auth as needing re-login and show `topchester auth login codex --device`.
- Refresh returns a rotated refresh token: persist the rotated token.
- Account id cannot be extracted: continue without `ChatGPT-Account-Id`, but record the missing claim as a warning/finding during implementation.
- Multiple model requests trigger refresh at once: only one refresh should write the auth record.
- Login command is interrupted: stop polling and keep previous auth state.

## Files To Add

- `src/auth/store.ts`: global auth file path, schema, redacted read status, mode-safe read/write helpers.
- `src/auth/codex.ts`: Codex OAuth constants, device-code request/poll/exchange, token refresh, JWT claim parsing.
- `src/model/codex.ts`: Codex provider defaults, custom fetch factory, request URL rewrite, auth header injection.
- `test/auth-store.test.ts`: auth store read/write, permissions, redaction, and corruption handling.
- `test/codex-auth.test.ts`: device-code flow, token exchange, refresh, account-id extraction.
- `test/codex-provider.test.ts`: custom fetch rewrite, header behavior, refresh-on-expiry.

## Files To Change

- `src/config/index.ts`: add known `codex` provider defaults and config normalization support for OAuth-backed providers.
- `src/app/context.ts`: pass auth store access into `ModelGateway` or into a model-provider resolver.
- `src/model/index.ts`: accept provider-specific fetch/auth adapters without weakening generic OpenAI-compatible behavior.
- `src/cli.ts`: add `topchester auth login codex --device` and possibly `topchester auth status`.
- `src/cli/info.ts`: include OAuth auth status in provider output.
- `docs/reference/model-config.md`: document the Codex provider shape and OAuth auth behavior.
- `docs/reference/config-schema.md`: document any new config fields.
- `docs/plans/2026-05-15-model-connect-openrouter-v0-plan.md`: optionally mark the global auth store slice as superseded or fulfilled by this plan once implemented.

## Cross-Slice Rules

- Keep existing OpenRouter behavior unchanged in every slice.
- Keep OAuth secrets out of normal config and logs.
- Tests should mock network calls; do not require real Codex credentials.
- Avoid reading or importing `~/.codex/auth.json`; a future import command can be planned separately if explicitly needed.
- Use provider-specific code only at the auth/fetch boundary. Do not spread Codex conditionals through agent runtime logic.
- Update this plan after each slice with actual findings and commands that passed.

## Slices

### Slice 1: Auth Store Foundation

Status: `[x]` Done

Goal: Add a secure global auth store that can hold OAuth records and future API-key records without changing normal config semantics.

Why here: Codex login, refresh, status, and provider resolution all need one durable credential source.

This slice should implement:

- Add auth store schema with `version` and `providers`.
- Add read/write helpers with redacted status output.
- Create parent directory with mode `0700` and auth file with mode `0600` where supported.
- Preserve unknown provider records to avoid destructive writes.
- Add corruption and missing-file behavior.

Expected output:

- `src/auth/store.ts`
- focused tests in `test/auth-store.test.ts`

Verification:

- `pnpm test test/auth-store.test.ts`
- `pnpm check`
- `mise run local-ci`

Dependencies: none.

Completed in this slice:

- Added `src/auth/store.ts` with a versioned global auth store schema, missing-file fallback, corruption errors, status redaction, provider set/remove helpers, private directory/file modes, and atomic write/rename behavior.
- Added `test/auth-store.test.ts` coverage for missing files, private mode writes, unknown provider preservation, targeted provider removal, corrupt-store handling, non-throwing corrupt status, and token redaction.

### Slice 2: Codex OAuth Client

Status: `[x]` Done

Goal: Implement Codex device-code login, token exchange, token refresh, and account-id extraction behind testable functions.

Why here: The OAuth protocol should be proven independently before any model-runtime integration.

This slice should implement:

- Codex constants for issuer, client id, device endpoints, token endpoint, redirect URI, and backend endpoint.
- `requestCodexDeviceCode`.
- `pollCodexDeviceAuthorization`.
- `exchangeCodexAuthorizationCode`.
- `refreshCodexAccessToken`.
- JWT claim parsing for `chatgpt_account_id`, namespaced ChatGPT auth claims, and organization fallback.
- 15-minute timeout and interval handling.

Expected output:

- `src/auth/codex.ts`
- `test/codex-auth.test.ts`

Verification:

- `pnpm test test/codex-auth.test.ts test/auth-store.test.ts`
- `pnpm check`
- `mise run local-ci`

Dependencies: Slice 1.

Completed in this slice:

- Added `src/auth/codex.ts` with Codex OAuth constants, device-code request/poll helpers, token exchange, token refresh, typed auth errors, injectable fetch/sleep/time for offline tests, and JWT account-id extraction.
- Added `test/codex-auth.test.ts` coverage for device-code request payloads, unavailable endpoint handling, pending polling, timeout, unexpected polling failure, authorization-code exchange, rotated refresh-token persistence, invalid token responses, and supported account-id claim variants.

### Slice 3: Codex Provider Runtime Adapter

Status: `[x]` Done

Goal: Make `ModelGateway` capable of using stored Codex OAuth credentials for model requests without changing the generic OpenAI-compatible path.

Why here: Once auth primitives exist, the highest-risk runtime behavior is request adaptation and refresh-on-use.

This slice should implement:

- Add a provider auth adapter interface or equivalent resolver passed into `ModelGateway`.
- Pass custom `fetch` to `createOpenAICompatible` for Codex providers.
- Inject bearer auth and `ChatGPT-Account-Id`.
- Rewrite `/v1/responses` and `/chat/completions` to `https://chatgpt.com/backend-api/codex/responses`.
- Refresh expired tokens and persist rotated tokens.
- Keep normal `apiKeyEnv` and inline `apiKey` behavior unchanged for other providers.

Expected output:

- `src/model/codex.ts`
- targeted changes in `src/model/index.ts` and `src/app/context.ts`
- `test/codex-provider.test.ts`

Verification:

- `pnpm test test/codex-provider.test.ts test/model.test.ts test/config.test.ts`
- `pnpm check`
- `mise run local-ci`

Dependencies: Slices 1 and 2.

Completed in this slice:

- Added `src/model/codex.ts` with the Codex provider fetch adapter, Codex backend URL rewrite, OAuth bearer and `ChatGPT-Account-Id` header injection, expiry-window refresh, rotated token persistence, and serialized refreshes by auth store/provider.
- Updated `src/model/index.ts` so only provider id `codex` receives the custom fetch; the normal OpenAI-compatible `apiKey`, headers, and request path stay unchanged for other providers.
- Added `test/codex-provider.test.ts` coverage for URL rewriting, stale Authorization replacement, stored OAuth header injection, refresh-on-expiry with persisted rotated tokens, and non-Codex provider behavior.

### Slice 4: Config Defaults And Model Choices

Status: `[x]` Done

Goal: Add a known `codex` provider setup helper and starter model choices while preserving user/project config layering.

Why here: The runtime adapter needs a provider entry and model refs before the CLI login can produce a useful setup.

This slice should implement:

- Add `codexProviderDefaults`.
- Add `configureCodexGlobalProvider`.
- Seed Codex model choices, initially conservative:
  - `codex/gpt-5.5`
  - `codex/gpt-5.4`
  - `codex/gpt-5.4-mini`
  - `codex/gpt-5.3-codex-spark`
- Set `toolProtocol: "native"` and structured-output defaults only if verified against the Codex backend adapter.
- Add config tests for normalization, known-provider defaults, and choice persistence.

Expected output:

- config helpers in `src/config/index.ts`
- tests in `test/config.test.ts`

Verification:

- `pnpm test test/config.test.ts`
- `pnpm check`
- `mise run local-ci`

Dependencies: Slice 3 for final runtime confidence, but config helpers can be drafted after Slice 1.

Completed in this slice:

- Added `codexProviderDefaults`, `codexStarterModelChoices`, and `configureCodexGlobalProvider` in `src/config/index.ts`.
- Extended known-provider normalization so `codex/...` model refs add a non-secret `codex` provider default without API-key fields.
- Seeded conservative Codex choices: `codex/gpt-5.5`, `codex/gpt-5.4`, `codex/gpt-5.4-mini`, and `codex/gpt-5.3-codex-spark`.
- Left `toolProtocol` and `supportsStructuredOutputs` unset by default until live Codex backend behavior is verified.

### Slice 5: CLI Login And Status

Status: `[x]` Done

Goal: Add an SSH-friendly command-line login path that can be used without entering the interactive TUI.

Why here: The user specifically wants device/token login to work over SSH where localhost browser redirects are painful. CLI login is the V0 product surface because it has fewer UI state concerns and proves the reusable auth primitives first.

This slice should implement:

- `topchester auth login codex --device`.
- Print verification URL and user code.
- Poll until success, cancellation, or timeout.
- Store tokens and configure the global Codex provider.
- Add `topchester auth status` or extend `topchester info` enough to report stored Codex OAuth state.
- Avoid token output in every command path.

Expected output:

- CLI command changes in `src/cli.ts`
- status changes in `src/cli/info.ts`
- tests for command output and redaction where practical

Verification:

- `pnpm test test/config.test.ts test/codex-auth.test.ts test/auth-store.test.ts`
- `pnpm check`
- Manual mocked CLI check if the test harness cannot cover commander output cleanly.
- `mise run local-ci`

Dependencies: Slices 1, 2, and 4.

Completed in this slice:

- Added `topchester auth login codex --device` with device-code display, polling, OAuth token exchange, auth-store persistence, and global Codex provider/model-choice configuration.
- Added `topchester auth status` with redacted stored-provider state.
- Updated `topchester info` so configured Codex providers report OAuth store state without token values.
- Updated global path helpers to respect `process.env.HOME` before `os.homedir()` so auth/config writes stay inside test and SSH-controlled homes.
- Added CLI integration coverage for redacted auth status/info and a fully mocked device login.

### Slice 6: Docs And Final Verification

Status: `[x]` Done

Goal: Document the user-facing Codex login/config behavior and run the broader repo gate.

Why here: This integration changes setup workflows and auth expectations; docs should land with the feature.

This slice should implement:

- Update model/provider docs with Codex device auth.
- Update config schema docs for OAuth-backed provider fields.
- Document auth storage path and redaction guarantees.
- Document relogin guidance for revoked/expired refresh tokens.
- Update this plan with completed slice statuses and any live/manual validation notes.

Expected output:

- docs updates in `docs/reference/`
- completed plan notes

Verification:

- `pnpm check`
- `pnpm test test/auth-store.test.ts test/codex-auth.test.ts test/codex-provider.test.ts test/config.test.ts`
- `mise run local-ci`

Dependencies: all prior slices.

Completed in this slice:

- Updated `docs/reference/cli.md` with `topchester auth login codex --device` and `topchester auth status`.
- Updated `docs/reference/model-config.md` with Codex OAuth login, non-secret provider config, starter model choices, auth storage, request adaptation, and default tool/structured-output caveats.
- Updated `docs/reference/config-schema.md` with the public provider config shape and OAuth-backed Codex provider notes.
- Updated `docs/reference/troubleshooting.md` with Codex login and relogin guidance.
- Ran final focused auth/config/provider tests, full `pnpm check`, and final `mise run local-ci`.

## Future Improvements

- Add TUI `/connect codex` after the CLI/runtime path is proven. It should reuse the same auth functions, render the device URL and code in-thread, support cancellation, refresh app config/model gateway on success, and update setup hints.
- Add TUI render tests for `/connect codex` only when that future slice is implemented.

## Testing Plan

Unit tests:

- Auth store mode, parse, write, preserve unknown records, and redaction.
- Device-code endpoint request body and response parsing.
- Polling success, pending retry, timeout, and unexpected failure.
- Token exchange and refresh request bodies.
- Rotated refresh-token persistence.
- JWT account-id extraction variants.
- Codex fetch adapter header injection and URL rewrite.
- Provider config normalization and model choice seeding.
- CLI output redaction.

Manual checks:

- Run `topchester auth login codex --device` from a real terminal and complete login in a separate browser.
- Run `topchester info` and confirm it shows stored OAuth without token values.
- Select a Codex model with `/model`.
- Run a trivial prompt and confirm the request succeeds.

Final confidence command:

```sh
pnpm check
pnpm test test/auth-store.test.ts test/codex-auth.test.ts test/codex-provider.test.ts test/config.test.ts
```

## Open Questions

- Should the provider id be fixed as `codex`, or should it be `openai-codex` to avoid confusion with normal OpenAI API-key providers?
- Should Topchester allow `CODEX_ACCESS_TOKEN` as a temporary bearer-token override, mirroring Codex's official token path, or keep V0 refresh-token only?
- Which Codex models should be seeded after live validation against the backend available to user accounts?
- Should logout be included in V0 as `topchester auth logout codex`, or deferred until after login/runtime support lands?
- Should token refresh errors remove access tokens immediately, or keep the stale record and mark it as `needsLogin` for better diagnostics?
- Can `supportsStructuredOutputs` remain enabled for Codex backend requests, or should it be disabled until verified with native tool calls and structured outputs?

## Working Notes

- 2026-06-04: Plan created from local Topchester, Codex, and OpenCode source inspection. No implementation has started.
- 2026-06-04: Slice 1 completed. Verification passed: `pnpm test test/auth-store.test.ts`, `pnpm check`, and `mise run local-ci`.
- 2026-06-04: Slice 2 completed. Verification passed: `pnpm test test/codex-auth.test.ts test/auth-store.test.ts`, `pnpm check`, and `mise run local-ci`.
- 2026-06-04: Slice 3 completed. Verification passed: `pnpm test test/codex-provider.test.ts test/model.test.ts test/config.test.ts`, `pnpm check`, and `mise run local-ci`.
- 2026-06-04: Slice 4 completed. Verification passed: `pnpm test test/config.test.ts`, `pnpm check`, and `mise run local-ci`.
- 2026-06-04: Slice 5 completed. Verification passed: `pnpm test test/config.test.ts test/codex-auth.test.ts test/auth-store.test.ts test/cli.integration.test.ts`, `pnpm check`, and `mise run local-ci`. The local-ci run printed a non-fatal mise cache warning for `/Users/kodi/Library/Caches/mise/...`, then completed successfully.
- 2026-06-04: Slice 6 completed. Verification passed: `pnpm test test/auth-store.test.ts test/codex-auth.test.ts test/codex-provider.test.ts test/config.test.ts`, `pnpm check`, and `mise run local-ci`.
