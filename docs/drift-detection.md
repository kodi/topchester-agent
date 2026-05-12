# Drift Detection

Status: Draft

## Purpose

This note describes how Topchester should detect stale knowledge base entries without
turning every agent interaction into a full repository hash walk.

See `docs/kb-session-overlay.md` for how dirty KB state should behave during an
active coding session.

The core rule stays conservative: every in-scope file content change is potentially
semantic. A changed source file can invalidate its L1 file entry and can propagate
upward into L2 module knowledge and L3 feature knowledge.

## Correctness Boundary

The canonical KB truth is the content hash stored with each entry.

For L1 file entries:

- Store the exact file content hash in the canonical KB entry.
- During drift checks, compare current file bytes against that stored hash.
- If the hash differs, the L1 entry is stale.
- If an in-scope file exists without an L1 entry, the KB is incomplete.
- If an L1 entry points to a missing file, the KB has orphaned knowledge.

Metadata such as `mtime`, inode, device id, and cached stat information is useful
for speed, but it is not the source of truth. Those fields are local-machine state
and should not be required for canonical KB reproducibility.

## What Git Status Does

Git gets fast status by avoiding unnecessary content reads.

The Git index stores each tracked path with its object id and cached filesystem
metadata such as file mode, size, modification time, change time, and related stat
fields. When `git status` runs, Git can usually `stat` a file and decide that it
has not changed without opening and hashing its contents.

If metadata suggests a possible change, or if Git hits an ambiguous case, Git
falls back to reading file content and comparing it to the indexed object. Large
repositories can also use optimizations such as filesystem monitoring, untracked
cache, split index, sparse checkout, and pathspec-limited checks.

The useful lesson for Topchester is the two-stage shape:

1. Use cheap metadata to find candidate paths that might have changed.
2. Use content hashes to prove whether KB knowledge is actually current.

## Storage Split

Keep stable facts in the committed canonical KB:

```text
topchester-kb/
  manifest.json
  l1-files/<source-path>.json
  l2-modules/*.json
  l3-features/*.json
  graph/edges.jsonl
```

Canonical entries should include stable facts such as:

- source path
- content hash
- entry schema version
- compiler version
- dependency and evidence links
- module and feature hash inputs

Keep Git-style acceleration data in the generated runtime cache:

```text
.agents/topchester-kb-cache/
  kb.sqlite
```

The cache can store machine-local fields such as:

- canonical manifest hash or version
- compiler version
- source path
- canonical content hash
- last observed size
- last observed `mtime`
- last observed file mode
- dirty flag from file watching
- reverse links to affected L2 modules and L3 features

This keeps the canonical KB diffable and reproducible while still allowing fast
interactive drift checks.

If the canonical manifest hash, compiler version, or schema version does not match
the cache metadata, discard or rebuild the cache before trusting fast-path results.

## V0 Algorithm

The first implementation does not need filesystem watching. It can still be fast
enough for normal repositories with a Git-style stat filter.

For a workspace drift check:

1. Build or load a metadata-first in-scope file inventory using the same inclusion
   and ignore policy as the Knowledge Compiler.
2. For each in-scope file, compare current stat metadata to the cache record.
3. If metadata matches, treat the file as current for the fast path.
4. If metadata is missing, changed, or absent from cache, hash the file bytes.
5. Compare the current hash to the canonical L1 entry hash.
6. Report changed files, missing entries, and orphaned entries.
7. Propagate changed or missing children upward to modules and features.

The drift inventory should not blindly reuse the current L1 inventory implementation
if that implementation hashes every file while listing. It should share the same
path selection rules, but defer file hashing until the metadata filter identifies a
candidate path or an exact-check mode requires it.

When no runtime cache exists, Topchester can fall back to hashing all in-scope
files and then populate the cache. That is slower, but correct.

Strict and CI checks should prefer exact hashing over cache-assisted shortcuts.

## Propagation

L1 drift is exact: the file hash either matches or it does not.

L2 and L3 drift should be conservative:

- If a child file changed, the owning module is `suspect`.
- If module membership changed, the module is `suspect` even when file contents
  did not change.
- If a linked file, module, route, command, test, config, doc, screen, or other
  feature evidence changed, the feature is `suspect`.
- If a parent hash no longer matches the Merkle-style hash of its declared inputs,
  the parent is stale or invalid.

Do not classify parent knowledge as safe just because the source diff looks small.
The first pass should prefer visible warnings over clever semantic suppression.

## Status Labels

Use a small status vocabulary:

- `current`: hashes match and required dependencies exist.
- `changed`: current file hash differs from the KB hash.
- `missing_entry`: an in-scope source file has no KB entry.
- `missing_file`: a KB entry points to a file that no longer exists.
- `suspect`: a child or evidence node changed and parent meaning may be stale.
- `invalid`: a KB entry failed schema or hash-input validation.

## API Shape

The service method should stay close to the existing design:

```json
{
  "paths": ["src/server/routes/users.ts"],
  "include_dependents": true
}
```

The response should include:

- stale L1 files
- missing L1 entries
- orphaned L1 entries
- affected modules
- affected features
- recommended refresh actions
- whether the answer came from exact hashing or cache-assisted checks

For interactive agent use, default to advisory mode. The agent should warn clearly
when relevant KB knowledge is stale, but V0 should still allow work to continue.

## Future Optimizations

After the stat-filtered V0 works, Topchester can add:

- filesystem watching to maintain a dirty-path set
- path-limited checks before editing or answering a scoped question
- Git integration for tracked-file inventory hints
- reverse-edge indexes for fast impact calculation
- background refresh after source edits
- CI drift checks that run exact hashing, not cache-assisted shortcuts

Git can help with speed and inventory, but it should not be the sole source of
truth for KB freshness. Topchester needs to detect the current workspace state,
including uncommitted edits, untracked in-scope files, checkout changes, and any
source state the agent is about to rely on.
