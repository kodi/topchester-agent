---
title: Bash permissions
description: Configure approval rules for the Topchester bash tool.
section: Configuration
order: 30
public: true
---

# Bash permissions

`bash` runs shell command strings inside the workspace. Unknown commands require interactive approval unless project or user config allows the exact command or a prefix under `tools.bash`.

```jsonc
{
  "tools": {
    "bash": {
      "allowExact": ["pnpm check"],
      "allow": [["pnpm", "test"]],
      "deny": [["rm", "-rf"]],
    },
  },
}
```

`allowExact` matches a complete command string. `allow` and `deny` match command argv prefixes after parsing. Deny rules win.

Use project config for commands that are safe and expected in the repo. Keep broad permissions out of shared config unless the whole team accepts that policy.

For benchmark or automation runs, `topchester run --dangerously-auto-approve` can auto-approve approval-required `bash` prompts without adding allow rules to `topchester.jsonc`. This runtime mode does not bypass deny rules, destructive command detection, workspace boundary checks, or hook blocks.

Terminal-Bench runs should use `topchester run --dangerously-auto-approve --benchmark-profile terminal-bench`. That explicit benchmark profile keeps configured bash deny rules, but allows broad shell commands inside the disposable benchmark container and treats successful bash work as valid task-change evidence for non-code tasks.
