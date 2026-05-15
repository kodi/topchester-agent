# Topchester Agent Skills Plan

## Summary

Add a Topchester skills system that supports the emerging Agent Skills directory standard, ships a small read-only built-in skill set, and exposes skill discovery and activation from both the agent runtime and TUI.

Skills are progressive-disclosure resources. Topchester scans configured skill roots for compact metadata, exposes that metadata to the model and TUI, and loads full `SKILL.md` content only when a skill is activated or inspected. Always-on repository instructions (`AGENTS.md`), on-demand skills (`.agents/skills/`), and generated Topchester knowledge (`.agents/topchester-kb/`) stay separate.

The plan is split into ordered slices so each checkpoint can be implemented, reviewed, and verified without depending on later UI polish.

## Decisions

- Support Agent Skills-style directories with a required `SKILL.md` file.
- Make `.agents/skills/<skill-name>/SKILL.md` the recommended portable in-repo path.
- Support `.topchester/skills/<skill-name>/SKILL.md` as the Topchester-native project override path.
- Support `~/.agents/skills/` and `~/.topchester/skills/` for user/global skills.
- Ship a small set of read-only built-in skills in the Topchester package.
- Built-in skills are lowest precedence and can be overridden by user or workspace skills with the same name.
- Use progressive disclosure: list only name, description, and source by default; load full `SKILL.md` on demand.
- Expose skills through model tools, slash commands, a TUI overlay, and `@skill-name` mention activation.
- Keep `AGENTS.md`, `.agents/skills/`, and `.agents/topchester-kb/` as distinct systems.
- Do not auto-execute skill scripts in the MVP.
- Represent skill activation as a normal conversation event/message, not as a mutation to the base system prompt.
- Reserve precedence for future extension/plugin skills, but do not implement extension/plugin skill providers in the MVP.

## Scope

Included:

- Filesystem skill discovery from built-in, user, workspace, and compatibility roots.
- Markdown `SKILL.md` parsing with optional YAML frontmatter.
- Deterministic duplicate resolution by source precedence.
- Active and shadowed skill descriptors for diagnostics.
- Runtime skills service for listing compact metadata and loading one full skill on demand.
- Model tools:
  - `skills_list`
  - `skill_view`
- Built-in package skills:
  - `code-review`
  - `systematic-debugging`
  - `test-driven-development`
  - `plan`
  - `repo-orientation`
- TUI slash commands:
  - `/skills`
  - `/skills list`
  - `/skills inspect <name>`
  - `/skills reload`
  - `/skill <name>`
  - `/<skill-name>` when it does not conflict with a built-in slash command
- TUI Skills overlay for listing, searching, inspecting, activating, and reloading skills.
- Inline `@skill-name` activation from user input.
- User-facing docs that explain `AGENTS.md` vs `.agents/skills` vs `.agents/topchester-kb`.

Out of scope for the MVP:

- Registry or hub installs from remote sources.
- Automatic skill updates.
- Agent-authored or agent-edited skill management.
- Executing scripts from `scripts/` inside skill directories.
- Trust prompts or sandbox policy for executable skill assets.
- Extension/plugin-provided skills beyond reserving precedence.
- Model tools that write, edit, install, or delete skills.

## Current State

Topchester already treats `AGENTS.md` and `.agents/topchester-kb/` as important instruction and knowledge surfaces, but it does not yet have a first-class on-demand skill system.

The current plan file captured the right product decisions and target behavior, but it was organized as a broad implementation breakdown. This rewrite keeps those decisions and turns the work into slices with concrete boundaries, expected outputs, and per-slice verification.

## Behavior To Preserve

- The normal coding path must not bypass `.agents/topchester-kb/`.
- `AGENTS.md` remains always-on repository guidance, not a skill.
- `.agents/topchester-kb/` remains generated Topchester knowledge, not user-authored skills.
- Full skill bodies are not injected into the base system prompt.
- Unknown or malformed skill directories should not crash startup.
- Built-in slash commands take priority over `/<skill-name>` shortcuts.
- Skill scripts and other assets are discoverable but not executable by default in the MVP.
- User-facing docs and examples should use `~` for home-relative paths.

