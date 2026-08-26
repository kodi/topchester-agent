# Route-Aware Context Accounting And Automatic Compaction

## Summary

Give Topchester an honest, route-aware view of active model context and a safe automatic-compaction path that works with direct providers, OpenRouter, Codex OAuth, custom OpenAI-compatible endpoints, and proxies such as VibeProxy.

The target state separates three values that are currently easy to conflate:

- cumulative session or turn usage, used for cost and workload reporting
- active prompt usage, used to show how much context the next request will consume
- model capacity, used as the denominator and resolved for the exact provider, base URL, and model route

Topchester should show percentages and remaining space only when capacity is known or explicitly configured. Estimated values must carry `~`; assumed or catalog-derived capacity must expose its provenance. An unknown proxy route should show `ctx ~74k/?`, not a fabricated percentage.

Automatic compaction should combine proactive preflight checks with one bounded reactive recovery path:

1. Estimate the fully rendered request before every model call, including tool-loop continuations.
2. Prune replaceable old tool output first.
3. Summarize older completed turns only when pruning is insufficient.
4. Preserve the recent conversation and current task state.
5. On a recognized context-overflow error, learn an exact reported maximum or conservative numeric ceiling when available, compact, and retry once.

The visible session transcript remains complete. Compaction changes only the model-facing conversation projection and is persisted as an explicit session event so resume, restore, fork, and subagent sessions recover the same active context.

## Decisions

- Key capacity by `(providerId, normalized baseURL, modelId)`. A model id alone is not a route identity.
- Treat a custom proxy route as distinct from the direct provider even when it uses a familiar Codex or OpenAI model id.
- Keep cumulative token/cost totals separate from active context usage. Never drive a context percentage from `TurnTokenUsageTotals`.
- Use provider-reported input or prompt tokens as the latest active-prompt snapshot. Cache reads and writes are a breakdown of input accounting, not extra context to add again.
- Estimate only content added after the latest provider snapshot when an exact request-base fingerprint still matches. A route/model change or any change to system text, project instructions, tool schemas, images, or previously rendered segments invalidates the snapshot and requires a complete provider-bound request estimate.
- Keep token estimation behind an interface. V0 may use a conservative text/image/tool approximation; a model tokenizer can replace it without changing runtime policy.
- Resolve explicit config as authoritative. Without config, choose the best base candidate from trusted live route metadata, trusted direct-provider catalog, an explicit assumption, or unknown; then apply an exact error-reported maximum or conservative inferred ceiling as a non-raising cap to that non-config candidate. A learned ceiling may be the only known capacity when no other candidate exists.
- Never deliberately fill a context window to discover its size.
- Do not silently turn generic fallbacks such as 128k, 200k, or 256k into authoritative UI values.
- Allow an internal assumed capacity only when explicitly configured as policy. Label it `assumed`, apply a larger safety margin, and never persist it as learned provider truth.
- Add explicit per-model limits under the provider that owns the route. Do not duplicate limits across `agent.primary`, `agent.fast`, `kb.summarize`, and `fallback` assignments.
- V0 summary generation uses the active `agent.primary` route with tools disabled. On a model downshift, use the previous capable `agent.primary` route before committing the switch when the new route cannot accept the current projection. A separate compaction-model purpose is out of scope until summary-quality and cross-model compatibility are measured.
- Preserve exact prompt rendering before compaction. The structured prompt refactor must have golden tests proving it does not change provider-bound text or tool definitions when no pruning or compaction occurs.
- Keep the complete transcript in session history. Maintain a separate model-context projection consisting of the latest summary, retained turns, and messages after the compaction boundary.
- Persist every compacted model-context projection as a replayable snapshot. Transcript event references are sufficient for completed user/final-assistant turns, but retained current-turn content that is not otherwise durable, including pruned tool results and continuation state, must be stored inline in the snapshot.
- Keep persisted tool-call rows display-only across completed turns, matching current behavior. Structured prompt work must not start reinjecting historical tool rows into later model requests unless a separately planned behavior change explicitly adopts that contract.
- Never orphan a tool call from its result. Tool pruning operates on associated units and replaces removed results with deterministic stubs.
- Run `PreCompact` before summary generation or model-context mutation. Hook context becomes summary guidance; `block` cancels compaction and `stop` ends the turn.
- If a hook blocks compaction while the request is above the hard prompt budget, do not send the unsafe request. Return an actionable error instead.
- Check the budget before every model request, not only between user turns. Tool results can cross the threshold during one turn.
- Compact only at a legal provider-call boundary: before the first call or after all selected tools, approvals, and hooks for the previous call have settled. Never mutate context while a tool, approval, hook, or model request is pending.
- `/compact [focus]` is an idle-only forced checkpoint. While a turn or compaction is active, return a visible busy error rather than queueing, aborting, or racing the operation.
- If the previous route needed for a model-downshift compaction is unavailable, leave the current model selection unchanged and return actionable `/compact` or `/new` guidance; do not ask the smaller route to summarize an already oversized projection.
- Use hysteresis: trigger near the upper budget, compact toward a substantially lower target, and reject repeated ineffective compactions.
- Apply the same accounting and compaction engine to root and subagent runtimes. Only the root TUI needs a persistent status display.
- Land the automatic trigger disabled until manual compaction, persistence, overflow recovery, and smoke coverage are green. Enable it by default only in the final rollout slice.

## Scope

Included:

- route-aware model-capacity types and resolution
- explicit per-provider, per-model capacity config
- active prompt-token snapshots and local trailing estimates
- a context budget with output reserve and uncertainty margin
- context status in the OpenTUI status bar
- detailed `/context` diagnostics
- manual `/compact` for proving and operating the compactor
- structured prompt segments for conversation, runtime context, tool output, and continuation instructions
- deterministic old-tool-output pruning
- iterative structured conversation summarization
- proactive threshold compaction before model calls
- reactive overflow classification, compact, and one retry
- numeric limit learning scoped to the exact route
- `PreCompact` payload and control-flow integration
- session persistence and rehydration for compacted model context
- resume, restore, fork, new-session, and subagent behavior
- config, runtime, session, TUI, hook, documentation, fake-provider, and smoke coverage

Out of scope:

- provider-side prompt caching policy changes
- changing existing cumulative usage or cost display semantics
- destructive removal of old transcript events
- a general-purpose tokenizer dependency in the first slice
- deliberate live overflow probing
- automatically writing discovered limits into `topchester.jsonc`
- a separate `agent.compact` model purpose in V0
- compaction of one-shot `agent.fast` or `kb.summarize` requests
- cloud synchronization of learned route metadata
- guaranteeing a context percentage for proxies that expose neither limits nor numeric overflow information

## Current State

### Usage accounting

`src/model/index.ts` normalizes provider usage into `ModelTokenUsage` with input, output, total, cache, and cost fields. `src/agent/runtime/index.ts` adds every model call in one tool-loop turn into `TurnTokenUsageTotals`, and `src/agent/runtime/format.ts` optionally renders those cumulative values in assistant metadata.

That is valid cost/work accounting but not an active-context snapshot. Reusing it for context display would overcount every multi-step turn and would continue growing after compaction.

### Capacity metadata

