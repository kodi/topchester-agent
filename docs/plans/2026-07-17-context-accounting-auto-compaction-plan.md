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
5. On a recognized context-overflow error, learn a numeric lower limit when available, compact, and retry once.

The visible session transcript remains complete. Compaction changes only the model-facing conversation projection and is persisted as an explicit session event so resume, restore, fork, and subagent sessions recover the same active context.

## Decisions

- Key capacity by `(providerId, normalized baseURL, modelId)`. A model id alone is not a route identity.
- Treat a custom proxy route as distinct from the direct provider even when it uses a familiar Codex or OpenAI model id.
- Keep cumulative token/cost totals separate from active context usage. Never drive a context percentage from `TurnTokenUsageTotals`.
- Use provider-reported input or prompt tokens as the latest active-prompt snapshot. Cache reads and writes are a breakdown of input accounting, not extra context to add again.
- Estimate only content added after the latest provider snapshot. When no usable snapshot exists, estimate the complete provider-bound request.
- Keep token estimation behind an interface. V0 may use a conservative text/image/tool approximation; a model tokenizer can replace it without changing runtime policy.
- Resolve capacity in this order: exact config, trusted live route metadata, trusted direct-provider catalog, a lower limit learned from a numeric overflow error, then unknown.
- Never deliberately fill a context window to discover its size.
- Do not silently turn generic fallbacks such as 128k, 200k, or 256k into authoritative UI values.
- Allow an internal assumed capacity only when explicitly configured as policy. Label it `assumed`, apply a larger safety margin, and never persist it as learned provider truth.
- Add explicit per-model limits under the provider that owns the route. Do not duplicate limits across `agent.primary`, `agent.fast`, `kb.summarize`, and `fallback` assignments.
- V0 summary generation uses the active `agent.primary` route with tools disabled. A separate compaction-model purpose is out of scope until summary-quality and cross-model compatibility are measured.
- Preserve exact prompt rendering before compaction. The structured prompt refactor must have golden tests proving it does not change provider-bound text or tool definitions when no pruning or compaction occurs.
- Keep the complete transcript in session history. Maintain a separate model-context projection consisting of the latest summary, retained turns, and messages after the compaction boundary.
- Never orphan a tool call from its result. Tool pruning operates on associated units and replaces removed results with deterministic stubs.
- Run `PreCompact` before summary generation or model-context mutation. Hook context becomes summary guidance; `block` cancels compaction and `stop` ends the turn.
- If a hook blocks compaction while the request is above the hard prompt budget, do not send the unsafe request. Return an actionable error instead.
- Check the budget before every model request, not only between user turns. Tool results can cross the threshold during one turn.
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
- Hermes is the strongest custom-provider implementation because it probes route metadata, estimates the complete request, and learns lower numeric limits from errors.
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
| Provider usage is present                           | Store input tokens as the latest prompt snapshot and estimate only later retained segments.                                                           |
| Provider usage is absent                            | Estimate the complete rendered request, prefix the UI with `~`, and apply the larger uncertainty margin.                                              |
| Capacity is unknown                                 | Show `ctx ~used/?`; disable percentage-based proactive summary compaction; retain deterministic size guards and reactive overflow recovery.           |
| Numeric overflow limit is returned                  | Record only the lower learned limit for the exact route, recompute the budget, compact, and retry once.                                               |
| Overflow contains no numeric limit                  | Prune and compact from the current estimate, retry once, and keep capacity unknown.                                                                   |
| Tool output crosses the threshold                   | Check before the continuation request and compact inside the same turn.                                                                               |
| Model changes to a smaller route                    | Resolve the new budget before the first call and compact if the retained projection does not fit.                                                     |
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
- `thresholdPercent` must be below the hard limit and above `targetPercent`.
- Explicit `reserveTokens` wins over the default output reserve but never raises the budget above `maxInputTokens`.
- Omitted `compaction` fields use documented defaults.
- Do not add environment-variable duplicates for each field in V0.
- Discovery and learned values live in runtime/workspace state, not inside immutable loaded JSONC.

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
  source: "config" | "provider" | "catalog" | "learned" | "assumed" | "unknown";
  confidence: "authoritative" | "reported" | "catalog" | "inferred" | "unknown";
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
output reserve = configured reserve
              OR model-aware default with a 16,384-token floor