## Skill Paths

Recommended shared project skills:

```text
.agents/skills/<skill-name>/SKILL.md
```

Topchester-specific workspace overrides:

```text
.topchester/skills/<skill-name>/SKILL.md
```

User/global skills:

```text
~/.agents/skills/<skill-name>/SKILL.md
~/.topchester/skills/<skill-name>/SKILL.md
```

Use `~/.agents/skills/` for portable skills. Use `~/.topchester/skills/` for Topchester-specific personal overrides.

Compatibility discovery paths:

```text
.claude/skills/<skill-name>/SKILL.md
.opencode/skills/<skill-name>/SKILL.md
.gemini/skills/<skill-name>/SKILL.md
.windsurf/skills/<skill-name>/SKILL.md
```

These compatibility paths are supported after first-class paths work. They are not the primary documented Topchester path.

Package built-in skills:

```text
<topchester-package>/skills/code-review/SKILL.md
<topchester-package>/skills/systematic-debugging/SKILL.md
<topchester-package>/skills/test-driven-development/SKILL.md
<topchester-package>/skills/plan/SKILL.md
<topchester-package>/skills/repo-orientation/SKILL.md
```

Built-ins are read-only. If users want to customize one, they copy/eject it to a user or workspace skill directory.

## Skill Format

Support this directory shape:

```text
<skills-root>/<skill-name>/
  SKILL.md
  references/   # optional
  templates/    # optional
  scripts/      # optional, not executable by default in MVP
  assets/       # optional
```

`SKILL.md` is Markdown with optional YAML frontmatter. MVP should require or strongly prefer `name` and `description`.

```md
---
name: code-review
description: Review code for correctness, security, maintainability, and project conventions.
---

# Code Review

## When to Use

Use when reviewing a diff before merge.

## Procedure

...

## Verification

...
```

If frontmatter is missing:

- derive `name` from the directory name;
- set description to `No description provided.`;
- still allow inspection and activation.

Example portable project skill:

```text
.agents/skills/release-checklist/SKILL.md
```

```md
---
name: release-checklist
description: Prepare and verify a release.
---

# Release Checklist

## When to Use

Use before publishing a new version.

## Procedure

1. Run local CI.
2. Check changelog.
3. Verify package contents.
4. Tag and publish.

## Verification

Confirm the published package installs successfully.
```

## Precedence

Resolve duplicate skill names from lowest to highest precedence:

1. built-in Topchester skills
2. extension/plugin skills, if present later
3. user neutral skills: `~/.agents/skills/`
4. user Topchester skills: `~/.topchester/skills/`
5. workspace compatibility skills: `.claude/skills/`, `.opencode/skills/`, `.gemini/skills/`, `.windsurf/skills/`
6. workspace neutral skills: `.agents/skills/`
7. workspace Topchester skills: `.topchester/skills/`
8. explicit session-preloaded skills, if added later

The highest-precedence candidate is active. Lower-precedence candidates are shadowed and should be visible in diagnostics.

## Progressive Disclosure

Do not inject full skill contents into the base system prompt.

At startup or prompt build, expose only compact metadata:

```text
Available skills:
- code-review: Review code for correctness, security, maintainability, and project conventions.
- systematic-debugging: Debug by identifying root cause before changing code.
```

Load full content only when:

- the model calls `skill_view`;
- the user runs `/skill <name>`;
- the user runs `/<skill-name>`;
- the user mentions `@skill-name`;
- a future session preload mechanism explicitly requests it.

Suggested internal activation payload:

```text
Use the following skill for this task.

[Skill: code-review]
[Skill directory: <absolute path to skill>]

<full SKILL.md content>

User instruction:
<original user instruction>
```

This keeps activation auditable and avoids destabilizing prompt caching.

## Data Model

Introduce core skill types similar to:

```ts
export type SkillSourceKind =
  | "builtin"
  | "extension"
  | "user-neutral"
  | "user-topchester"
  | "workspace-compat"
  | "workspace-neutral"
  | "workspace-topchester"
  | "session";

export interface SkillDescriptor {
  name: string;
  description: string;
  source: SkillSourceKind;
  root: string;
  skillDir: string;
  skillFile: string;
  precedence: number;
  shadowed: boolean;
  shadowedBy?: string;
  compatibilitySource?: "claude" | "opencode" | "gemini" | "windsurf";
  frontmatter?: Record<string, unknown>;
}

export interface LoadedSkill extends SkillDescriptor {
  content: string;
  linkedFiles: {
    references: string[];
    templates: string[];
    scripts: string[];
    assets: string[];
  };
}
```

## Implementation Shape

Add a skills service that can:

- build the ordered skill root list for package, user, and workspace paths;
- scan each root for `<name>/SKILL.md` directories;
- parse frontmatter;
- resolve duplicate names by precedence;
- cache discovery results for the session;
- reload on demand;
- return active and shadowed skills;
- load full `SKILL.md` content by active skill name;
- list linked files under `references/`, `templates/`, `scripts/`, and `assets/`;
- reject path traversal when reading linked files.

Expose two MVP model tools:

```ts
skills_list(): Promise<ResolvedSkills>
skill_view({ name }: { name: string }): Promise<LoadedSkill>
```

`skills_list` returns compact descriptors only. `skill_view` returns full content for one skill.

Do not expose skill write/edit tools in the MVP.

## Command Behavior

`/skills` opens the TUI Skills overlay.

`/skills list` shows compact active skill metadata:

```text
code-review               workspace .agents/skills
  Review code for correctness, security, maintainability, and project conventions.
```

`/skills inspect <name>` shows full `SKILL.md` content and source path. It does not activate the skill.

`/skills reload` clears cache and rescans skill roots. Report added, removed, and changed counts if cheap.

`/skill <name> [instruction]` activates the named skill and passes optional trailing instruction to the next agent turn.

`/<skill-name> [instruction]` behaves like `/skill <skill-name> [instruction]` only when no built-in slash command matches and `<skill-name>` is active.

`@skill-name` activates the named skill from user input while preserving the original text.

## TUI Overlay

The Skills overlay should allow:

- listing active skills grouped or labeled by source;
- filtering/searching by text;
- inspecting full `SKILL.md`;
- activating a selected skill;
- reloading discovery;
- viewing shadowed duplicates in an advanced/details view.

Suggested keybindings:

```text
Up/Down   move selection
Enter     inspect
a         activate
r         reload
/         search/filter
q/Esc     close/back
```

## Inline Mention Activation

Allow users to invoke skills inline:

```text
@code-review review this diff
Use @systematic-debugging on this failing layout
```

Rules:

- Match only active skill names.
- Leave unknown mentions untouched.
- Preserve original user text.
- If multiple skills are mentioned, activate them in mention order.

## Files To Add Or Change

Likely files or modules:

- `src/skills/types.ts`
- `src/skills/frontmatter.ts`
- `src/skills/roots.ts`
- `src/skills/scanner.ts`
- `src/skills/resolve.ts`
- `src/skills/service.ts`
- model tool registry files
- TUI slash command registry and handler files
- TUI overlay component/state files
- JSON-RPC bridge/server files if the overlay needs runtime service calls
- input parsing module for `@skill-name`
- built-in `skills/**/SKILL.md` package files
- package build or manifest files if needed
- `docs/skills.md` or equivalent docs page
- `docs/cli.md`
- tests under the existing unit/TUI test layout

Adjust paths after inspecting the current repository structure.

## Slices

### Slice 1: Skill Model, Frontmatter, And Roots

Status: `[x]` Done

Goal: Add the core skill types, frontmatter parser, and deterministic root ordering without changing runtime behavior.

Why here: Later discovery, services, tools, and UI work depend on one stable descriptor shape and one stable source precedence contract.

This slice should implement:

- Add `SkillDescriptor`, `LoadedSkill`, `SkillSourceKind`, and related result types.
- Parse optional YAML frontmatter from `SKILL.md`.
- Derive a skill name from the directory when frontmatter is missing.
- Default a missing description to `No description provided.`.
- Build a low-to-high precedence root list for built-in, user, workspace, compatibility, and future session roots.
- Add focused tests for parsing and root order.

Expected output:

- Skill metadata can be represented and parsed without scanning the whole filesystem.
- Root ordering captures the accepted precedence decisions.
- No model prompt, TUI, or command behavior changes yet.

Verification:

```sh
pnpm test
```

Actual verification:

```sh
pnpm test test/skills.test.ts
pnpm typecheck
```

Dependencies: None.

### Slice 2: Filesystem Scanner And Precedence Resolver

Status: `[ ]` Not started

Goal: Discover skill directories and choose the active descriptor for each duplicate skill name.

Why here: The runtime service and model tools need deterministic active/shadowed descriptors before they can expose skills.

This slice should implement:

- Scan `<skills-root>/<skill-name>/SKILL.md`.
- Ignore directories without `SKILL.md`.
- Discover optional `references/`, `templates/`, `scripts/`, and `assets/` directories as linked file groups.
- Resolve duplicate names by the root precedence from Slice 1.
- Mark lower-precedence descriptors as shadowed.
- Include `shadowedBy` and compatibility source details where applicable.
- Keep malformed skill directories from crashing startup.
- Add tests for discovery, ignored directories, duplicate resolution, and shadowed diagnostics.

Expected output:

- A filesystem-backed resolver can return active descriptors plus shadowed duplicates.
- Compatibility paths can be represented even if their full docs land later.

Verification:

```sh
pnpm test
```

Dependencies: Slice 1.

### Slice 3: Skills Service And Model Tools

Status: `[ ]` Not started

Goal: Provide runtime APIs for listing compact metadata and loading full skill content on demand.

Why here: This is the runtime boundary that keeps progressive disclosure enforceable before slash commands or overlays activate skills.

This slice should implement:

- Add a cached skills service with `listSkills()`, `viewSkill(name)`, and `reloadSkills()` or equivalent methods.
- Return active and shadowed descriptors from list APIs.
- Load the active skill's full `SKILL.md` only for explicit view/activation.
- Return a clear error for unknown skill names.
- Reject path traversal when reading linked files.
- Register `skills_list` and `skill_view` model tools.
- Ensure `skills_list` exposes only compact descriptors.
- Add tests for service behavior, cache reload, unknown names, traversal rejection, and model tool handlers.

Expected output:

- The model can discover available skills without receiving full skill bodies.
- The model can request one full skill by name.
- The service boundary is reusable by slash commands and TUI.

Verification:

```sh
pnpm test
```

Dependencies: Slices 1-2.

### Slice 4: Built-In Skills Packaging

Status: `[ ]` Not started

Goal: Ship a small read-only built-in skill set and ensure package artifacts include them.

Why here: Built-ins exercise the lowest-precedence source and give users useful skills before they create project or user skills.

This slice should implement:

- Add built-in `SKILL.md` files for:
  - `code-review`
  - `systematic-debugging`
  - `test-driven-development`
  - `plan`
  - `repo-orientation`
- Keep built-in skill copy plain and focused on reusable workflow steps.
- Wire the built-in package skill root into root discovery.
- Ensure workspace and user skills with the same name override built-ins.
- Update package build or manifest settings so built-in skill files are included in published artifacts.
- Add tests for built-in scanning, override behavior, and package inclusion where the repo has a suitable packaging test.

Expected output:

- Built-in skills are available by default.
- Built-ins are read-only and lowest precedence.
- Published package artifacts include `skills/**/SKILL.md`.

Verification:

```sh
pnpm test
pnpm pack --dry-run
```

Dependencies: Slices 1-3.

### Slice 5: Slash Commands And Activation Events

Status: `[ ]` Not started

