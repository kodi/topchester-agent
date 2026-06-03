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
