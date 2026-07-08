# Web Fetch Tool v0 Plan

## Summary

Add a `web_fetch` tool so the agent can read public web pages: current docs, changelogs, API references, issue pages, and package behavior. This closes the "web fetch" gap tracked in `docs/plans/2026-05-13-alpha-tool-gap-analysis-plan.md` (item 4, weight 15).

The v0 target is the OpenCode/Crush shape: a structured `{ url, format?, timeout_seconds? }` tool that fetches with the built-in Node `fetch`, converts HTML to markdown or plain text locally, and returns bounded, truncation-annotated content. No summarizer model, no headless browser, no server-side fetching.

## Competitor Findings

Surveyed OpenCode, Crush, Claude Code, Gemini CLI, Codex CLI, pi, and aider. Three architectures exist:

| Approach                             | Examples                                           | Notes                                                                                   |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Raw fetch + local HTML-to-markdown   | OpenCode `webfetch`, Crush `fetch`                 | Simple, proven contract (`url`, `format`, `timeout`), content lands directly in context |
| Fetch + summarize with a small model | Claude Code `WebFetch`                             | Token-efficient, buffers prompt injection, needs a second model call path               |
| Server/model-side fetching           | Gemini CLI (primary path), Codex CLI (only option) | Offloads security to the provider; needs provider support Topchester does not have      |

Pi ships no fetch tool at all and points users at `curl` via bash; that conflicts with Topchester's goal of keeping network access visible and policy-gated, so it is not the model to follow.

Decision-relevant details worth copying even in v0:

- OpenCode: `format` enum (`text`/`markdown`/`html`) defaulting to markdown; 30 s default / 120 s max timeout; 5 MB response cap; Turndown for markdown, streaming htmlparser2 text extraction; retry once with an honest `User-Agent` when Cloudflare answers 403 with `cf-mitigated: challenge`.
- Crush: truncate oversized bodies with an explicit `[Content truncated ...]` marker instead of erroring like OpenCode does.
- Gemini CLI: block `localhost` and private IP ranges before connecting (the only agent in the survey that closes the SSRF hole); explicit truncation markers.
- Claude Code: do not silently follow cross-host redirects; surface the redirect target and let the model make a fresh, auditable call.

Deferred upgrades (explicitly out of v0): Haiku-style summarization with a `prompt` arg, headless-browser rendering for JS-heavy pages, response caching, `web_search`.

## Decisions

- Tool name is `web_fetch`, matching the name already used in the gap analysis plan.
- Args are `{ url: string, format?: "markdown" | "text" | "html" (default "markdown"), timeout_seconds?: number }`. Default timeout 30 s, hard cap 120 s.
- Fetch uses the built-in Node 24 `fetch` with `AbortController`. No new HTTP client dependency.
- HTML conversion uses `turndown` for markdown and `htmlparser2` for plain-text extraction. These are the only two new dependencies.
- Security policy in v0: HTTP(S) schemes only, credentials stripped from the URL, `localhost` and private/link-local IP ranges blocked fail-closed (including after DNS resolution), and cross-host redirects surfaced as a result instead of silently followed.
- Raw response bodies over 5 MB are an error; converted output is truncated at 40,000 characters with a `[truncated]` marker and a `truncated: true` result field, consistent with the grep tool's output cap.
- Non-2xx HTTP statuses are ordinary tool results that report the status, not tool execution errors, mirroring the bash rule that non-zero exits are evidence, not failures.
- Profile permissions: allowed for the `primary` and `general` profiles, denied for the `explore` subagent. Explore stays a workspace-only reader in v0.
- No per-URL interactive approval in v0. The only approval infrastructure today is bash-specific (`resolveBashApproval` in `src/agent/runtime/index.ts` is hardwired to `call.tool !== "bash"`), and generalizing it is real scope. Network access stays visible through the TUI tool label, which always shows the URL. Per-URL approval is captured as follow-up Slice 4.1.
- The tool never bypasses the KB invariant: it is a context-gathering tool like `grep`, not a coding path.