Provider config currently has no context-window, input-limit, or output-limit contract. OpenRouter model discovery receives `context_length`, but `src/model/openrouter.ts` uses it only in picker descriptions and does not retain it for runtime policy.

An OpenAI-compatible response can report prompt usage without reporting the route's maximum context. A known model name behind VibeProxy therefore does not prove the real upstream limit.

### Prompt construction

`src/agent/conversation.ts` flattens retained user and assistant turns into one string. `src/agent/runtime/index.ts` then appends KB context, hook context, tool results, steering, and continuation instructions into `nextPrompt`.

This makes request-size estimation possible but makes selective pruning and safe compaction difficult. Once segments are concatenated, their ownership and retention policy are lost.

Completed-turn model context intentionally excludes persisted `tool_call` display rows. During an active turn, tool results and continuation text exist only inside the mutable `nextPrompt`; session events do not contain enough information to reconstruct that provider-facing state. Prompt parity must preserve the completed-turn exclusion, while mid-turn compaction must persist any retained active-turn segments inside the model-projection snapshot.

### Session and TUI state

`TuiViewStore.getConversationTurns()` reconstructs model context from visible transcript entries. `rehydrateSession()` reconstructs the same transcript from append-only session events. There is no separate compacted model projection.

The OpenTUI status bar shows status, workspace, model, queued messages, optional session id, notices, and KB state. It has no context state or provenance display.

### Hooks

`PreCompact` is configured and `TopchesterAgentRuntime.runPreCompactHooks()` exists, but documentation correctly says there is no automatic compaction path. Its current payload contains only a human-readable reason and does not expose the route, token budget, threshold, or compaction mode.

## Research Constraints

The competitor review establishes these design constraints:

- Pi and Codex combine the latest provider usage with local estimates for messages added afterward.
- OpenCode and Kilo calculate a usable prompt budget after reserving output space; Kilo presents used, reserved, and available space separately.
- Codex performs proactive checks and also compacts during multi-step work when a follow-up request is pending.
- Cline and Pi recover reactively from provider overflow errors.
- Hermes is the strongest custom-provider implementation because it probes route metadata, estimates the complete request, and learns conservative numeric ceilings from errors.
- OpenClaw distinguishes cached actual usage from a pre-prompt estimate and performs cheap tool truncation before expensive summarization.
- Every implementation still depends on configuration, metadata, a catalog, or an assumption for the denominator. Normal completion usage alone does not reveal maximum capacity.

## Target Behavior

| Situation                                           | Target behavior                                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact route limits configured                       | Treat config as authoritative and show used, total, safe remaining, and `config` provenance.                                                          |
| Trusted `/models` response includes a context field | Cache it for the exact route, label it `provider`, and use it until its freshness policy expires.                                                     |
| Direct provider has trusted catalog metadata        | Use it with `catalog` provenance. Do not apply direct-provider authority to a custom base URL.                                                        |
| VibeProxy route has explicit limits                 | Use those limits regardless of whether the model id resembles a Codex model.                                                                          |
| VibeProxy `/models` omits limits                    | Keep capacity unknown and prompt once through `/context` guidance to configure `modelLimits`.                                                         |
| Provider usage is present                           | Store input tokens with the request-base fingerprint; estimate only later retained segments while that fingerprint still matches.                     |
| Provider usage is absent                            | Estimate the complete rendered request, prefix the UI with `~`, and apply the larger uncertainty margin.                                              |
| Capacity is unknown                                 | Show `ctx ~used/?`; disable percentage-based proactive summary compaction; retain deterministic size guards and reactive overflow recovery.           |
| Numeric overflow maximum is returned                | Record the exact reported maximum or conservative ceiling for the exact route, recompute the budget, compact, and retry once.                         |
| Overflow contains no numeric limit                  | Prune and compact from the current estimate, retry once, and keep capacity unknown.                                                                   |
| Tool output crosses the threshold                   | Check before the continuation request and compact inside the same turn.                                                                               |
| Model changes to a smaller route                    | Evaluate before committing the override; compact with the previous capable route if required, or leave the previous model selected on failure.        |
| Manual `/compact [focus]` while idle                | Force a persisted checkpoint when compactable history exists, even below the automatic threshold; otherwise report a successful no-op.                |
| Manual `/compact` while busy                        | Reject visibly without queueing, aborting, or racing the active operation.                                                                            |
| Compaction succeeds                                 | Keep the full visible transcript, persist a compaction snapshot, and display the post-compaction estimate with `~` until refreshed by provider usage. |
| Compaction saves too little twice                   | Stop automatic attempts for the turn and show an actionable `/compact <focus>` or `/new` hint.                                                        |
| Resume, restore, or fork                            | Rehydrate the latest compacted model projection and context status before the first request.                                                          |
| New session                                         | Start with no summary, no learned session snapshot, and route capacity resolved from current config/metadata.                                         |
| Narrow terminal                                     | Collapse context detail by priority without relying on color or causing the status line to wrap.                                                      |

## Configuration Contract

Use provider-owned model limits because the provider id and base URL define the route:

```jsonc
{
  "providers": {
    "vibeproxy": {
      "type": "openai-compatible",
      "baseURL": "http://127.0.0.1:8317/v1",
      "discoverModelLimits": false,
      "modelLimits": {
        "gpt-5.4": {
          "contextWindow": 272000,
          "maxInputTokens": 240000,
          "maxOutputTokens": 32000,
        },
      },
    },
  },
  "compaction": {
    "enabled": true,
    "thresholdPercent": 85,
    "targetPercent": 40,
    "reserveTokens": 16384,
    "keepRecentTokens": 16000,
    "maxCompactionsPerTurn": 2,
    "learnProviderLimits": true,
  },
}
```

Rules:

- `modelLimits` keys are exact provider model ids after Topchester resolves the configured assignment.
- All token fields are positive integers.
- `maxInputTokens` and `maxOutputTokens` may refine `contextWindow`; do not require their sum to equal the window because provider contracts differ.
- `thresholdPercent` and `targetPercent` must be between 1 and 100, and `targetPercent` must be lower than `thresholdPercent`.
- Explicit `reserveTokens` wins over the default output reserve only for a shared context window and is clamped so the minimum prompt budget remains positive. It is not subtracted from an already separate `maxInputTokens` ceiling.
- `discoverModelLimits` defaults to `false` for generic OpenAI-compatible providers. Known direct-provider adapters may reuse metadata they already fetch without enabling generic endpoint probing.
- Omitted `compaction` fields use documented defaults.
- Do not add environment-variable duplicates for each field in V0.
- Discovery and learned values live in atomic workspace state under `.agents/topchester/`, not inside immutable loaded JSONC.

## Core Types

The exact file split may change, but preserve these boundaries:

```ts
interface ContextRoute {
  providerId: string;
  baseURL: string;
  modelId: string;
}

interface ContextCapacity {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  source: "config" | "provider" | "catalog" | "error-reported" | "error-inferred" | "assumed" | "unknown";
  confidence: "authoritative" | "reported" | "catalog" | "inferred" | "assumed" | "unknown";
  observedAt?: string;
}

interface ContextUsageSnapshot {
  promptTokens: number;
  trailingEstimatedTokens: number;
  source: "provider" | "local-estimate";
  estimated: boolean;
  route: ContextRoute;
  asOfModelCall: number;
}

interface ContextBudget {
  capacity: ContextCapacity;
  usedTokens: number;
  hardPromptBudget?: number;
  compactAtTokens?: number;
  targetTokens?: number;
  reserveTokens?: number;
  safeRemainingTokens?: number;
  uncertaintyTokens: number;
}
```

