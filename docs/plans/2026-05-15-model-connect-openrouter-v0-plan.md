# Model And Connect OpenRouter V0

## Summary

Implement the first usable `/model` and `/connect` flow for the interactive TUI. V0 keeps `/model` focused on a configured shortlist, uses OpenRouter as the first provider, and writes personal provider/model changes to `~/.config/topchester/config.jsonc`.

## Decisions

- `/model` chooses from `models.choices`, not from every provider model by default.
- Choice refs use `<provider>/<provider-native-model-id>`, for example `openrouter/qwen/qwen3-coder`.
- `/connect` starts with OpenRouter only.
- Initial V0 writes `apiKeyEnv: OPENROUTER_API_KEY`, not the key value.
- Follow-up V0 should add a global auth store so `/connect openrouter` can save an API key without asking users to edit shell env.
- Project config stays in repo-root `topchester.jsonc`; interactive provider setup, model choices, and selected default are saved to `~/.config/topchester/config.jsonc`.
- `.topchester/` is state/cache/session storage, not a config layer.

## Competitor Auth Findings

- Pi stores credentials in `~/.pi/agent/auth.json`. Its auth layer stores both API keys and OAuth credentials, creates the parent directory with mode `0700`, writes the auth file with mode `0600`, and uses file locking for refresh/write safety. Resolution order is runtime override, stored `auth.json`, OAuth from `auth.json`, environment variables, then custom fallback resolvers.
- OpenCode stores provider credentials under its global XDG data directory, not project config. Current code has `auth.json` and newer `auth-v2.json` under `Global.Path.data`, normally `~/.local/share/opencode/`. Writes use mode `0600`, and an `OPENCODE_AUTH_CONTENT` env override exists for tests or injected auth.
- Codex uses `$CODEX_HOME/auth.json` as the file fallback for CLI auth and also supports a keyring-backed store. In auto/keyring mode it removes the file fallback after saving to keyring; local dev resolves keyring/auto to file.
- Cline is an editor extension, so it uses extension-local storage rather than a terminal CLI config file: `~/.cline/data/secrets.json` with mode `0600`, plus separate global and workspace state JSON files. Provider API keys map to named secret keys such as `openRouterApiKey`.
- Kilo Code follows OpenCode for its CLI auth path: `Global.Path.data/auth.json` with mode `0600`, plus Kilo-specific gateway auth migration from older config.

## Auth Recommendation

Topchester should add a small global auth store:

```text
~/.config/topchester/auth.json
```

Proposed V0 file shape:

```json
{
  "version": 1,
  "providers": {
    "openrouter": {
      "type": "api_key",
      "key": "..."
    }
  }
}
```

Rules:

- Create `~/.config/topchester/` with mode `0700` where possible.
- Write `auth.json` with mode `0600`.
- Do not put auth in normal config, `topchester.jsonc`, sessions, or `topchester-kb/`.
- Resolve provider auth in this order: runtime override, environment variable named by config, global `auth.json`, inline `apiKey` from explicit config for advanced/test setups.
- `/connect openrouter` should offer two choices: use `OPENROUTER_API_KEY` from env, or paste an API key and save it to `auth.json`.
- `/connect` and startup should display only source labels such as `env:OPENROUTER_API_KEY` or `stored auth`, never the key.

## Scope

Included:

- Config schema and merge support for `models.choices`.
- Global user config helpers for OpenRouter provider setup, choice updates, and default model updates.
- TUI slash commands `/model`, `/models`, `/connect`, `/provider`, and `/providers`.
- OpenRouter catalog fetch for `/model all`.
- Docs and focused tests.

Out of scope for V0:

- Native OAuth or secret-store integration.
- Rich searchable picker UI.
- Provider types beyond OpenAI-compatible OpenRouter.
- Team-shared choice editing from the TUI.

## Slice 1: Config Contract

Status: `[x]` Done

- Add normalized `models.choices`.
- Add global user config write helpers for provider, choices, and default slot.
- Keep OpenRouter defaults centralized.

Verification: passed with `pnpm test test/config.test.ts test/commands.test.ts test/openrouter-models.test.ts test/tui.render.test.ts`

## Slice 2: OpenRouter Model Discovery

Status: `[x]` Done

- Add a small OpenRouter catalog client around `/api/v1/models` and `/api/v1/models/user`.
- Map catalog ids to Topchester refs as `openrouter/<id>`.
- Add starter-choice scoring so `/connect openrouter` can seed a useful shortlist.
- Finding: `/model all` must not show OpenRouter's raw first page/order for an empty query. The API order can surface expensive or random non-coding models first. Empty `/model all` should rank coding-agent-friendly choices; typed search can still search the full catalog.
- Finding: `/connect openrouter` seeds a hand-picked 10-model shortlist and promotes it ahead of older user choices: Qwen free/paid coder, Claude Sonnet, GPT-5 Codex, Gemini Flash Lite, Grok, Mistral Medium, DeepSeek Chat, InclusionAI Ring, and OpenRouter Owl.

Verification: passed with `pnpm test test/config.test.ts test/commands.test.ts test/openrouter-models.test.ts test/tui.render.test.ts`

## Slice 3: TUI Commands

Status: `[x]` Done

- Intercept `/model` and `/connect` in the TUI shell.
- Show modal choices for configured models and OpenRouter provider connection.
- Persist model selection and refresh the footer model label.
- Finding: model pickers do not need an artificial result cap now that the modal renderer windows long action lists around the selected row. V0 keeps all matches and scrolls the visible modal rows with the existing arrow-key selection.
- Finding: OpenRouter picker labels omit the leading `openrouter/` for readability, but modal action values and persisted config still use the full provider-qualified ref.

Verification: passed with `pnpm test test/config.test.ts test/commands.test.ts test/openrouter-models.test.ts test/tui.render.test.ts`

## Slice 4: Docs

Status: `[x]` Done

- Update model config docs with `models.choices`.
- Update TUI docs with the new slash command behavior.
- Keep CLI docs clear that these commands are interactive TUI commands.

Verification: passed with `pnpm test test/config.test.ts test/commands.test.ts test/openrouter-models.test.ts test/tui.render.test.ts`

## Slice 4.1: Simplify Config Layers

Status: `[x]` Done

- Remove `.topchester/config.local.*` from the default config load path.
- Keep repo-root `topchester.jsonc` for shared project policy.
- Write `/connect`, `/model`, and `/model all` provider/model changes to `~/.config/topchester/config.jsonc`.
- Preserve project-specific command approval writes to repo-root `topchester.jsonc`.
- Keep `models.default` as primary plus fallback so a user default does not wipe out project-specific `fast` or `kb.summarize` slots.
- Update config and TUI docs to describe the simpler two-config model.

Verification: passed with `pnpm check`

## Slice 5: Global Auth Store

Status: `[ ]` Not started

- Add `src/auth/` with a tiny JSON auth store for API keys.
- Wire `ModelGateway` API-key resolution through the auth store without storing secrets in normal config.
- Extend `/connect openrouter` to accept a pasted API key and save it to global auth.
- Add `/connect` status text that distinguishes `env`, `stored auth`, and `not set`.
- Add tests for file mode, read/write behavior, precedence, and redacted UI output.

Verification: run `pnpm test test/config.test.ts test/model.test.ts test/commands.test.ts test/tui.render.test.ts` and `pnpm check`.
