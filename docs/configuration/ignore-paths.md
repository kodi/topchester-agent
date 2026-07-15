---
title: Ignore paths
description: Exclude generated or noisy files from Topchester project knowledge.
section: Configuration
order: 50
public: true
---

# Ignore paths

Use `ignore.paths` to exclude generated, vendored, or noisy paths from Topchester project knowledge and file discovery.

```jsonc
{
  "ignore": {
    "paths": ["dist", "coverage", "*.log"],
  },
}
```

Ignore paths belong in `topchester.jsonc` when the rule is shared project policy. Use user config only for personal local paths.

Keep generated state out of Git unless a Topchester doc explicitly says it is canonical project knowledge.

These rules apply only to project knowledge. The built-in Topchester product source is compiled from its own allowlisted package inputs and is never controlled by the current repository's `ignore.paths` or `TOPCHESTER_KB_DIR`.