`ContextCapacity` is route capability. `ContextUsageSnapshot` is session state. `ContextBudget` is a derived decision and should not become another independently mutable source of truth.

## Budget Policy

For known capacity:

```text
baseline reserve = min(16,384, max(1,024, floor(contextWindow * 0.25)))

reserve candidate = configured reserve
                 OR max(model max-output limit when known, baseline reserve)

minimum prompt budget = min(4,096, floor(contextWindow * 0.50))

effective output reserve = min(reserve candidate,
                               contextWindow - minimum prompt budget)

shared-window input budget = contextWindow - effective output reserve

hard prompt budget = minimum of every defined authoritative input ceiling:
                     maxInputTokens and shared-window input budget

soft trigger = floor(hard prompt budget * thresholdPercent / 100)
             - estimation uncertainty

target after compaction = floor(hard prompt budget * targetPercent / 100)
```

If only `maxInputTokens` is known, it is the hard prompt budget and no shared-window reserve is subtracted from it. If both `maxInputTokens` and `contextWindow` are known, use the lower derived ceiling. Never subtract the output reserve twice. Clamp every derived value to a positive integer and reject configurations where the target is not below the soft trigger or the effective hard budget cannot fit the minimum prompt budget.

Initial uncertainty policy:

- define `capacityBasis = contextWindow ?? maxInputTokens`
- fresh provider input snapshot plus estimated trailing segments: `max(2,000, 2% of capacityBasis)`
- complete local estimate or assumed capacity: `max(4,000, 5% of capacityBasis)`
- exact configured `maxInputTokens` remains the hard ceiling even when percentage policy would allow more

Required policy fixtures:

| Capacity shape                            | Required assertion                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `contextWindow` only                      | Reserve is subtracted once and the trigger/target are percentages of the resulting hard prompt budget. |
| `maxInputTokens` only                     | The explicit input limit is the hard prompt budget without another output subtraction.                 |
| Both input and shared-window limits       | The lower ceiling wins.                                                                                |
| Configured reserve                        | It wins over the default but is clamped so a positive minimum prompt budget remains.                   |
| Small 8k window                           | Defaults remain positive; a 16k reserve is never fabricated.                                           |
| Requested/model output above the baseline | The larger output requirement is reserved when a shared window is known.                               |

These are starting defaults, not provider facts. Put them in one tested policy module so later tuning does not spread constants across runtime and TUI code.

When capacity is unknown, produce usage diagnostics but no percentage trigger. Retain hard byte/message safeguards and reactive overflow recovery.

## Prompt And Context Architecture

Replace mutable string concatenation with structured segments that render at the provider boundary:

```text
visible transcript/session events
            |
            +--> model-context projection
                    - previous structured summary, if any
                    - retained completed turns
                    - current user turn
            |
            +--> per-request runtime segments
                    - project instructions/system prompt
                    - KB and hook context
                    - tool definitions
                    - current-turn tool calls/results
                    - steering and continuation instructions
            |
            +--> render exactly once
                    - estimate rendered request
                    - prune/compact if required
                    - send to provider
                    - record provider prompt usage
```

Each segment needs a stable kind, retention policy, optional tool association, and deterministic renderer. The first structured-prompt slice must preserve current output byte-for-byte when no compaction operation is requested.

Request accounting also needs a stable fingerprint over the route/model plus every provider-bound component that existed at the last provider usage snapshot: system prompt, project instructions, model-context projection, runtime context, tool definitions, images, and provider options that affect serialization. A later call may add trailing segments to that snapshot only when the base fingerprint matches; otherwise estimate the fully rendered request again.

Parity invariants:

- Completed-turn model context continues to include normal user and final-assistant transcript messages only.
- Persisted tool-call display rows, hook statuses, choices, reasoning, assistant metadata, and other visible-only records remain excluded.
- Current-turn tool results and continuation instructions remain provider-visible exactly where they are today.
- Native-tool and text-JSON/text-XML fallback routes get separate golden fixtures when their serialized requests differ.
- Structured segments may improve ownership and accounting, but they must not silently convert Topchester's current single-prompt protocol into a provider-native multi-message/tool-history protocol.

## Compaction Algorithm

### Stage 1: Deterministic pruning

- Protect the current user request and all current-turn tool activity required for the next call.
- Protect the newest two complete user/assistant turns.
- Protect up to `keepRecentTokens` from the tail.
- Replace old large read/search/web/command results with deterministic stubs containing tool name, stable identifiers, path or command, success/error state, and a concise retained outcome.
- Deduplicate repeated file reads when a newer result represents the same path and content hash.
- Preserve mutation evidence such as changed paths, patch outcome, command exit code, and validation failures.
- Never leave an unmatched tool result or remove the only record of a still-pending tool request.

### Stage 2: Structured summary

Fold the previous summary and newly compactable completed turns into a schema with these headings:

- Goal
- User constraints and preferences
- Decisions and rationale
- Completed work
- Current work and blockers
- Files read or changed
- Exact identifiers, commands, errors, and verification results
- Settled current-turn tool outcomes and continuation state
- Next steps

Keep the retained recent tail verbatim. Treat the summary as model context, not visible assistant speech.

If the summary request itself is too large, summarize older chunks independently and fold their summaries. If model summary generation fails, retain deterministic pruning and either keep the old projection or create an explicitly marked deterministic handoff; never silently discard the middle conversation.

### Hysteresis and loop protection

- Compact toward the target budget, not just below the trigger.
- Require at least 15% savings before counting a pass as effective.
- Do not compact again until meaningful new context has been added unless the provider returns an overflow.
- Allow at most two compactions per user turn and one provider retry after overflow.
- Log before/after estimates, capacity source, reason, retained boundary, savings, and retry count.

### Legal operation boundaries

- Automatic compaction may run before the first model call or after the previous call's selected tools, approvals, and hooks have all settled, immediately before the next model call.
- It may not run while a model request, tool, approval, hook, session switch, or another compaction is active.
- Manual `/compact [focus]` always forces a checkpoint when there is compactable completed history, even below the automatic threshold. It is available only while the session is idle; otherwise return `Compaction unavailable while a turn is active.` without queueing or cancelling work.
- A manual no-op is successful and visible when there is no compactable history or the projection is already only a summary plus its protected tail.
- Model downshift is a two-phase operation: evaluate the pending route first, compact with the previous route when required, persist the new projection, and only then commit the model override. On compaction failure, keep the previous model selected.
- No compaction boundary may preserve a pending tool request without its settled result. Pending approval state is never summarized because compaction cannot run while approval is open.

## Session Contract

Add backward-compatible session event kinds for context state and compaction. A compaction event is the authoritative replayable model-projection snapshot, not merely a summary marker. Suggested shape:

```ts
interface ContextUsageEvent {
  kind: "context_usage";
  route: ContextRoute;
  usage: ContextUsageSnapshot;
  capacity: ContextCapacity;
}

interface ContextCompactionEvent {
  kind: "context_compaction";
  projectionVersion: 1;
  reason: "manual" | "threshold" | "overflow" | "model-switch";
  focus?: string;
  projection: {
    summary: string;
    segments: Array<
      | { kind: "transcript_ref"; eventId: number }
      | {
          kind: "inline";
          segmentKind: "current_user" | "tool_result" | "hook_context" | "steering" | "continuation";
          text: string;
          toolAssociationId?: string;
        }
    >;
  };
  retainedFromEventId?: number;
  beforeTokens: number;
  afterEstimatedTokens: number;
  route: ContextRoute;
  capacity: ContextCapacity;
}
```

The exact segment union may evolve during Slice 4, but it must preserve these invariants:

- Every `transcript_ref` resolves to an earlier durable normal user or final-assistant message event.
- Any provider-visible current-turn content that cannot be reconstructed from durable transcript events is stored inline after pruning, including the text needed to continue after a tool call.
- Per-request system text, project instructions, KB lookup results, tool definitions, and other freshly recomputed runtime segments are not frozen into the session projection unless they are already part of the current conversation contract.
- Replay fails closed with an actionable session error when a snapshot is malformed or references a missing event; it never falls back silently to the full pre-compaction transcript.
- Context usage may be a separate event or part of the projection snapshot, but there is one authoritative latest projection during replay.

Required behavior:

- `rehydrateSession()` returns both the complete visible transcript and the latest model-context projection.
- `TuiViewStore` stores the projection separately instead of rebuilding it from every visible transcript entry.
- A live compaction event updates the projection and context display without deleting transcript rows.
- Normal subsequent user/final-assistant messages extend both transcript and projection; persisted display-only tool rows remain excluded after the turn completes.
- Restore swaps projection and context state with the selected session.
- Fork inherits source events and can compact independently afterward.
- `/new` resets the projection and usage snapshot.
- Old sessions without context events retain today's full-transcript behavior.
- Subagent sessions persist their own projections under their existing session tree.
- A session restored after mid-turn compaction reconstructs the exact retained summary, transcript references, pruned/stubbed tool results, and continuation state without depending on process memory.

## Hook Contract

Extend `PreCompact` with structured fields while preserving existing common payload fields:

```json
{
  "reason": "threshold",
  "mode": "automatic",
  "route": {
    "providerId": "vibeproxy",
    "baseURL": "http://127.0.0.1:8317/v1",
    "modelId": "gpt-5.4"
  },
  "usage": {
    "usedTokens": 104000,
    "estimated": true
  },
  "budget": {
    "contextWindow": 128000,
    "compactAtTokens": 102000,
    "targetTokens": 51000,
    "capacitySource": "config"
  }
}
```

Hook semantics:

- `context` strings become additional summary guidance.
- `block` cancels this compaction attempt.
- `stop` ends the active turn through existing stop semantics.
- A blocked hard-overflow preflight does not proceed with the unsafe provider request.
- Hook status events remain visible and persisted as they are today.
- Hook failures follow the existing hook-process failure contract; do not invent a separate silent fallback.

## TUI And Command Design

Add context state to `TuiViewState` and render it in the existing status bar with priority collapse.

Suggested wide display:

```text
ctx ~74k/128k · 58% used · 34k safe
```

Responsive forms:

| Terminal width          | Display                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| 120 columns or wider    | `ctx ~74k/128k · 58% · 34k safe`                                  |
| 96-119                  | `ctx 58% · 34k safe`                                              |
| 80-95                   | `ctx 58%` or `ctx ~74k/?`                                         |
| Below supported minimum | Follow the TUI minimum-size behavior; do not wrap the status bar. |

Priority rules:

- Status, model, and actionable near-limit context state outrank the session-id suffix.
- Normal context detail may collapse before KB warnings or current status.
- Use `~` for estimates and `?` for unknown capacity.
- Use semantic muted/warning/error theme slots, but pair them with text such as `safe`, `compact soon`, or `limit` so color is not the only signal.
- Do not add animation or a continuously moving gauge.
- Verify at 80x24, 120x40, and 200x60, in monochrome/`NO_COLOR`, and after live resize.

Add `/context` for the complete diagnostic view:

```text
route: vibeproxy/gpt-5.4 @ http://127.0.0.1:8317/v1
active prompt: ~74,120 tokens (provider snapshot + local estimate)
capacity: 128,000 tokens (config, authoritative)
output reserve: 16,384 tokens
automatic compaction: 102,000 tokens
safe remaining: 27,880 tokens
compactions: 1 this session, 0 this turn
```

Add `/compact [focus]` as the manual proof and recovery surface. The optional focus text becomes summary guidance and does not enter normal conversation as a user claim.

## Error Classification And Proxy Learning

Add a provider-neutral overflow classifier close to model error normalization. It should recognize structured status/code data first and message patterns second.

Rules for learned limits:

- Accept only positive numeric maxima or ceilings from an error that is confidently classified as context overflow. Preserve whether the value was explicitly reported or inferred.
- Scope the value to exact provider id, normalized base URL, and model id.
- A learned ceiling may lower an existing catalog, provider-reported, or assumed value; it must never override a lower explicit config value or raise capacity.
- Record source text or provider code for diagnostics, but never persist headers, API keys, prompts, or response bodies.
- Use a freshness/TTL policy and invalidate learned state when the route's configured base URL changes.
- Keep learned state under `.agents/topchester/` or the existing session state boundary; do not mutate user config automatically.
- If an error has no numeric limit, recovery may still compact and retry, but capacity remains unknown.

For generic `/models` discovery:

- Reuse metadata from endpoint calls Topchester already makes before adding new network activity.
- Parse a small documented allowlist such as `context_length`, `context_window`, `max_context_length`, and explicit input/output fields.
- Treat arbitrary or conflicting fields as unknown and log diagnostics.
- Make unsolicited probing of generic custom endpoints opt-in.
- Trust known direct-provider metadata according to provider-specific adapters; treat a custom proxy's response as route-reported, not as proof of the public model's canonical limit.

## Files To Add

Likely additions; keep the final module split small if neighboring responsibilities fit together:

- `src/agent/context/types.ts`
  - route, capacity, usage, budget, provenance, and compaction-result types
- `src/agent/context/capacity.ts`
  - route-key normalization, precedence, config/live/catalog/learned resolution
- `src/agent/context/estimate.ts`
  - provider-bound request estimator and uncertainty policy
- `src/agent/context/prompt.ts`
  - structured prompt segments and parity renderer
- `src/agent/context/projection.ts`
  - versioned replayable model-projection snapshots, transcript references, inline current-turn segments, and validation
- `src/agent/context/compaction.ts`
  - pruning, summarization, target selection, and loop protection
- `src/agent/context/overflow.ts`
  - provider-neutral overflow classification and numeric-limit extraction
- `src/chat/context-status.ts`
  - status formatting and `/context` diagnostic text
- focused tests matching the final module boundaries
- `test/context-projection.test.ts`
- one deterministic fake-provider smoke scenario under `scripts/smoke/scenarios/`

## Files To Change

- `src/config/index.ts`
  - add `providers.<id>.modelLimits` and top-level compaction policy validation
- `src/app/context.ts`
  - own the route-capacity registry and atomic `.agents/topchester/` learned workspace state without mixing it into immutable base config
