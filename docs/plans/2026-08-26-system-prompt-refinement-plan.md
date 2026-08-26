# System Prompt Refinement

## Summary

Make the Topchester system prompt shorter and clearer without weakening repository safety, project KB use, or text-tool compatibility.

## Decisions

- Keep global behavior in the core system prompt.
- Keep tool-specific constraints in tool definitions.
- Add text JSON or XML instructions only when that protocol is used.
- Keep native tool mode free of text-call syntax.
- Preserve the automatic project KB context pack and project instructions.
- Do not add model-family prompt forks without evaluation evidence.

## Scope

This change covers prompt assembly, tool-protocol guidance, prompt tests, and public model configuration docs. It does not change tool permissions, tool argument schemas, or approval enforcement.

## Behavior To Preserve

- Native tools remain the first choice in automatic mode.
- Automatic mode can fall back to text JSON when a provider rejects native tools.
- Forced text JSON and text XML modes remain usable.
- Tool availability still follows the active agent profile and runtime catalog.
- The model still reads current source before relying on KB summaries for exact facts.

### Slice 1: Core behavior prompt

Status: `[x]` Done

- add explicit request-intent, workspace-preservation, scope, and secret-handling rules
- clarify that the runtime owns approval prompts
- remove repeated tool-specific instructions

Verification: focused prompt tests.

Result: Added intent, KB evidence, scope, workspace preservation, secret handling, verification, and approval ownership rules. Removed repeated tool mechanics from the core prompt.

Dependencies: none.

### Slice 2: Protocol guidance

Status: `[x]` Done

- add native, text JSON, and text XML prompt paths
- append text-tool catalogs from the active runtime tool definitions
- keep automatic fallback compatible

Verification: model gateway and runtime protocol tests.

Result: Native prompts now rely on native schemas. Text JSON and XML prompts receive a generated catalog from the active runtime definitions. Automatic fallback replaces native guidance with text JSON guidance before retrying.

Dependencies: Slice 1.

### Slice 3: Tool descriptions

Status: `[x]` Done

- move essential selection and safety details into native tool descriptions
- keep text examples only in text-protocol prompts

Verification: tool registry tests and rendered prompt checks.

Result: Expanded the native descriptions for planning, reading, search, inspection, shell, edit, and write tools. The rendered primary prompts are about 599 words for native, 1,462 for text JSON, and 1,370 for text XML.

Dependencies: Slice 2.

### Slice 4: Documentation and final checks

Status: `[x]` Done

- document protocol-specific prompt behavior
- run focused tests and `mise run local-ci`
- record final prompt size and verification results

Verification: `mise run test-node`, `mise run local-ci`, and `git diff --check`.

Result:

- `mise run test`: passed, 51 files and 754 tests; production OpenTUI renderer passed
- `mise run local-ci`: passed formatting, lint, and type checks
- focused protocol tests: passed, 4 files and 170 tests
- `git diff --check`: passed

Dependencies: Slices 1 through 3.
