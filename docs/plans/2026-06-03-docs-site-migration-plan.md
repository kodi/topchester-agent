# Topchester Docs Site Migration Plan

## Summary

Move Topchester documentation from a small set of large repo-local Markdown files into a user-friendly public documentation site served at `https://topchester.com/docs`, while keeping the source documentation close to the Topchester agent code so agents can update docs alongside behavior changes.

The target state is:

- `topchester-agent/docs` remains the source of truth for product and reference docs.
- `topchester-web` owns rendering, styling, routing, and deployment for the public site.
- Eleventy renders the docs into `/docs/...` paths as part of the website build.
- Existing large docs are split into task-oriented pages for onboarding, configuration, features, hooks, MCP, and reference.
- Internal design docs and implementation plans stay in the agent repo but are excluded from the public docs build.

This plan exists because the migration crosses two repositories, content architecture, static-site tooling, deployment behavior, and future agent maintenance conventions.

## Decisions

- Use Eleventy for the first docs site implementation.
- Keep docs source in `/Users/kodi/data/personal/topchester-agent/docs`.
- Serve rendered docs from `topchester.com/docs`.
- Keep `/Users/kodi/data/personal/topchester-web` as the public website and deployment repo.
- Preserve the current Topchester landing page at `/`.
- Exclude `docs/plans`, benchmarks, draft design notes, and deeply internal implementation docs from the public docs navigation unless explicitly promoted.
- Split large public-facing docs into small pages instead of publishing the current files as-is.
- Treat the current Markdown docs as source material for the new information architecture, not as a finished page map.

## Scope

Included:

- Add an Eleventy docs build to `topchester-web`.
- Build public docs from Markdown source living in `topchester-agent/docs`.
- Create a stable public docs information architecture.
- Split current large docs into user-facing pages and reference pages.
- Add sidebar/navigation metadata.
- Add public docs layout, styling, code block treatment, and basic responsive navigation.
- Add local and CI verification for links and generated docs output.
- Update repo guidance so future agents know when and where to update docs.

Out of scope for the initial migration:

- Search service integration.
- Versioned docs.
- Localization.
- Hosted docs CMS.
- React/Next/Markdoc rewrite.
- Auto-generating full schema reference from TypeScript or Zod.
- Moving implementation plans out of `topchester-agent`.
- Publishing every internal architecture note publicly.

## Current State

`topchester-agent` currently has useful but uneven docs:

- `docs/config.md` covers config locations, models, bash permissions, MCP stdio servers, and hooks in one long page.
- `docs/MODEL_CONFIG.md` overlaps with `docs/config.md` and mixes public guidance with lower-level implementation detail.
- `docs/hooks.md` is a strong standalone reference, but it is too dense to be the first hooks page.
- `docs/cli.md` is a full command reference and should remain available as reference, but it is not an onboarding path.
- `docs/KNOWLEDGE.md` is very large and mixes user-visible feature behavior with design notes.
- `docs/tui.md`, `docs/skills.md`, and `docs/SESSIONS.md` are closer to user docs but still need consistent placement and tone.
- `docs/plans/*` are implementation handoff documents and should not be part of public docs navigation.

`topchester-web` is currently a small static website:

- It has a single static landing page at `index.html`.
- `package.json` only defines `npm run check` through `scripts/check-links.mjs`.
- There is no framework, build step, docs layout, or route generation yet.
- `AGENTS.md` says to prefer Tailwind classes and lucide icons when possible.

## Recommended Architecture

Use Eleventy as a lightweight static generator inside `topchester-web`.

The website repo should render both the existing landing page and the docs:

```text
topchester-web
  -> landing page source
  -> Eleventy layouts and assets
  -> docs source copied, mounted, or read from topchester-agent/docs
  -> generated public site
       /
       /docs/
       /docs/getting-started/quickstart/
       /docs/configuration/models/
       /docs/hooks/events/
       /docs/mcp/stdio-servers/
```