Goal: Add `/skills`, `/skills list`, `/skills inspect`, `/skills reload`, `/skill <name>`, and `/<skill-name>` behavior.

Why here: The service can already list and view skills, so command work can focus on user intent, activation event shape, and conflict rules.

This slice should implement:

- Route `/skills` to the Skills overlay state.
- Implement `/skills list` through the skills service.
- Implement `/skills inspect <name>` so it loads and displays full content without activating the skill.
- Implement `/skills reload` so it clears service caches and rescans roots.
- Implement `/skill <name> [instruction]` so it creates a skill activation event/message.
- Implement `/<skill-name> [instruction]` only when no built-in slash command conflicts.
- Preserve original user instruction text in activation events.
- Add tests for slash command parsing, command dispatch, activation event shape, and conflict priority.

Expected output:

- Users can list, inspect, reload, and activate skills from the TUI command line.
- Slash activation and later overlay activation can share the same internal event shape.

Verification:

```sh
pnpm test
```

Dependencies: Slices 1-4.

### Slice 6: TUI Skills Overlay

Status: `[ ]` Not started

Goal: Add a navigable UI for listing, inspecting, activating, searching, and reloading skills.

Why here: Overlay work should build on the service and activation event shape rather than defining separate behavior.

This slice should implement:

- Add overlay state and rendering for active skills with source labels.
- Show shadowed duplicates in an advanced/details view.
- Support search/filter.
- Let `Enter` inspect the selected skill.
- Let `a` activate the selected skill using the same event shape as `/skill <name>`.
- Let `r` reload discovery.
- Let `q` or `Esc` close/back out.
- Add component or TUI tests for listing, inspecting, activating, reloading, search, and close behavior.

Expected output:

- `/skills` opens a usable Skills overlay.
- TUI and slash activation use the same runtime contract.
- Shadowed duplicates are visible enough for diagnostics.

Verification:

```sh
pnpm test
```

Dependencies: Slices 3 and 5.

### Slice 7: Inline Mention Activation

Status: `[ ]` Not started

Goal: Let users activate skills inline by mentioning active skill names.

Why here: Mention activation depends on the service's active skill list and the activation event shape established by slash commands.

This slice should implement:

- Parse `@skill-name` mentions from user input.
- Support hyphen, underscore, and dot in skill names.
- Match only active skill names.
- Ignore unknown mentions.
- Activate multiple mentioned skills in mention order.
- Preserve the original user text.
- Add parser and conversation-event tests.

Expected output:

- Inputs such as `@code-review review this diff` activate `code-review`.
- Unknown mentions remain normal text.
- Inline activation does not mutate the user's original prompt.

Verification:

```sh
pnpm test
```

Dependencies: Slices 3 and 5.

### Slice 8: Compatibility Fixtures And Docs

Status: `[ ]` Not started

Goal: Prove compatibility paths work and document how users should structure and activate skills.

Why here: Compatibility and docs should land after the runtime and UI behavior settle, so examples reflect the actual implementation.

This slice should implement:

- Add tests or fixtures for `.claude/skills`, `.opencode/skills`, `.gemini/skills`, and `.windsurf/skills`.
- Assert `.agents/skills` shadows compatibility paths.
- Assert `.topchester/skills` shadows `.agents/skills`.
- Document recommended portable and Topchester-native skill paths.
- Document user/global paths.
- Document compatibility paths as secondary discovery locations.
- Document `AGENTS.md` vs `.agents/skills` vs `.agents/topchester-kb`.
- Update `docs/cli.md` for new slash commands and overlay behavior.
- Record final verification results in this plan.

Expected output:

- Users have a clear skills guide.
- CLI/TUI command docs match implemented behavior.
- Compatibility support is covered by tests.

Verification:

```sh
pnpm test
pnpm check
```

Dependencies: Slices 1-7.

## Cross-Slice Rules