- `src/model/index.ts`
  - preserve last-call prompt usage semantics and expose normalized errors/route metadata
- `src/model/openrouter.ts`
  - retain discovered limits instead of using `context_length` only as picker text
- `src/model/codex.ts`
  - preserve structured Codex usage and overflow information
- `src/agent/conversation.ts`
  - move from flat-only rendering to structured model-context projection
- `src/agent/runtime/index.ts`
  - preflight every call, orchestrate pruning/compaction/hooks/retry, and emit context events
- `src/agent/runtime/model.ts`
  - pass rendered request metadata through the single model-call boundary
- `src/agent/events.ts`
  - add context usage and compaction runtime events
- `src/agent/commands.ts`
  - add `/context` and `/compact`
- `src/agent/hooks.ts`
  - document and type the extended `PreCompact` payload
- `src/session/events.ts`
  - add context event schemas
- `src/session/runtime-payloads.ts`
  - map context runtime events to session payloads
- `src/session/store.ts`
  - rehydrate full transcript plus compacted model projection and latest context state
- `src/chat/controller-state.ts`
  - store model projection separately and expose context status to views
- `src/chat/controller.ts`
  - apply context events and handle manual commands, restore, fork, and new
- `src/chat/suggestions.ts`
  - expose `/context` and `/compact`
- `src/tui/opentui/status-bar.tsx`
  - render responsive context state with semantic tones and non-color labels
- `test/config.test.ts`
- `test/model.test.ts`
- `test/codex-provider.test.ts`
- `test/agent-runtime.test.ts`
- `test/commands.test.ts`
- `test/hooks.test.ts`
- `test/session.test.ts`
- `test/tui-controller.test.ts`
- `test/opentui-state.test.ts`
- `scripts/opentui/production-test.tsx`
- `docs/configuration/models-and-providers.md`
- `docs/reference/model-config.md`
- `docs/reference/config-schema.md`
- `docs/features/sessions.md`
- `docs/features/slash-commands.md`
- `docs/features/tui.md`
- `docs/hooks/events.md`
- `docs/hooks/payloads.md`
- `docs/reference/changelog.md`

## Cross-Slice Rules

- Preserve existing cumulative usage and cost output.
- Never count cache tokens twice.
- Never show an authoritative percentage with an unknown or unqualified denominator.
- Never apply a direct-provider model limit to a different base URL without provenance.
- Preserve exact prompt behavior until a slice explicitly performs pruning or compaction.
- Preserve completed-turn context behavior: durable tool-call display rows remain excluded from later model requests.
- Keep transcript persistence append-only and backward compatible.
- Treat a compacted projection snapshot as authoritative replay state; never reconstruct it from the full visible transcript after a snapshot exists.
- Do not lose exact file paths, identifiers, errors, settled continuation state, or validation state during summarization. Compaction never runs while an approval is pending.
- Keep tool calls and results associated through pruning and compaction.
- Keep compaction policy out of OpenTUI components; the UI renders derived state only.
- Keep provider discovery and error parsing out of the session store.
- Do not make network calls merely to render the status bar.
- Bound every automatic retry and compaction loop.
- Run compaction only at the legal provider-call boundaries defined above, and keep manual compaction idle-only.
- Add structured logs for capacity source, estimation source, thresholds, trigger reason, savings, and retry decisions without logging prompt content.
- Before marking any slice done, run its focused verification followed by `mise run test` and `mise run local-ci` as separate commands. Record the exact commands and dates; do not infer the test gate from `local-ci`, which excludes tests.
- Update this plan after every completed slice with actual files, findings, and exact verification commands.

## Slices

### Slice 1: Route Capacity And Policy Contracts

Status: `[x]` Completed on 2026-08-26

Goal: Define route-aware capacity, provenance, and compaction policy as pure tested contracts without changing runtime behavior.

Why here: Every display and trigger depends on an honest denominator. Starting with config and resolution prevents UI or compaction code from inventing its own model limits.

This slice should implement:

- Add validated `modelLimits` and compaction config schemas.
- Define route, capacity, source, confidence, usage, and budget types.
- Normalize route keys by provider id, normalized base URL, and resolved model id.
- Implement pure capacity resolution: explicit config wins; otherwise select provider metadata, catalog metadata, explicit assumption, or unknown as the base and apply exact reported maxima/conservative inferred ceilings only as non-raising caps.
- Reject learned ceilings that raise capacity or override a lower explicit config value.
- Add budget-policy helpers and one source for reserve, threshold, target, and uncertainty defaults.
- Add the required shared-window, separate-input, combined-limit, configured-reserve, small-window, and large-output fixtures from Budget Policy.
- Keep automatic compaction disabled and leave UI unchanged.

Expected output:

- Config can express VibeProxy-specific limits without pretending the model is a direct Codex route.
- Unknown capacity is a first-class state.
- Policy math and provenance precedence have focused unit coverage.

Verification:

```sh
vp test run test/config.test.ts test/context-capacity.test.ts
mise run test
mise run local-ci
```

Dependencies: none.

### Slice 2: Active Prompt Accounting And Request Estimation

Status: `[x]` Completed on 2026-08-26

Goal: Produce a correct active-context snapshot at the provider boundary while retaining existing cumulative turn totals.

Why here: The numerator must be trustworthy before it is displayed or allowed to trigger compaction.

This slice should implement:

- Normalize provider input usage as last-call prompt usage and document cache semantics.
- Add a request estimator covering system prompt, rendered conversation, KB/hook context, tools, images, and current tool results.
- Compute and retain a request-base fingerprint over route/model, system text, project instructions, prior model projection, runtime context, tools, images, and serialization-affecting provider options.
- Use the last provider prompt snapshot plus estimates only for retained content appended afterward when that fingerprint still matches.
- Fall back to estimating the entire request when usage is missing or stale.
- Treat route/model changes, project-instruction changes, tool-schema changes, image changes, and any changed prior segment as stale-snapshot cases.
- Mark every result with source, freshness, and estimated state.
- Emit context-usage runtime events, but do not persist or render them yet.
- Add logs that expose counts and sources without prompt content.

Expected output:

- A multi-call tool turn has separate session totals and active prompt usage.
- Cache read/write breakdown cannot inflate the active prompt.
- Missing-usage proxies still receive a conservative estimate.

Verification:

```sh
vp test run test/model.test.ts test/codex-provider.test.ts test/context-estimate.test.ts test/agent-runtime.test.ts
mise run test
mise run local-ci
```

Dependencies: Slice 1.

### Slice 3: Honest Context Display And Diagnostics

Status: `[x]` Completed on 2026-08-26

Goal: Expose active context, safe remaining space, and provenance without enabling automatic compaction.

Why here: Shipping observability first validates accounting against real routes and gives users a way to diagnose proxy metadata before automatic behavior depends on it.

This slice should implement:

- Add context state to controller/view snapshots.
- Apply context-usage events without adding them to model context.
- Add responsive status-bar formatting and warning states.
- Add `/context` with route, source, freshness, reserve, trigger, safe remaining, and configuration guidance.
- Show `~used/?` and no percentage when capacity is unknown.
- Reset or recompute display on model switch, restore, and new session.
- Add 80x24, 120x40, 200x60, resize, `NO_COLOR`, and unknown-capacity render coverage.