## Scope

Included:

- URL validation policy module with SSRF protections.
- Fetcher with timeout, size caps, redirect surfacing, and the Cloudflare honest-UA retry.
- HTML-to-markdown and HTML-to-text conversion.
- Tool definition, registry entry, prompt line, TUI label, prompt-formatting branch, profile permissions.
- Tests for policy, conversion, fetch behavior (against a local HTTP server), and catalog/permission wiring.
- Docs updates: `docs/cli.md`, `docs/tui.md`, public docs, changelog.

Out of scope for v0:

- `web_search`.
- Interactive per-URL approval (follow-up Slice 4.1).
- Summarization with a secondary model.
- Headless browser / JS rendering.
- Response caching.
- Image/binary attachment support (non-text content types return a short descriptive error result).

## Current State

- No agent-facing HTTP fetching exists. Network code is limited to model-provider fetch wrappers (`src/model/codex.ts`, `src/model/index.ts`) and OAuth (`src/auth/codex.ts`).
- No HTML parsing or HTTP client dependencies exist in `package.json`; Node 24 built-in `fetch` is available.
- `run_validator` policy already rejects `curl`/`wget`, and `bash` can only reach the network through approval, so `web_fetch` becomes the sanctioned network read path.
- Tools follow the `defineTool` contract in `src/agent/tools/types.ts`, register in `src/agent/tools/registry.ts`, get compact TUI labels via `formatToolCallMessage` in `src/agent/runtime/format.ts`, and gain permissions through profiles in `src/agent/profiles.ts`.

## Implementation Shape

New tool follows the `grep.ts` pattern: one primary file plus a policy sibling.

```ts
// src/agent/tools/web-fetch.ts
export const webFetchArgsSchema = z.object({
  url: z.string(),
  format: z.enum(["markdown", "text", "html"]).default("markdown"),
  timeout_seconds: z.number().int().positive().max(120).optional(),
});

export interface WebFetchToolResult extends ToolResult<"web_fetch"> {
  url: string;
  finalUrl?: string; // set when a same-host redirect chain was followed
  status: number;
  contentType?: string;
  truncated: boolean;
  redirectedTo?: string; // set instead of content when a cross-host redirect was refused
}
```

Tool flags: `parallelSafe: true`, `mutatesWorkspace: false`, `resourceKeys: (args) => [`web_fetch:${args.url}`]`.

Fetch flow:

1. Validate the URL with the policy module (scheme, credentials, blocked hosts). Policy failures throw, so the executor wraps them as `ToolErrorResult`.
2. Fetch with `redirect: "manual"`, a Chrome-like `User-Agent`, and a format-aware `Accept` header. Follow same-host redirects up to a small hop limit, re-validating each hop against the policy; on a cross-host redirect stop and return a result with `redirectedTo` so the model can issue a fresh call.
3. On 403 with `cf-mitigated: challenge`, retry once with `User-Agent: topchester`.
4. Enforce the 5 MB cap against `Content-Length` and again against the decoded body.
5. Convert HTML per `format` (Turndown / htmlparser2 text pass / raw); pass non-HTML text content through unchanged.
6. Truncate to 40,000 characters with a `[truncated]` marker and set `truncated`.

## Cross-Slice Rules

- Every fetched URL must pass the policy module; there is no bypass path, including redirect hops.
- HTTP error statuses are ordinary results; only policy violations, timeouts, oversize bodies, and transport failures are tool errors.
- Tests must never hit the real network. Use `node:http` servers bound to `127.0.0.1` — which requires the policy check to be injectable or bypassable under test, since the policy blocks loopback in production.
- TUI label must always include the URL so network access stays visible.
- Keep `docs/reference/cli.md` and the TUI docs in sync in the same change that lands the tool, per repo rules.