- Keep full skill bodies out of the base system prompt.
- Keep `AGENTS.md`, `.agents/skills/`, and `.agents/topchester-kb/` distinct.
- Keep built-in skills read-only and lowest precedence.
- Keep compatibility paths lower priority than `.agents/skills/`.
- Keep `.topchester/skills/` higher priority than `.agents/skills/`.
- Do not execute `scripts/` assets in the MVP.
- Preserve built-in slash command priority over `/<skill-name>`.
- Use the same activation event/message shape across slash commands, overlay actions, and mentions.
- Keep docs and visible copy plain and concrete.
- Update relevant docs in the same slice that changes user-facing behavior.

## Testing Plan

Per-slice verification is listed above. Use narrower test commands after inspecting the actual package scripts and test layout.

Suggested targeted commands:

```sh
pnpm test
pnpm check
pnpm pack --dry-run
```

Final verification before calling the MVP done:

```sh
pnpm check
```

Manual checks after implementation:

- Create `.agents/skills/release-checklist/SKILL.md` and confirm it appears in `/skills list`.
- Create `.topchester/skills/release-checklist/SKILL.md` and confirm it shadows the `.agents` skill.
- Confirm built-in `code-review` appears when no higher-precedence override exists.
- Run `/skills inspect code-review` and confirm it does not activate the skill.
- Run `/skill code-review review this diff` and confirm the next agent turn receives the skill content.
- Run `/code-review review this diff` and confirm it works only when no built-in slash command conflicts.
- Type `@code-review review this diff` and confirm the original text is preserved.
- Confirm shadowed duplicates are visible in diagnostics or the overlay details view.

Do not ship without verifying:

- no full skill bodies are injected into the base system prompt;
- unknown or malformed skill directories do not crash startup;
- duplicate skill names produce deterministic active/shadowed results;
- built-in skills are included in the package artifact;
- slash command conflicts prefer built-in commands over skill shortcuts;
- TUI activation, slash activation, and mention activation produce the same internal event shape.

## Definition Of Done For MVP

- `.agents/skills/<name>/SKILL.md` is discovered from a workspace.
- `.topchester/skills/<name>/SKILL.md` is discovered from a workspace.
- `~/.agents/skills/<name>/SKILL.md` is discovered for user skills.
- `~/.topchester/skills/<name>/SKILL.md` is discovered for user skills.
- Built-in skills are discovered and treated as read-only/lowest precedence.
- Workspace skills override user and built-in skills by name.
- `.topchester/skills` overrides `.agents/skills` for the same name.
- Compatibility paths are discovered and lower priority than `.agents/skills`.
- Shadowed duplicate skills are visible for diagnostics.
- `skills_list` exposes only compact metadata.
- `skill_view` loads full `SKILL.md` on demand.
- `/skills` opens the TUI Skills overlay.
- `/skills list`, `/skills inspect <name>`, and `/skills reload` work.
- `/skill <name>` activates a skill.
- `/<skill-name>` activates a skill when not conflicting with a built-in command.
- `@skill-name` activates a skill mention.
- Docs explain `AGENTS.md` vs `.agents/skills` vs `.agents/topchester-kb`.
- Local CI passes.

## Open Questions

1. Should session-preloaded skills be implemented immediately after the MVP or only after real usage shows a need?
   - MVP answer: reserve precedence for them, but do not implement them.
2. Should Topchester expose a command to eject built-in skills into user or workspace roots?
   - MVP answer: document manual copy/eject only.
3. Should `scripts/` execution be supported later?
   - MVP answer: not in this plan. A later plan needs trust, sandbox, and approval rules first.
4. Should extension/plugin skills be included in the first implementation?
   - MVP answer: no. Reserve source precedence only.

## Working Notes

- 2026-05-16: Reworked the existing skills implementation plan from broad implementation sections into ordered slices. Product decisions, path choices, precedence, progressive disclosure, command behavior, data model, and MVP definition were preserved.
- 2026-05-16: Slice 1 added `src/skills` core types, frontmatter metadata parsing, deterministic root ordering, and focused tests.

## Next Slice

Start with Slice 2: Filesystem Scanner And Precedence Resolver.