hard prompt budget = maxInputTokens
                  OR contextWindow - output reserve

soft trigger = min(85% of contextWindow, hard prompt budget)
             - estimation uncertainty

target after compaction = min(40% of contextWindow, hard prompt budget - reserve)
```

Initial uncertainty policy:

- fresh provider input snapshot plus estimated trailing segments: `max(2,000, 2% of contextWindow)`
- complete local estimate or assumed capacity: `max(4,000, 5% of contextWindow)`
- exact configured `maxInputTokens` remains the hard ceiling even when percentage policy would allow more

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
- Pending tool or approval state
- Next steps

Keep the retained recent tail verbatim. Treat the summary as model context, not visible assistant speech.

If the summary request itself is too large, summarize older chunks independently and fold their summaries. If model summary generation fails, retain deterministic pruning and either keep the old projection or create an explicitly marked deterministic handoff; never silently discard the middle conversation.

### Hysteresis and loop protection

- Compact toward the target budget, not just below the trigger.
- Require at least 15% savings before counting a pass as effective.
- Do not compact again until meaningful new context has been added unless the provider returns an overflow.
- Allow at most two compactions per user turn and one provider retry after overflow.
- Log before/after estimates, capacity source, reason, retained boundary, savings, and retry count.

## Session Contract

Add backward-compatible session event kinds for context state and compaction. Suggested payloads:

```ts
interface ContextUsageEvent {
  kind: "context_usage";
  route: ContextRoute;
  usage: ContextUsageSnapshot;
  capacity: ContextCapacity;
}

interface ContextCompactionEvent {
  kind: "context_compaction";
  reason: "manual" | "threshold" | "overflow" | "model-switch";
  summary: string;
  retainedFromEventId: number;
  beforeTokens: number;
  afterEstimatedTokens: number;
  route: ContextRoute;
  capacity: ContextCapacity;
}
```

The implementation may consolidate these into one snapshot event if that keeps replay simpler. Required behavior:

- `rehydrateSession()` returns both the complete visible transcript and the latest model-context projection.
- `TuiViewStore` stores the projection separately instead of rebuilding it from every visible transcript entry.
- A live compaction event updates the projection and context display without deleting transcript rows.
- Normal subsequent user/assistant messages extend both transcript and projection.
- Restore swaps projection and context state with the selected session.
- Fork inherits source events and can compact independently afterward.
- `/new` resets the projection and usage snapshot.
- Old sessions without context events retain today's full-transcript behavior.
- Subagent sessions persist their own projections under their existing session tree.

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

- Accept only positive numeric limits from an error that is confidently classified as context overflow.
- Scope the value to exact provider id, normalized base URL, and model id.
- A learned value may lower an existing catalog, provider-reported, or assumed value; it must never override a lower explicit config value or raise capacity.
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
- `src/agent/context/compaction.ts`
  - pruning, summarization, target selection, and loop protection
- `src/agent/context/overflow.ts`
  - provider-neutral overflow classification and numeric-limit extraction
- `src/chat/context-status.ts`
  - status formatting and `/context` diagnostic text
- focused tests matching the final module boundaries
- one deterministic fake-provider smoke scenario under `scripts/smoke/scenarios/`

## Files To Change

- `src/config/index.ts`
  - add `providers.<id>.modelLimits` and top-level compaction policy validation
- `src/app/context.ts`
  - own the route-capacity registry and learned workspace state without mixing it into immutable base config
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
- Keep transcript persistence append-only and backward compatible.
- Do not lose exact file paths, identifiers, errors, pending approvals, or validation state during summarization.
- Keep tool calls and results associated through pruning and compaction.
- Keep compaction policy out of OpenTUI components; the UI renders derived state only.
- Keep provider discovery and error parsing out of the session store.
- Do not make network calls merely to render the status bar.
- Bound every automatic retry and compaction loop.
- Add structured logs for capacity source, estimation source, thresholds, trigger reason, savings, and retry decisions without logging prompt content.
- Update this plan after every completed slice with actual files, findings, and exact verification commands.

## Slices

### Slice 1: Route Capacity And Policy Contracts

Status: `[ ]` Not started

Goal: Define route-aware capacity, provenance, and compaction policy as pure tested contracts without changing runtime behavior.

Why here: Every display and trigger depends on an honest denominator. Starting with config and resolution prevents UI or compaction code from inventing its own model limits.

This slice should implement:

- Add validated `modelLimits` and compaction config schemas.
- Define route, capacity, source, confidence, usage, and budget types.
- Normalize route keys by provider id, normalized base URL, and resolved model id.
- Implement pure capacity precedence for config, supplied provider metadata, supplied catalog metadata, learned lower limits, assumed policy, and unknown.
- Reject learned values that raise a stronger lower limit or override explicit config.
- Add budget-policy helpers and one source for reserve, threshold, target, and uncertainty defaults.
- Keep automatic compaction disabled and leave UI unchanged.

Expected output:

- Config can express VibeProxy-specific limits without pretending the model is a direct Codex route.
- Unknown capacity is a first-class state.
- Policy math and provenance precedence have focused unit coverage.

Verification:

```sh
vp test run test/config.test.ts test/context-capacity.test.ts
mise run typecheck
```

Dependencies: none.

### Slice 2: Active Prompt Accounting And Request Estimation

Status: `[ ]` Not started

Goal: Produce a correct active-context snapshot at the provider boundary while retaining existing cumulative turn totals.

Why here: The numerator must be trustworthy before it is displayed or allowed to trigger compaction.

This slice should implement:

- Normalize provider input usage as last-call prompt usage and document cache semantics.
- Add a request estimator covering system prompt, rendered conversation, KB/hook context, tools, images, and current tool results.
- Use the last provider prompt snapshot plus estimates only for retained content appended afterward.
- Fall back to estimating the entire request when usage is missing or stale.
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
mise run typecheck
```

