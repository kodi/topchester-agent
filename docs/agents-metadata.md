# Agents Metadata

`agents.json` is the checked-in registry for public agent metadata. Consumers should look up records by the map key, for example `agents.codex`.

## Shape

Required top-level fields:

- `version` - registry schema version. Current value is `1`.
- `agents` - object keyed by stable agent id.

Required agent fields:

- `display_name` - human-readable agent name.
- `description` - short details-page summary.

Optional agent fields:

- `logo_image` - logo path or URL. Relative paths are relative to the consuming app's asset convention.
- `external_url` - primary public page for the agent.
- `source_url` - source repository or source-available project page.
- `docs_url` - documentation URL.
- `tags` - short grouping labels for filters or badges.
- `capabilities` - details-page capabilities such as `hooks`, `mcp`, `subagents`, or `terminal-ui`.
- `model_support` - model-related metadata.

Optional `model_support` fields:

- `providers` - provider ids the agent can use, such as `openai`, `openrouter`, or `ollama`.
- `recommended` - specific model recommendations.
- `requirements` - booleans for model features the agent expects.

Recommended model entries use:

- `provider` - provider id.
- `model` - provider-native model id.
- `purpose` - optional purpose label such as `primary`, `fast`, or `summarize`.
- `notes` - optional display note.

Model requirements support:

- `tool_calling`
- `streaming`
- `reasoning`
- `vision`
- `json_mode`

## TypeScript

Use `getAgentMetadata("codex")` for a single record or `listAgentMetadata()` for a sorted list. The runtime schema lives in `src/agent/metadata.ts` and validates `agents.json` at import time.
