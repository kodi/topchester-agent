---
title: Bash permissions
description: Configure approval rules for the Topchester bash tool.
section: Configuration
order: 30
public: true
---

# Bash permissions

`bash` runs all shell command strings inside the workspace, including tests, lint, typecheck, builds, checks, and smoke scripts. Unknown commands require interactive approval unless project or user config allows the exact command or a prefix under `tools.bash`.

```jsonc
{
  "tools": {
    "bash": {
      "allowExact": ["pnpm check"],
      "allow": ["pnpm test", "mise run"],
      "deny": ["pnpm publish", "npm publish"],
    },
  },
}
```

`allowExact` matches a complete command string. `allow` and `deny` match either that complete string or the string followed by a space and more arguments. For example, `"pnpm test"` also allows `pnpm test test/tools.test.ts`, but it does not allow `pnpm test:watch`. Deny rules win.

Interactive approval can run a command once, allow that exact command for the session, or save that exact command for the repo. Add an `allow` rule to config when a trusted command prefix must accept changing arguments.

Use project config for commands that are safe and expected in the repo. Keep broad permissions out of shared config unless the whole team accepts that policy.

For unattended automation, `topchester run --dangerously-auto-approve` can auto-approve approval-required `bash` prompts without adding allow rules to `topchester.jsonc`. This runtime option does not bypass deny rules, destructive command detection, workspace boundary checks, or hook blocks.