## Slices

### Slice 1: URL policy module and args schema

Status: `[x]` Complete

Goal: a hardened, independently tested URL policy that everything else builds on.

Why here: the SSRF surface is the riskiest part of the tool; hardening it first means later slices cannot accidentally ship an unguarded fetch path.

This slice should implement:

- `src/agent/tools/web-fetch-policy.ts` with `validateWebFetchUrl(url, options)` returning a normalized URL or a structured rejection.
- Rules: scheme must be `http:`/`https:`; credentials in the URL are stripped; hostname literals matching loopback, private (RFC 1918), link-local, and unique-local ranges are rejected; non-literal hostnames are resolved with `dns.promises.lookup` and every resolved address is checked (fail-closed on resolution errors); an `allowPrivateNetwork` escape hatch exists only for tests.
- `webFetchArgsSchema` with the `url`/`format`/`timeout_seconds` contract and exported types, colocated in the policy file or a stub `web-fetch.ts` so Slice 2 has a home for it.

Expected output: policy module plus `test/web-fetch-policy.test.ts` covering accepted URLs, each rejection class, credential stripping, and DNS fail-closed behavior (mock the lookup).

Verification: `mise run test`, `mise run typecheck`.

Dependencies: none.

### Slice 2: Fetcher and HTML conversion

Status: `[x]` Complete

Goal: a `fetchWebContent(url, options)` helper that performs the full fetch flow and returns converted, bounded content.

Why here: isolates the network and conversion mechanics behind a plain async function that Slice 3's `execute` can call, and that tests can exercise against a local server without the tool/permission machinery.

This slice should implement:

- Add `turndown` (plus `@types/turndown`) and `htmlparser2` via the package manager.
- The fetch flow from Implementation Shape: manual redirects with per-hop policy re-validation and cross-host surfacing, timeout via `AbortController` (default 30 s, cap 120 s), 5 MB double cap, Cloudflare honest-UA retry, format-aware `Accept` headers.
- `convertHtmlToMarkdown` (Turndown: ATX headings, fenced code blocks, `-` bullets, removing `script`/`style`/`meta`/`link`) and `extractTextFromHtml` (htmlparser2 streaming pass skipping `script`/`style`/`noscript`/`iframe`/`object`/`embed`).
- 40,000-character truncation with marker and flag.

Expected output: exported helpers in `src/agent/tools/web-fetch.ts` plus `test/web-fetch-tool.test.ts` sections covering markdown/text/html conversion, truncation, timeout, oversize rejection, non-2xx passthrough, same-host redirect following, and cross-host redirect surfacing — all against local `node:http` servers with the policy's test escape hatch.

Verification: `mise run test`, `mise run typecheck`, `mise run lint`.

Dependencies: Slice 1.

### Slice 3: Tool definition, registration, and runtime wiring

Status: `[x]` Complete

Goal: `web_fetch` is a first-class registered tool the model can call.

Why here: with policy and mechanics proven, this slice is mostly declarative wiring across the known registration points.

This slice should implement:

- `defineTool` for `web_fetch` in `src/agent/tools/web-fetch.ts`: description, prompt line (JSON example matching the text-protocol convention), `argsSchema`, `parallelSafe: true`, `mutatesWorkspace: false`, `resourceKeys`, and `execute` calling `fetchWebContent`.
- Registry entry in `src/agent/tools/registry.ts` and barrel export in `src/agent/tools.ts`.
- Profile permissions in `src/agent/profiles.ts`: available to `primary` and `general`, absent from the explore allow-list.
- `formatToolCallMessage` branch in `src/agent/runtime/format.ts`: `web_fetch: <url>` before a result, and `web_fetch: <url> (<status>, <size or truncated marker>)` after; a `formatToolResultForPrompt` branch that includes status, final URL, and truncation state above the content.
- Any tool-guidance line in `src/agent/prompts.ts` telling the model to prefer `web_fetch` over bash `curl` for reading URLs.

