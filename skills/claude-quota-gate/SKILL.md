---
name: claude-quota-gate
description: "Deprecated compatibility alias for quota-gate. Use quota-gate for new installs and prompts."
version: 1.0.0
author: Telegraphic
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [quota, claude, codex, agents, guardrail]
---

# Claude Quota Gate Compatibility Alias

This skill name is deprecated. Use `quota-gate` for new prompts and installs.

This alias exists so existing agents, installed skill references, and scripts that still call the old path do not break immediately after the rename.

## Required Action

Before expensive, long-running, automated, or quota-sensitive AI coding work, run the compatibility launcher from this skill directory:

```bash
scripts/quota-gate --weekly-min=<N> --five-hour-min=<M>
```

The launcher delegates to the renamed `quota-gate` skill installed beside this alias. Interpret the JSON output exactly like `quota-gate`:

- exit `0`: allowed
- exit `2`: quota below threshold; skip the work
- exit `1`: unknown/error/missing runtime; fail closed and skip the work

Prefer migrating prompts and docs to `quota-gate` when you touch them.