Dependencies: Slice 1.

### Slice 3: Honest Context Display And Diagnostics

Status: `[ ]` Not started

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
mise run typecheck
```

Manual checks:

1. Resize through 80, 96, 120, and 200 columns.
2. Verify estimated, exact, warning, limit, and unknown forms remain readable without color.
3. Confirm session id collapses before actionable near-limit context state.

Dependencies: Slices 1 and 2.

### Slice 4: Structured Prompt Parity And Deterministic Pruning

Status: `[ ]` Not started

Goal: Replace opaque prompt concatenation with structured segments and add a cheap pruning pass without LLM summarization.

Why here: Summary compaction is unsafe until the runtime can select complete conversation and tool units while proving unchanged rendering in the normal path.

This slice should implement:

- Introduce structured segment types and a single provider-bound renderer.
- Preserve existing prompt output byte-for-byte when pruning is inactive.
- Associate tool calls, results, hook context, steering, and continuation instructions with stable retention policies.
- Add deterministic pruning for replaceable old tool results and repeated reads.
- Protect current-turn data, recent complete turns, mutation evidence, and pending state.
- Return before/after estimates and pruning diagnostics.
- Keep pruning callable manually/test-only; do not trigger it automatically yet.

Expected output:

- Prompt assembly has explicit ownership boundaries.
- Golden tests fail on unintended normal-request changes.
- Large old tool output can be reduced without invoking a model or corrupting tool associations.

Verification:

```sh
vp test run test/agent-runtime.test.ts test/context-prompt.test.ts test/context-compaction.test.ts test/commands.test.ts
mise run typecheck
```

Dependencies: Slice 2.

### Slice 5: Manual Summary Compaction, Hooks, And Session Projection

Status: `[ ]` Not started

Goal: Deliver a complete, persisted compaction operation behind `/compact` before enabling automatic triggers.

Why here: Manual invocation isolates summary quality, hook control flow, and session replay from threshold and retry behavior.

This slice should implement:

- Add structured iterative summarization with tools disabled.
- Fold previous summaries and preserve the recent verbatim tail.
- Add chunked summarization or deterministic fallback when the summary request is itself too large.
- Add `/compact [focus]` and compaction progress/status feedback.
- Extend `PreCompact` payload and honor context, block, and stop semantics.
- Add context-compaction runtime and session events.
- Separate visible transcript from model-context projection in live and rehydrated state.
- Cover resume, restore, fork, new, old-session, persistence-failure, and subagent behavior.
- Show the post-compaction local estimate with `~` until the next provider response.

Expected output:

- Manual compaction reduces the model projection without deleting visible history.
- Restored and forked sessions use the same compacted context as the source session.
- Hook behavior is deterministic and documented.

Verification:

```sh
vp test run test/context-compaction.test.ts test/hooks.test.ts test/session.test.ts test/tui-controller.test.ts test/commands.test.ts test/agent-runtime.test.ts
mise run opentui-test
mise run typecheck
```

Dependencies: Slices 3 and 4.

### Slice 6: Proactive Auto-Compaction And Reactive Overflow Retry

Status: `[ ]` Not started

Goal: Orchestrate bounded automatic compaction before unsafe requests and recover once from provider overflow.

Why here: Accounting, rendering, manual summary quality, hooks, and persistence must be proven before the runtime takes automatic action.

This slice should implement:

- Check the projected budget before every model call, including tool continuations and the first call after a model switch.
- Run deterministic pruning before summary compaction.
- Trigger summary compaction only when known/assumed policy provides a usable budget.
- Compact toward the target and enforce savings, cooldown, and per-turn attempt limits.
- Classify context-overflow errors from structured data and guarded message patterns.
- Learn a lower numeric limit when present, rerun the budget, compact, and retry once.
- Recover without numeric capacity while leaving denominator state unknown.
- Handle hook-blocked hard-limit requests with an actionable failure rather than sending them.
- Add deterministic fake-provider cases for threshold, mid-tool-loop overflow, retry success, retry exhaustion, and ineffective compaction.
- Keep the config default disabled during this slice.

Expected output:

- Long turns compact before the next request exceeds known capacity.
- Provider overflow causes at most one request retry and cannot loop indefinitely.
- Unknown proxy routes remain honest while still receiving bounded reactive recovery.

Verification:

```sh
vp test run test/context-compaction.test.ts test/context-overflow.test.ts test/agent-runtime.test.ts test/model.test.ts test/session.test.ts
mise run smoke-scenario 21-context-compaction 1
mise run typecheck
```

Dependencies: Slice 5.

### Slice 7: Provider Metadata Discovery And Learned Route Limits

Status: `[ ]` Not started

Goal: Improve capacity resolution for OpenRouter, Codex, and opted-in OpenAI-compatible proxies without weakening provenance.

Why here: Explicit config and safe unknown behavior solve correctness first. Discovery can then improve convenience without becoming a hidden dependency of compaction.

This slice should implement:

- Retain OpenRouter `context_length` metadata already fetched for the model picker.
- Verify and consume Codex model metadata only through the authenticated route's actual response contract.
- Add allowlisted `/models` parsing for opted-in custom endpoints.
- Cache provider-reported capacity with freshness metadata for the exact route.
- Persist numeric learned lower limits in workspace state without prompts, headers, or credentials.
- Invalidate route state on base URL/model changes and expire stale discovery.
- Add conflicting metadata, alias, same-model-different-base-URL, and VibeProxy-like fake endpoint tests.
- Ensure `/context` shows why one source won precedence.

Expected output:

- OpenRouter no longer throws away context metadata it already obtained.
- Custom proxies benefit when they expose usable metadata but remain unknown when they do not.
- The same model id on direct Codex and VibeProxy routes can resolve to different limits.

Verification:

```sh
vp test run test/openrouter-models.test.ts test/codex-provider.test.ts test/context-capacity.test.ts test/config.test.ts test/commands.test.ts
mise run typecheck
```

Optional live checks, recorded separately from deterministic tests:

1. Query an available VibeProxy route whose `/models` response includes limits.
2. Query one that omits limits and confirm Topchester remains unknown.
3. Do not claim live compatibility when only fake-provider coverage ran.

Dependencies: Slices 1 through 6.

### Slice 8: Enablement, Documentation, Smoke Coverage, And Cleanup

Status: `[ ]` Not started

Goal: Enable automatic compaction by default only after the full contract is proven, document the model, and remove temporary rollout paths.

Why here: Default-on behavior is the user-visible risk boundary and should be the last change, not the first implementation shortcut.

This slice should implement:

- Run and record compaction-quality fixtures preserving identifiers, constraints, file mutations, validation failures, and next steps.
- Add or finalize the deterministic smoke scenario and session-resume coverage.
- Enable automatic compaction by default with documented opt-out.
- Document explicit VibeProxy `modelLimits`, unknown-capacity behavior, capacity provenance, `/context`, `/compact`, hooks, session projection, and overflow recovery.
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
4. Switch from a larger route to a smaller route and confirm preflight compaction occurs before the first call.
5. Resume, restore, and fork a compacted session and confirm model context continuity.
6. Run inside an 80x24 terminal, tmux or zellij, and `NO_COLOR` mode.

Dependencies: Slices 1 through 7.

## Testing Plan

### Pure contract tests

- route normalization and same-model/different-endpoint isolation
- capacity precedence and provenance
- explicit, reported, catalog, learned, assumed, and unknown cases
- budget math at small and large windows
- uncertainty and reserve behavior
- numeric overflow extraction and rejection of unrelated numbers
- cache-token non-duplication

### Runtime tests

- provider usage snapshot plus trailing estimate
- full local estimate when usage is missing
- system/tool/KB/hook inclusion
- preflight before first request and every tool continuation
- prompt parity before compaction
- deterministic pruning and tool association
- summary schema, retained tail, previous-summary folding, and chunking
- threshold compaction, model-switch compaction, and overflow retry
- hook continue, context, block, stop, failure, and hard-budget behavior
- ineffective-compaction and attempt-limit behavior
- root and subagent isolation

### Session tests

- context event schema and append/replay
- full visible transcript versus compacted model projection
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
- `/compact` progress, success, block, and failure feedback

### Smoke and quality fixtures

- long deterministic conversation that must remember an exact code, file path, and user constraint after compaction
- tool-heavy turn whose old reads are pruned before summary generation
- context overflow with a numeric route limit followed by successful retry
- session resume after compaction
- summary-quality fixture that fails if pending work, changed files, or validation errors disappear

## Final Verification

Focused confidence pass:

```sh
vp test run \
  test/config.test.ts \
  test/context-capacity.test.ts \
  test/context-estimate.test.ts \
  test/context-prompt.test.ts \
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
mise run local-ci
mise run local-ci-extended
```

Record exact passed commands and dates in this plan. Keep deterministic fake-provider coverage separate from optional live VibeProxy verification.

## Open Questions

1. Should generic custom-provider `/models` discovery be one provider boolean such as `discoverModelLimits`, or an explicit CLI operation that populates only runtime state?
2. Should learned route limits live only in the current session, in workspace `.agents/topchester/` state, or in a user-level cache shared across workspaces? The initial recommendation is workspace state for predictable scope.
3. Should `/compact <focus>` store the focus text in the compaction event for auditability, or only the resulting summary?
4. Which exact direct-provider catalogs are trustworthy enough to ship, and how will their freshness be maintained? Unknown is preferable to an unowned static table.
5. Should an explicit assumed fallback permit proactive summary compaction, or only adjust hard byte/message guards? The initial recommendation is to permit it with a larger margin and visible `assumed` provenance.
6. Should the status bar show raw remaining capacity or safe remaining before compaction? The recommendation is safe remaining in the status bar and both values in `/context`.
7. What minimum summary-quality score or fixture pass rate is required before Slice 8 enables default-on behavior?

## Working Notes

- 2026-07-17: Competitor inspection found that all remaining-context displays combine an active-usage numerator with a separately sourced capacity denominator; no ordinary generation usage response solves proxy capacity discovery by itself.
- 2026-07-17: Pi and OpenCode use catalog/config capacity and can be wrong or disabled for unknown custom routes. Codex uses model metadata with fallback behavior. Hermes performs the broadest live metadata discovery. OpenClaw most clearly labels estimates.
- 2026-07-17: Topchester already has provider-reported usage, cumulative per-turn totals, append-only session events, OpenRouter `context_length` discovery, and a `PreCompact` seam, but no active-context state, capacity contract, or compaction path.
- 2026-07-17: Current model context is reconstructed from visible transcript entries and flattened into one prompt string; safe persistent compaction therefore requires a separate model projection and structured prompt segments.
- 2026-07-17: The OpenTUI status bar already uses width-aware session-id display. Context should follow the same priority-collapse model and remain readable without color.
- 2026-07-17: Existing unrelated worktree changes were present while this plan was written. This plan intentionally adds only this document.
