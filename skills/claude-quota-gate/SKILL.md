---
name: claude-quota-gate
description: Use before expensive, long-running, automated, or quota-sensitive AI coding agent work to check subscription quota and fail closed when quota is low or unknown.
version: 1.0.0
author: Vladimir Orany
license: MIT
metadata:
  hermes:
    tags: [claude-code, codex, antigravity, openusage, quota, usage, automation, guardrail]
    related_skills: []
---

# Claude Quota Gate

## Overview

Use this skill before expensive, long-running, automated, or quota-sensitive AI coding agent routines. It runs a bundled Node.js gate that checks subscription quota and returns a machine-readable allow/skip decision. It supports direct Claude Code usage checks and OpenUsage-backed providers such as Claude, Codex, Antigravity, Cursor, Devin, Grok, OpenRouter, and Z.ai when OpenUsage is running locally.

The gate fails closed. If quota is low, unknown, credentials are missing, the endpoint errors, or the response shape is invalid, do not continue with the requested work.

## Required Check

Before doing the expensive work, run:

```bash
scripts/quota-gate --weekly-min=<N> --five-hour-min=<M>
```

Thresholds are minimum **remaining** percentages.

Default thresholds:

- `--weekly-min=50`
- `--five-hour-min=0`

## Exit Code Contract

- Exit `0`: quota is sufficient; continue with the requested work.
- Exit `2`: quota is below threshold; stop and return only:

```json
{"status":"skipped","reason":"low_ai_quota"}
```

- Exit `1`: quota is unknown because of missing credentials, auth failure, endpoint error, invalid response, or internal error; stop and return only:

```json
{"status":"skipped","reason":"unknown_ai_quota"}
```

## Rules

1. Never estimate Claude quota from conversation context.
2. Never continue if the quota check fails.
3. Never ask for manual token input unless `quota-gate` explicitly reports a missing credential/API-key reason for the selected provider.
4. Treat any non-zero exit as a hard stop for the expensive routine.
5. Do not use MCP for this skill.
6. Do not print or request access tokens or refresh tokens.

## Examples

### Example 1

User prompt:

> Use claude-quota-gate. Execute this only if weekly quota remaining is above 50%; otherwise do nothing.

Expected action:

```bash
scripts/quota-gate --weekly-min=50
```

If exit `0`, continue. If exit `2`, return only:

```json
{"status":"skipped","reason":"low_ai_quota"}
```

If exit `1`, return only:

```json
{"status":"skipped","reason":"unknown_ai_quota"}
```

### Example 2

User prompt:

> Run this refactor only if I have at least 30% of five-hour quota and 60% weekly quota left.

Expected action:

```bash
scripts/quota-gate --weekly-min=60 --five-hour-min=30
```

### Example 3

User prompt:

> Use Codex only if OpenUsage says weekly quota remaining is at least 50%.

Expected action:

```bash
scripts/quota-gate --provider=codex --usage-source=openusage --weekly-min=50
```

### Example 4

User prompt:

> Use Antigravity Claude pool only if its session quota has at least 20% remaining.

Expected action:

```bash
scripts/quota-gate --provider=antigravity --pool=claude --session-min=20
```

## Output Shape

The script always prints JSON. `resets_at` is preserved when the endpoint provides it. When reset time is known, each usage window can include advisory `pacing` metadata showing whether usage is faster than a linear budget for that window.

Allowed:

```json
{
  "allowed": true,
  "reason": "ok",
  "thresholds": {
    "weekly_min_remaining_pct": 50,
    "five_hour_min_remaining_pct": 20
  },
  "usage": {
    "five_hour": {
      "used_pct": 10,
      "remaining_pct": 90,
      "resets_at": "..."
    },
    "weekly": {
      "used_pct": 40,
      "remaining_pct": 60,
      "resets_at": "..."
    }
  }
}
```

Skipped due to low quota:

```json
{
  "allowed": false,
  "reason": "below_threshold",
  "thresholds": {
    "weekly_min_remaining_pct": 50,
    "five_hour_min_remaining_pct": 20
  },
  "usage": {
    "five_hour": {
      "used_pct": 85,
      "remaining_pct": 15,
      "resets_at": "..."
    },
    "weekly": {
      "used_pct": 55,
      "remaining_pct": 45,
      "resets_at": "..."
    }
  }
}
```

Unknown quota:

```json
{"allowed":false,"reason":"missing_claude_code_credentials"}
```

or:

```json
{"allowed":false,"reason":"usage_endpoint_429"}
```

## Verification Checklist

- [ ] Ran `scripts/quota-gate` before expensive work.
- [ ] Continued only on exit `0`.
- [ ] Returned the exact low-quota JSON on exit `2`.
- [ ] Returned the exact unknown-quota JSON on exit `1`.
- [ ] Did not ask for or print OAuth tokens, API keys, or credential files.