Expected output:

- Users can distinguish active context from cumulative assistant metadata.
- VibeProxy users can see exactly why remaining context is unknown and where to configure it.
- The status bar remains one line and degrades by priority.

Verification:

```sh
vp test run test/commands.test.ts test/tui-controller.test.ts test/opentui-state.test.ts
mise run opentui-test
mise run test
mise run local-ci
```

Manual checks:

1. Resize through 80, 96, 120, and 200 columns.
2. Verify estimated, exact, warning, limit, and unknown forms remain readable without color.
3. Confirm session id collapses before actionable near-limit context state.

Dependencies: Slices 1 and 2.

### Slice 4: Canonical Prompt Segments And Byte-Parity Renderer

Status: `[x]` Completed on 2026-08-26

Goal: Replace opaque prompt concatenation with structured provider-bound segments without changing any request or user-visible behavior.

Why here: Accounting and later compaction need stable ownership boundaries, but that refactor must land and prove parity before it also starts deleting context.

This slice should implement:

- Introduce structured segment types and a single provider-bound renderer.
- Preserve existing prompt and tool-definition output byte-for-byte.
- Represent completed transcript turns, current user input, KB/hook context, current-turn tool results, steering, and continuation instructions with stable kinds and retention metadata.
- Keep completed-turn persisted tool rows display-only and excluded from model context.
- Add stable request-base fingerprinting for provider usage snapshot reuse.
- Add golden fixtures for the initial request, serial and parallel tool continuations, native tools, text-JSON/text-XML fallback, KB context, hook context, steering, and project-instruction changes.
- Do not add pruning, summarization, persistence changes, or new commands.

Expected output:

- Prompt assembly has explicit ownership boundaries and a deterministic renderer.
- Any unintended normal-request change fails a golden test.
- Provider usage snapshots are invalidated when any prior provider-bound request component changes.

Verification:

```sh
vp test run test/agent-runtime.test.ts test/context-prompt.test.ts test/model.test.ts
mise run test
mise run local-ci
```

Dependencies: Slice 2.

### Slice 5: Replayable Model-Projection Persistence

Status: `[x]` Completed on 2026-08-26

Goal: Add the backward-compatible session schema and replay machinery required to persist a compacted projection exactly, without exposing compaction yet.

Why here: Manual or automatic compaction must not ship until restore can reproduce both completed-turn references and retained current-turn continuation state.

This slice should implement:

- Add versioned `context_usage` and authoritative `context_compaction` projection snapshot schemas.
- Support transcript references for durable user/final-assistant messages and inline retained segments for provider-visible current-turn state that is not otherwise durable.
- Validate missing references, malformed ordering, unmatched tool associations, and unsupported projection versions with actionable failures.
- Make `rehydrateSession()` return the complete visible transcript plus the latest model-context projection and context state.
- Store the projection separately in `TuiViewStore`; old sessions without snapshots retain today's full-transcript behavior.
- Add internal/test-only snapshot application for live, restore, fork, new, and subagent session trees without adding `/compact`.
- Prove that persisted display-only tool rows are not reinjected after a completed turn.

Expected output:

- A synthetic compacted session, including retained current-turn tool results and continuation text, replays identically after process restart.
- Old sessions remain backward compatible.
- No user-visible compaction path exists yet.

Verification:

```sh
vp test run test/session.test.ts test/tui-controller.test.ts test/context-projection.test.ts test/agent-runtime.test.ts
mise run test
mise run local-ci
```

Dependencies: Slice 4.

### Slice 6: Deterministic Context Pruning

Status: `[x]` Completed on 2026-08-26

Goal: Add a cheap, non-LLM pruning operation over canonical prompt units while leaving runtime triggers disabled.

Why here: Pruning should be independently reviewable from the prompt refactor and summary model behavior, and it should be available to reduce summary requests before manual compaction lands.

This slice should implement:

- Add deterministic pruning for replaceable current-turn tool results and repeated reads.
- Protect the current user request, newest two complete turns, configured recent-token tail, mutation evidence, validation failures, and settled continuation state.
- Replace removed results with deterministic stubs containing tool identity, association id, path or command, success/error state, and retained outcome.
- Never create unmatched tool associations or pull completed-turn display-only tool rows into model context.
- Return before/after estimates, savings, retained boundaries, and structured diagnostics.
- Keep pruning internal/test-only; do not trigger it automatically or expose a command.

Expected output:

- Large replaceable tool output can be reduced without a model call.
- Pruned output remains replayable through the Slice 5 projection format.
- Prompt behavior remains unchanged unless a test explicitly invokes pruning.

Verification:

```sh
vp test run test/context-prompt.test.ts test/context-compaction.test.ts test/context-projection.test.ts test/agent-runtime.test.ts
mise run test
mise run local-ci
```

Dependencies: Slices 4 and 5.

### Slice 7: Manual Summary Compaction And Hooks

Status: `[x]` Completed on 2026-08-26

Goal: Deliver a complete persisted compaction operation behind idle-only `/compact [focus]` before enabling automatic triggers.

Why here: Manual invocation isolates summary quality, hook control flow, progress UX, and lifecycle replay from threshold and provider retry behavior.

This slice should implement:

- Add structured iterative summarization with tools disabled.
- Fold previous summaries, run deterministic pruning first, and preserve the recent verbatim tail.
- Add chunked summarization or an explicitly marked deterministic fallback when the summary request is itself too large.
- Add idle-only `/compact [focus]`; force a checkpoint below the automatic threshold and return the specified visible busy/no-op outcomes.
- Persist the optional focus text in the compaction event for local auditability, but do not add it to normal conversation as a user claim.
- Extend `PreCompact` and honor context, block, stop, failure, and hard-budget semantics.
- Emit progress/status feedback and show the post-compaction estimate with `~` until refreshed by a provider response.
- Cover live use, process restart, restore, fork, new, persistence failure, and root/subagent isolation before exposing the command.

Expected output:

- Manual compaction reduces the model projection without deleting visible history.
- Restored and forked sessions use the exact same compacted projection as the source session.
- Hooks and idle/busy behavior are deterministic and documented.

Verification:

```sh
vp test run test/context-compaction.test.ts test/context-projection.test.ts test/hooks.test.ts test/session.test.ts test/tui-controller.test.ts test/commands.test.ts test/agent-runtime.test.ts
mise run opentui-test
mise run test
mise run local-ci
```

Dependencies: Slices 3, 5, and 6.

### Slice 8: Proactive Auto-Compaction And Reactive Overflow Retry

Status: `[x]` Completed on 2026-08-26

Goal: Orchestrate bounded automatic compaction before unsafe requests and recover once from provider overflow.

Why here: Accounting, rendering, replay, pruning, manual summary quality, and hooks must be proven before the runtime takes automatic action.

This slice should implement:

- Check the projected budget at every legal provider-call boundary, including tool continuations.
- Apply the two-phase model-downshift flow: evaluate first, compact with the previous capable route when required, then commit or reject the switch.
- Run deterministic pruning before summary compaction.
- Trigger proactive summary compaction only when known or explicitly assumed policy provides a usable budget.
- Compact toward the target and enforce savings, cooldown, and per-turn attempt limits.
- Classify context-overflow errors from structured data and guarded message patterns.
- Learn an exact reported maximum or conservative ceiling when present, rerun the budget, compact, and retry once.
- Recover without numeric capacity while leaving denominator state unknown.
- Handle hook-blocked hard-limit requests with an actionable failure rather than sending them.
- Add deterministic fake-provider cases for threshold, project-instruction fingerprint invalidation, mid-tool-loop overflow, model downshift, retry success/exhaustion, and ineffective compaction.
- Keep the config default disabled during this slice.

Expected output:

- Long turns compact before the next request exceeds known capacity.
- Provider overflow causes at most one request retry and cannot loop indefinitely.
- Unknown proxy routes remain honest while still receiving bounded reactive recovery.
- A failed downshift leaves the previous model selected.

Verification:

```sh
vp test run test/context-compaction.test.ts test/context-overflow.test.ts test/context-projection.test.ts test/agent-runtime.test.ts test/model.test.ts test/session.test.ts test/tui-controller.test.ts
mise run smoke-scenario 21-context-compaction 1
mise run test
mise run local-ci
```

Dependencies: Slice 7.

### Slice 9: Provider Metadata Discovery And Learned Route Ceilings

Status: `[x]` Completed on 2026-08-26

Goal: Improve capacity resolution for OpenRouter, Codex, and explicitly opted-in OpenAI-compatible proxies without weakening provenance.

Why here: Explicit config and safe unknown behavior solve correctness first. Discovery can improve convenience without becoming a hidden dependency of compaction.

This slice should implement:

- Retain OpenRouter `context_length` metadata already fetched for the model picker.
- Verify and consume Codex model metadata only through the authenticated route's actual response contract.
- Add allowlisted `/models` parsing only when an OpenAI-compatible provider sets `discoverModelLimits: true`.
- Cache provider-reported capacity with freshness metadata for the exact route.
- Persist exact reported maxima and conservative learned ceilings atomically under `.agents/topchester/` without prompts, headers, credentials, or response bodies.
- Preserve whether each learned value was reported or inferred and never allow it to raise capacity.
- Invalidate route state on base URL/model changes and expire stale discovery.
- Add conflicting metadata, alias, same-model-different-base-URL, and VibeProxy-like fake endpoint tests.
- Ensure `/context` shows why one source won precedence.

Expected output:

- OpenRouter no longer throws away context metadata it already obtained.
- Custom proxies benefit only after explicit discovery opt-in and remain unknown when metadata is absent.
- The same model id on direct Codex and VibeProxy routes can resolve to different limits.

Verification:

```sh
vp test run test/openrouter-models.test.ts test/codex-provider.test.ts test/context-capacity.test.ts test/config.test.ts test/commands.test.ts
mise run test
mise run local-ci
```

Optional live checks, recorded separately from deterministic tests:

1. Query an available opted-in VibeProxy route whose `/models` response includes limits.
2. Query one that omits limits and confirm Topchester remains unknown.
3. Do not claim live compatibility when only fake-provider coverage ran.

Dependencies: Slices 1 through 8.

### Slice 10: Enablement, Documentation, Smoke Coverage, And Cleanup

Status: `[x]` Completed on 2026-08-26

Goal: Enable automatic compaction by default only after the full contract is proven, document the model, and remove temporary rollout paths.

Why here: Default-on behavior is the user-visible risk boundary and should be the last change, not the first implementation shortcut.

This slice should implement:

- Require every deterministic compaction-quality fixture to preserve identifiers, constraints, file mutations, validation failures, settled continuation state, and next steps; any fixture failure blocks default-on enablement.
- Add or finalize the deterministic smoke scenario and session-resume coverage.
- Enable automatic compaction by default with documented opt-out.
- Document explicit VibeProxy `modelLimits`, discovery opt-in, unknown-capacity behavior, capacity provenance, `/context`, `/compact`, hooks, session projection, and overflow recovery.
- Update schema reference, examples, changelog, and stale `PreCompact` claims.
- Remove development-only flags and duplicated accounting helpers.
- Search for context percentages derived from cumulative usage and for unqualified fallback limits.
- Update this plan with actual findings and verification evidence.

Expected output:

- One documented context mental model matches config, runtime, TUI, session replay, and provider behavior.
- Automatic compaction is on by default, bounded, observable, and reversible through config.
- No docs claim that a proxy's familiar model name proves remaining context.

Verification:

```sh
rg -n "no automatic compaction|V0 has no automatic compaction|context.*128000|context.*200000|context.*256000|TurnTokenUsageTotals.*context" src test docs README.md
mise run format-check
mise run lint
mise run typecheck
mise run test
mise run smoke
mise run local-ci
```

Manual checks:

1. Run a known-capacity route until proactive compaction occurs and confirm the visible transcript remains complete.
2. Run an explicit VibeProxy route and verify config provenance and safe remaining space.
3. Run an unknown VibeProxy-like route and verify no fabricated denominator appears.
4. Switch from a larger route to a smaller route and confirm compaction uses the previous route before the model override commits.
5. Make the downshift compaction fail and confirm the previous model remains selected.
6. Resume, restore, and fork a compacted session, including a mid-turn projection fixture, and confirm exact model-context continuity.
7. Run inside an 80x24 terminal, tmux or zellij, and `NO_COLOR` mode.

Dependencies: Slices 1 through 9.

## Testing Plan

### Pure contract tests

- route normalization and same-model/different-endpoint isolation
- capacity precedence and provenance
- explicit, provider-reported, catalog, exact-error-maximum, inferred-ceiling, assumed, and unknown cases
- budget math for shared-window, separate-input, combined-limit, configured-reserve, small-window, and large-output cases
- uncertainty and reserve behavior
- numeric overflow extraction and rejection of unrelated numbers
- cache-token non-duplication

### Runtime tests

- provider usage snapshot plus trailing estimate
- request-base fingerprint reuse and invalidation for route, system, project-instruction, tool-schema, image, and prior-segment changes
- full local estimate when usage is missing
- system/tool/KB/hook inclusion
- preflight before first request and every tool continuation
- prompt parity before compaction
- deterministic pruning and tool association
- summary schema, retained tail, previous-summary folding, and chunking
- threshold compaction, model-switch compaction, and overflow retry
- legal pre-call/post-tool boundaries and rejection while a model, tool, approval, hook, or compaction is active
- two-phase model downshift using the previous route, including rollback on compaction failure
- hook continue, context, block, stop, failure, and hard-budget behavior
- ineffective-compaction and attempt-limit behavior
- root and subagent isolation

### Session tests

- context event schema and append/replay
- full visible transcript versus compacted model projection
- transcript references plus inline retained current-turn tool/continuation segments after process restart
- malformed projection version, missing transcript reference, and unmatched tool association failures
- completed-turn display-only tool rows remain absent from model context
- old sessions without context events
- resume, restore, fork, new, and invalid-route fallback
- post-compaction estimate persistence and refresh
- persistence failure without transcript loss

### TUI tests

- exact, estimated, assumed, and unknown displays
- warning and hard-limit labels without relying on color
- breakpoint priority at 80, 96, 120, and 200 columns
- resize without wrapping or footer-height feedback loops
- `/context` provenance and configuration guidance
- `/compact` progress, forced-below-threshold success, no-op, busy rejection, block, and failure feedback