Expected output: tool callable end to end; entries added to `test/tools.test.ts` for schema parsing, catalog membership per profile, parallel-safety classification, and label formatting; `test/web-fetch-tool.test.ts` gains an `execute`-level test.

Verification: `mise run test`, `mise run typecheck`, `mise run lint`, plus a manual `topchester run` fetch of a public docs page with a real key (record the command used).

Dependencies: Slices 1 and 2.

### Slice 4: Docs and changelog

Status: `[x]` Complete

Goal: public and internal docs reflect the new tool.

Why here: repo rules require docs to land with behavior changes; kept as its own slice only so the wiring slice stays reviewable, and it should ship in the same PR or immediately after.

This slice should implement:

- Add `web_fetch` to the tool inventories in `docs/cli.md` and `docs/tui.md` (with an example label).
- Update the nearest public docs page (`docs/reference/cli.md` and the relevant `docs/features/` page) in plain language: what the tool does, the private-network blocking, the size/truncation behavior, and that it is not available to the explore subagent.
- Changelog entry in `docs/reference/changelog.md`.
- Mark item 4 progress in `docs/plans/2026-05-13-alpha-tool-gap-analysis-plan.md` (`web_fetch` shipped, `web_search` still open).

Expected output: docs consistent with the implementation; no `public: true` on this plan.

Verification: `mise run format-check`; manual read-through that examples match the shipped schema.

Dependencies: Slice 3.

### Slice 4.1 (follow-up, not v0): Per-URL approval

Status: `[ ]` Not started

Generalize the bash approval flow into a permission request that `web_fetch` can use (OpenCode's `ctx.ask` pattern: approve one URL, a domain, or all). Requires extending `resolveBashApproval` into a tool-generic approval path and a TUI prompt variant. Do not start until v0 usage shows whether URL-level approval is worth the interaction cost, and consider config-level allow/deny domain lists (`tools.webFetch.allow`/`deny`) as a cheaper alternative.

## Files to Add

- `src/agent/tools/web-fetch.ts`
- `src/agent/tools/web-fetch-policy.ts`
- `test/web-fetch-policy.test.ts`
- `test/web-fetch-tool.test.ts`

## Files to Change

- `src/agent/tools/registry.ts`
- `src/agent/tools.ts`
- `src/agent/profiles.ts`
- `src/agent/runtime/format.ts`
- `src/agent/prompts.ts`
- `test/tools.test.ts`
- `package.json` (add `turndown`, `@types/turndown`, `htmlparser2`)
- `docs/cli.md`, `docs/tui.md`, `docs/reference/cli.md`, relevant `docs/features/` page, `docs/reference/changelog.md`
- `docs/plans/2026-05-13-alpha-tool-gap-analysis-plan.md`

## Testing Plan

- Unit: policy rejection matrix, conversion fixtures, truncation boundaries.
- Integration: fetch flow against local `node:http` servers (redirects, timeouts, oversize, Cloudflare-challenge retry, non-2xx).
- Wiring: catalog membership per profile, parallel-safety, label and prompt formatting in `test/tools.test.ts`.
- Manual: one live fetch of a real docs page through the TUI before calling Slice 3 done.
- Final pass: `mise run local-ci` and `mise run test`.

## Open Questions

- Should the `general` subagent really get `web_fetch` in v0, or primary-only until approval lands? Current decision is primary + general because general already gets `write_file`/`edit_file`, which are higher-risk; revisit if injection-via-fetched-content becomes a concern.
- Is 40,000 characters the right output cap for docs pages, or should `web_fetch` get a higher cap (Gemini uses 250,000)? Starting at 40,000 for consistency; bump with evidence.
- Should GitHub blob URLs be auto-rewritten to `raw.githubusercontent.com` (Gemini does this)? Deferred; cheap to add later inside the policy normalize step.