The agent repo should continue to hold authoring docs:

```text
topchester-agent/docs
  getting-started/
  configuration/
  features/
  hooks/
  mcp/
  reference/
  internals/
  plans/
```

The docs build should treat `topchester-agent/docs` as content input and use `topchester-web` for all presentation concerns. Avoid committing generated HTML into `topchester-agent`.

## Source and Build Options

### Option A: Adjacent repo source for local development

Eleventy in `topchester-web` reads `../topchester-agent/docs`.

Pros:

- Fastest local path.
- Keeps docs next to code.
- No duplicated content.

Cons:

- CI/deploy must check out or clone both repos.
- The build is path-sensitive unless configured carefully.

Use this for the first local implementation.

### Option B: Vendor checkout during CI/deploy

`topchester-web` build clones or checks out `topchester-agent` into `vendor/topchester-agent` and sets `TOPCHESTER_DOCS_SOURCE=vendor/topchester-agent/docs`.

Pros:

- Deploys work without relying on sibling directories.
- Keeps docs source in the agent repo.
- Avoids submodule friction while the docs shape is still changing.

Cons:

- Requires CI/deploy script changes.
- Needs a pinned branch, tag, or commit policy.

Use this for the first production deployment path.

### Option C: Git submodule

`topchester-web` vendors `topchester-agent` as a submodule.

Pros:

- Reproducible build input.
- No custom clone step.

Cons:

- Submodule workflows are clunky for frequent docs edits.
- Agents may need extra guidance to update submodule pointers.

Consider later if the deploy process needs stricter reproducibility.

## Public Information Architecture

Target public docs navigation:

```text
Intro
  What is Topchester?
  Quickstart
  Installation
  First project

Configuration
  Config files
  Models and providers
  Bash permissions
  Project instructions
  Ignore paths

Features
  TUI
  Slash commands
  Sessions
  Knowledge base
  Skills

Hooks
  Overview
  Events
  Payloads
  Examples

MCP
  Overview
  Stdio servers
  Examples

Reference
  CLI commands
  Config schema
  Model config
  Troubleshooting
```

The public docs should be written from user intent outward:

- Start pages should answer "what is this and how do I try it?"
- Configuration pages should answer "where do I put this and what is the smallest working file?"
- Feature pages should answer "what can I do with this?"
- Reference pages should answer "what are all the fields, commands, or payload details?"
- Internal docs should answer "how is this built?" and should not crowd the public sidebar.

## Proposed Docs Source Layout

```text
docs/
  README.md
  getting-started/
    intro.md
    quickstart.md
    installation.md
    first-project.md
  configuration/
    config-files.md
    models-and-providers.md
    bash-permissions.md
    project-instructions.md
    ignore-paths.md
  features/
    tui.md
    slash-commands.md
    sessions.md
    knowledge-base.md
    skills.md
  hooks/
    overview.md
    events.md
    payloads.md
    examples.md
  mcp/
    overview.md
    stdio-servers.md
    examples.md
  reference/
    cli.md
    config-schema.md
    model-config.md
    troubleshooting.md
  internals/
    architecture.md
    drift-detection.md
    kb-session-overlay.md
    agents-metadata.md
  plans/
    ...
```

## Content Mapping

Initial mapping from current files:

| Current source               | New destination                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/config.md`             | `configuration/config-files.md`, `configuration/bash-permissions.md`, `configuration/project-instructions.md`, `configuration/ignore-paths.md`, `mcp/stdio-servers.md`, `hooks/overview.md` |
| `docs/MODEL_CONFIG.md`       | `configuration/models-and-providers.md`, `reference/model-config.md`, `reference/config-schema.md`                                                                                          |
| `docs/hooks.md`              | `hooks/overview.md`, `hooks/events.md`, `hooks/payloads.md`, `hooks/examples.md`                                                                                                            |
| `docs/cli.md`                | `getting-started/quickstart.md`, `reference/cli.md`                                                                                                                                         |
| `docs/tui.md`                | `features/tui.md`, `features/slash-commands.md`                                                                                                                                             |
| `docs/skills.md`             | `features/skills.md`                                                                                                                                                                        |
| `docs/SESSIONS.md`           | `features/sessions.md`                                                                                                                                                                      |
| `docs/KNOWLEDGE.md`          | `features/knowledge-base.md`, `internals/kb-system.md` if needed                                                                                                                            |
| `docs/ARCHITECTURE.md`       | `internals/architecture.md`                                                                                                                                                                 |
| `docs/drift-detection.md`    | `internals/drift-detection.md` or `reference/troubleshooting.md`                                                                                                                            |
| `docs/kb-session-overlay.md` | `internals/kb-session-overlay.md`                                                                                                                                                           |
| `docs/agents-metadata.md`    | `internals/agents-metadata.md`                                                                                                                                                              |
| `docs/plans/*`               | Remain private implementation plans, excluded from public build                                                                                                                             |

## Frontmatter Contract

Each public docs page should have explicit frontmatter:

```yaml
---
title: Quickstart
description: Install Topchester, configure a model, and start the TUI.
section: Intro
order: 20
public: true
---
```

Required fields:

- `title`
- `description`
- `section`
- `order`
- `public`

Optional fields:

- `sidebarTitle`
- `next`
- `previous`
- `editSource`
- `status`

Eleventy should only publish files with `public: true` or files in explicitly public content directories. `docs/plans` should be excluded even if a file accidentally gets frontmatter.

## Cross-Slice Rules

- Keep `topchester-agent/docs` as the authoring source.
- Keep `topchester-web` as the rendering and deployment source.
- Preserve current `/` landing page behavior while adding `/docs`.
- Do not publish `docs/plans`.
- Do not delete old source docs until replacement pages exist and links pass.
- Avoid long-lived duplicate public docs with conflicting guidance.
- Prefer small, task-oriented pages over giant references.
- Preserve exact config paths and command names when migrating content.
- Any implementation behavior change in later Topchester work should update the nearest public docs page, not only an internal design note.
- Add generated output to `.gitignore` if Eleventy creates build directories locally.

## Files To Add

Likely additions in `topchester-web`:

- `eleventy.config.mjs`
- `src/_includes/base.njk`
- `src/_includes/docs.njk`
- `src/_includes/docs-sidebar.njk`
- `src/_data/docs-nav.json` or `src/_data/docs-nav.mjs`
- `src/assets/docs.css` or equivalent Tailwind entrypoint
- `scripts/prepare-docs-source.mjs`
- `scripts/check-docs-build.mjs`

Likely additions in `topchester-agent`:

- new public docs directories listed in the proposed source layout
- `docs/README.md`
- `docs/AGENTS.md` or an update to root `AGENTS.md` documenting docs maintenance rules

## Files To Change

Likely changes in `topchester-web`:

- `package.json`
- lockfile
- `.gitignore`
- existing landing page source, only if needed to fit Eleventy output
- `scripts/check-links.mjs`
- deployment configuration, once known

Likely changes in `topchester-agent`:

- current large docs split into smaller files
- root `AGENTS.md`
- references in README/package docs that link to old docs paths

## Slices

### Slice 1: Establish Docs Build Contract

Status: `[ ]` Not started

Goal: Add a minimal Eleventy build in `topchester-web` that can render a placeholder `/docs/` page without changing the public landing page.

Why here: The build contract should exist before moving content so later slices have a real target.

This slice should implement:

- Add Eleventy dev/build scripts to `topchester-web/package.json`.
- Add minimal Eleventy config.
- Keep the current landing page available at `/`.
- Add a placeholder docs index page under `/docs/`.
- Add generated output to `.gitignore`.

Expected output:

- `topchester-web` can build a static site with `/` and `/docs/`.
- The landing page still renders.

Verification:

- `pnpm install` in `topchester-web` if dependencies are not installed.
- `pnpm run build` in `topchester-web`.
- `pnpm run check` in `topchester-web`.
- Manually inspect generated `/docs/index.html`.

Dependencies:

- None.

### Slice 2: Wire Adjacent Docs Source

Status: `[ ]` Not started

Goal: Teach `topchester-web` to read Markdown docs from `topchester-agent/docs` through a configurable source path.

Why here: This proves the source-of-truth decision before content restructuring begins.

This slice should implement:

- Add `TOPCHESTER_DOCS_SOURCE` support, defaulting locally to `../topchester-agent/docs`.
- Add a small source validation helper that fails clearly if the docs source path is missing.
- Configure Eleventy to mount or ingest public docs from that path.
- Exclude `plans`, benchmarks, and non-public internal folders from generated output.

Expected output:

- `topchester-web` can build docs from a sibling `topchester-agent` checkout.
- Missing docs source produces a clear build error.

Verification:

- `TOPCHESTER_DOCS_SOURCE=/Users/kodi/data/personal/topchester-agent/docs pnpm run build`.
- Temporarily point `TOPCHESTER_DOCS_SOURCE` to a missing path and confirm the helper gives a clear error.

Dependencies:

- Slice 1.

### Slice 3: Define Navigation and Frontmatter

Status: `[ ]` Not started

Goal: Add the public docs navigation model and frontmatter validation before moving substantial content.

Why here: The docs IA should be explicit so content migration does not become a pile of files.

This slice should implement:

- Add `docs-nav` data in `topchester-web`.
- Add a docs layout with sidebar, page title, description, and next/previous links if simple.
- Add frontmatter requirements for public pages.
- Add a docs build check that catches missing title/description/order/public fields.

Expected output:

- Public docs pages have predictable metadata.
- Sidebar ordering is controlled and reviewable.
- Build/check output catches malformed docs pages.

Verification:

- `pnpm run build` in `topchester-web`.
- `pnpm run check` in `topchester-web`.
- Run the new docs metadata check.

Dependencies:

- Slice 2.

### Slice 4: Create Initial Public Docs Skeleton

Status: `[ ]` Not started

Goal: Create the new public docs directory structure in `topchester-agent/docs` with short placeholder or first-pass pages.

Why here: A skeleton lets navigation, links, and publishing stabilize before doing the full content rewrite.

This slice should implement:

- Add directories for `getting-started`, `configuration`, `features`, `hooks`, `mcp`, and `reference`.
- Add initial pages for intro, quickstart, config files, models, hooks overview, MCP overview, and CLI reference.
- Add frontmatter to every public page.
- Keep old large docs in place for now.

Expected output:

- `/docs` shows the intended public docs structure.
- Old docs are still available in the repo for content migration.

Verification:

- `pnpm run build` in `topchester-web`.
- `pnpm run check` in `topchester-web`.
- Manual sidebar scan for missing or badly ordered pages.

Dependencies:

- Slice 3.

### Slice 5: Migrate Getting Started and Configuration Content

Status: `[ ]` Not started

Goal: Move onboarding and configuration content into clear user-facing pages.

Why here: Intro and config are the highest-value docs for new users and should set the tone for the rest of the migration.

This slice should implement:

- Write `getting-started/intro.md`.
- Write `getting-started/quickstart.md`.
- Write `getting-started/installation.md`.
- Write `getting-started/first-project.md`.
- Split `docs/config.md` and `docs/MODEL_CONFIG.md` into configuration pages.
- Preserve exact config locations and load order.
- Preserve current bash permission and project instruction details.

Expected output:

- A new user can install Topchester, create a minimal config, choose a model, and start a first project from the public docs.
- Configuration pages no longer require reading the old monolithic config docs.

Verification:

- Run any documented quickstart commands in a safe temporary directory if possible.
- `pnpm run build` in `topchester-web`.
- `pnpm run check` in `topchester-web`.
- Search for stale links to moved sections.

Dependencies:

- Slice 4.

### Slice 6: Migrate Feature Docs

Status: `[ ]` Not started

Goal: Split feature docs into pages that explain the user-facing behavior before the internal mechanics.

Why here: Features depend on basic configuration context, so they should follow the onboarding/config pass.

This slice should implement:

- Move `docs/tui.md` into `features/tui.md`.
- Split slash commands into `features/slash-commands.md`.
- Move `docs/SESSIONS.md` into `features/sessions.md`.
- Move `docs/skills.md` into `features/skills.md`.
- Split `docs/KNOWLEDGE.md` into `features/knowledge-base.md` plus internal design notes.
- Keep advanced KB design material under `internals`.

Expected output:

- Public feature pages are readable without architecture context.
- Deep implementation detail remains available but does not dominate the public docs.

Verification:

- `pnpm run build` in `topchester-web`.
- `pnpm run check` in `topchester-web`.
- Manual scan that feature pages answer user tasks first.

Dependencies:

- Slice 5.

### Slice 7: Migrate Hooks and MCP Docs

Status: `[ ]` Not started

Goal: Turn hooks and MCP docs into layered docs: overview first, then precise reference.

Why here: Hooks and MCP are powerful extension surfaces, so they need both approachable examples and exact contract docs.

This slice should implement:

- Split `docs/hooks.md` into hooks overview, events, payloads, and examples.
- Preserve supported event names and payload fields exactly.
- Move config examples for hooks out of monolithic config docs.
- Promote MCP stdio server docs from `docs/config.md` into `mcp/stdio-servers.md`.
- Add `mcp/examples.md`.
- Keep V0 limitations visible for MCP.

Expected output:

- Users can add a hook or MCP stdio server from examples.
- Reference pages retain precise event/payload/config detail.

Verification:

- Validate all hook event names against current code or tests.
- Validate MCP config shape against current config schema.
- `pnpm run build` in `topchester-web`.
- `pnpm run check` in `topchester-web`.

Dependencies:

- Slice 5.

### Slice 8: Reference and Internal Docs Cleanup

Status: `[ ]` Not started

Goal: Move remaining dense material into reference or internal docs, then remove or redirect the old monolithic docs files.

Why here: Cleanup should happen only after public replacements exist.

This slice should implement:

- Create `reference/cli.md` from `docs/cli.md`.
- Create or refine `reference/config-schema.md`.
- Create or refine `reference/model-config.md`.
- Create `reference/troubleshooting.md` if enough troubleshooting material exists.
- Move architecture, drift detection, KB overlay, and agents metadata into `internals`.
- Replace old top-level docs with short redirects/stubs or remove them after all internal links are updated.

Expected output:

- No public docs content depends on the old monolithic files.
- Internal docs remain discoverable in the repo.

Verification:

- `rg -n "docs/(config|MODEL_CONFIG|hooks|cli|KNOWLEDGE|ARCHITECTURE|tui|skills|SESSIONS)\\.md|MODEL_CONFIG.md|KNOWLEDGE.md" .`
- `pnpm run build` in `topchester-web`.
- `pnpm run check` in `topchester-web`.
- `pnpm check` in `topchester-agent` if docs path changes affect tests or package metadata.

Dependencies:

- Slices 5, 6, and 7.

### Slice 9: Agent Maintenance Rules

Status: `[ ]` Not started

Goal: Add explicit repo guidance so future agents update the new docs structure correctly.

Why here: The migration only works long-term if docs updates keep following the new source-of-truth model.

This slice should implement:

- Update `topchester-agent/AGENTS.md` or add `docs/AGENTS.md` with docs maintenance rules.
- Document which folders are public, internal, and private plans.
- Document that behavior changes should update the nearest public docs page and reference page when applicable.
- Document that `docs/plans` remains implementation handoff material.
- Optionally update `topchester-web/AGENTS.md` with build/source rules for docs.

Expected output:

- Agents have clear instructions for future docs edits.
- Website agents know not to edit generated docs output.

Verification:

- Manual review of instructions for ambiguity.
- `pnpm run build` in `topchester-web`.
- `pnpm run check` in `topchester-web`.

Dependencies:

- Slice 4, ideally after the new layout exists.

### Slice 10: CI and Deployment Integration

Status: `[ ]` Not started

Goal: Make production docs builds reproducible without relying on a local sibling checkout.

Why here: Production needs a deterministic source path after the local Eleventy workflow is proven.

This slice should implement:

- Decide between CI clone, deploy-time clone, or submodule.
- Add a deploy/build step that provides `topchester-agent/docs` to `topchester-web`.
- Pin the docs source to an intended branch or commit policy.
- Ensure `/docs` paths are deployed with the landing page.
- Ensure generated docs are link-checked after build.

Expected output:

- `topchester-web` production build includes docs.
- Build fails if docs source is unavailable or malformed.
- Public `/docs` routes are ready for deploy.

Verification:

- Run the production-equivalent build locally if possible.
- Run CI or deploy preview.
- Check `/docs`, `/docs/getting-started/quickstart`, and several deep links in preview.

Dependencies:

- Slices 1 through 4.
- Content migration can continue in parallel, but production docs should not be announced until enough core pages exist.

### Slice 11: Public QA and Launch

Status: `[ ]` Not started

Goal: Verify the docs experience as a user and launch `/docs`.

Why here: Public launch should happen after content, routing, links, and deployment are all proven.

This slice should implement:

- Check desktop and mobile docs layout.
- Check sidebar usability with long page lists.
- Check code blocks and command snippets.
- Check page titles, metadata, and canonical paths if supported.
- Check no private plans or internal-only pages are published accidentally.
- Add redirects from any previously public docs paths if they existed.

Expected output:

- `topchester.com/docs` is usable as the public docs entrypoint.
- Core docs pages are discoverable and readable.

Verification:

- Local or preview browser check for `/docs`.
- Link checker over generated output.
- Manual public route checks after deploy.
- Confirm `docs/plans` content is not present in generated site output.

Dependencies:

- Slices 5 through 10.

## Final Verification

Before marking the migration complete:

- `pnpm run build` passes in `topchester-web`.
- `pnpm run check` passes in `topchester-web`.
- Docs metadata/frontmatter validation passes.
- Generated output contains `/docs/index.html`.
- Generated output does not contain `docs/plans` pages.
- A production-equivalent build can obtain `topchester-agent/docs` without relying on local sibling paths.
- At least these pages render correctly:
  - `/docs/`
  - `/docs/getting-started/quickstart/`
  - `/docs/configuration/config-files/`
  - `/docs/configuration/models-and-providers/`
  - `/docs/hooks/overview/`
  - `/docs/hooks/events/`
  - `/docs/mcp/stdio-servers/`
  - `/docs/reference/cli/`
- Root landing page `/` still works.
- All old internal links to moved docs are updated or intentionally stubbed.

## Open Questions

- What is the current production deploy path for `topchester-web`?
- Should production docs follow the latest `main` of `topchester-agent`, a tagged release, or a pinned commit?
- Should internal docs under `docs/internals` be published behind the public sidebar, published but unlisted, or kept fully private?
- Should `docs/README.md` become the public docs index source, or remain a contributor-facing overview?
- Should the public docs include "Edit this page" links to the agent repo?
- Should old top-level docs files become redirect stubs for a while, or should they be removed once all repo links are migrated?

## Running Findings

- 2026-06-03: Current `topchester-agent/docs` has strong source material but large pages with mixed onboarding, reference, and internal design content.
- 2026-06-03: Current `topchester-web` is static and small, so Eleventy can be introduced without fighting an existing app framework.
- 2026-06-03: The first implementation should prove local adjacent-repo sourcing, then add CI/deploy sourcing before public launch.