### Smoke and quality fixtures

- long deterministic conversation that must remember an exact code, file path, and user constraint after compaction
- tool-heavy turn whose old reads are pruned before summary generation
- context overflow with a numeric route limit followed by successful retry
- session resume after completed-turn and mid-turn compaction snapshots
- successful and failed large-to-small model downshift
- summary-quality fixture that fails if exact identifiers, constraints, changed files, settled continuation state, validation errors, or next steps disappear

## Final Verification

Focused confidence pass:

```sh
vp test run \
  test/config.test.ts \
  test/context-capacity.test.ts \
  test/context-estimate.test.ts \
  test/context-prompt.test.ts \
  test/context-projection.test.ts \
  test/context-compaction.test.ts \
  test/context-overflow.test.ts \
  test/model.test.ts \
  test/codex-provider.test.ts \
  test/openrouter-models.test.ts \
  test/agent-runtime.test.ts \
  test/commands.test.ts \
  test/hooks.test.ts \
  test/session.test.ts \
  test/tui-controller.test.ts \
  test/opentui-state.test.ts
```

TUI and smoke confidence:

```sh
mise run opentui-test
mise run smoke-scenario 21-context-compaction 1
mise run smoke
```

Repository gate:

```sh
mise run test
mise run local-ci
mise run native-package-check
```

Record exact passed commands and dates in this plan. Keep deterministic fake-provider coverage separate from optional live VibeProxy verification.

## Resolved Decisions

1. Generic custom-provider `/models` discovery is controlled by the provider-level `discoverModelLimits: true` opt-in. There is no implicit probing and no separate population command in V0.
2. Reported maxima and learned conservative ceilings live in atomic workspace state under `.agents/topchester/`, using the existing app-path boundary. They are not shared across workspaces and never mutate `topchester.jsonc`.
3. `/compact <focus>` stores the optional focus text in the local compaction event for auditability. It is summary guidance, not a normal user claim in later model context.
4. An explicitly configured assumed capacity may permit proactive summary compaction with the larger uncertainty margin and visible `assumed` provenance. Assumptions are never persisted as learned provider truth.
5. The status bar shows safe remaining capacity; `/context` shows both raw and safe remaining values.
6. Slice 10 default-on enablement requires every deterministic quality fixture to pass. There is no averaged score that can hide loss of an exact identifier, user constraint, changed file, validation failure, settled continuation state, or next step.

## Open Questions

1. Which exact direct-provider catalogs are trustworthy enough to ship, who owns their updates, and what freshness policy applies? Unknown remains preferable to an unowned static table; Slice 1 must work without resolving this, and Slice 9 may ship with no additional catalog sources.

## Working Notes

- 2026-07-17: Competitor inspection found that all remaining-context displays combine an active-usage numerator with a separately sourced capacity denominator; no ordinary generation usage response solves proxy capacity discovery by itself.
- 2026-07-17: Pi and OpenCode use catalog/config capacity and can be wrong or disabled for unknown custom routes. Codex uses model metadata with fallback behavior. Hermes performs the broadest live metadata discovery. OpenClaw most clearly labels estimates.
- 2026-07-17: Topchester already has provider-reported usage, cumulative per-turn totals, append-only session events, OpenRouter `context_length` discovery, and a `PreCompact` seam, but no active-context state, capacity contract, or compaction path.
- 2026-07-17: Current model context is reconstructed from visible transcript entries and flattened into one prompt string; safe persistent compaction therefore requires a separate model projection and structured prompt segments.
- 2026-07-17: The OpenTUI status bar already uses width-aware session-id display. Context should follow the same priority-collapse model and remain readable without color.
- 2026-07-17: Existing unrelated worktree changes were present while this plan was written. This plan intentionally adds only this document.
- 2026-08-26: Revalidated the plan against current `main`. The named source, test, documentation, TUI, smoke, and Mise task paths still exist; later runtime/TUI work did not invalidate the overall architecture.
- 2026-08-26: Found that current completed-turn model context excludes persisted tool-call display rows, while current-turn tool results exist only inside mutable `nextPrompt`. Added byte-parity invariants and a replayable projection snapshot contract so mid-turn compaction cannot depend on unavailable process memory.
- 2026-08-26: Tightened provider-usage reuse with request-base fingerprints, replaced ambiguous learned-lower-limit language with reported maxima/conservative ceilings, made budget reserve math executable for small and separate-input windows, and defined idle/manual/model-downshift boundaries.
- 2026-08-26: Split the former prompt/pruning and manual/persistence slices into independently reviewable Slices 4 through 7. Expanded the plan to ten slices and made `mise run test` plus `mise run local-ci` separate required checkpoint gates.
- 2026-08-26: Implemented route-aware config, capacity precedence, conservative complete-request estimation, provider snapshot reconciliation, structured prompt segments, deterministic tool-result pruning, replayable projection snapshots, manual and automatic compaction, one bounded overflow retry, exact-route learned capacity state, OpenRouter and opted-in generic metadata discovery, context commands, session restore/fork behavior, and responsive OpenTUI context state.
- 2026-08-26: Persisted retained mid-turn tool results and continuation state inline. Restart replay now restores that provider-visible continuation and removes it after the final assistant turn becomes durable. Completed-turn tool display rows remain transcript-only.
- 2026-08-26: Verified that the authenticated Codex response adapter exposes prompt usage but no route-capacity field. The implementation does not infer a Codex denominator from model names or generic fallbacks.
- 2026-08-26: The stale-claim search found only explicit 128,000-token configuration and hook payload examples plus this plan's historical current-state text. It found no runtime percentage derived from `TurnTokenUsageTotals` and no unqualified 128k, 200k, or 256k fallback.
- 2026-08-26: Focused verification passed with `mise exec -- vp test run test/config.test.ts test/context-capacity.test.ts test/context-estimate.test.ts test/context-status.test.ts test/context-prompt.test.ts test/context-projection.test.ts test/context-compaction.test.ts test/context-overflow.test.ts test/context-registry.test.ts test/model-capacity-discovery.test.ts test/agent-runtime.test.ts test/commands.test.ts test/hooks.test.ts test/session.test.ts test/tui-controller.test.ts test/opentui-state.test.ts test/model.test.ts test/codex-provider.test.ts test/openrouter-models.test.ts` (19 files, 311 tests).
- 2026-08-26: `mise run opentui-test` passed. `mise run smoke-scenario 21-context-compaction 1` passed with one trial and 4 input, 4 output, and 8 total fake-provider tokens.
- 2026-08-26: `mise run test` passed (50 files, 748 tests) and ran the OpenTUI production renderer. `mise run local-ci` passed separately. `mise run native-package-check` passed the packed native install and PTY smoke after status-bar priority was corrected so an actionable Ctrl-C notice suppresses context detail instead of being clipped.
- 2026-08-26: `mise run smoke` passed all 20 deterministic fake-provider scenarios. The final report is `/var/folders/vk/lg6zbk2n68723vt8jkkkmpj80000gn/T/topchester-smoke-1787731711714/report.json`.
- 2026-08-26: Optional live VibeProxy metadata checks were not run. Deterministic fake-provider coverage proves configured, discovered, learned, and unknown-capacity contracts without claiming live proxy compatibility.
