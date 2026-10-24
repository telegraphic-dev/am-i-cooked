---
name: quota-gate
description: Use before expensive, long-running, automated, or quota-sensitive AI coding agent work to check subscription quota and fail closed when quota is low or unknown. Supports Claude Code, Codex, and Cursor, including the Grok Bot weekly allowance.
version: 1.0.0
author: Vladimir Orany
license: MIT
metadata:
  hermes:
    tags: [claude-code, codex, cursor, grok-bot, quota, usage, automation, guardrail]
    related_skills: []
---

# Quota Gate

## Overview

Use this skill before expensive, long-running, automated, or quota-sensitive AI coding agent routines. It runs a bundled Node.js gate that checks subscription quota and returns a machine-readable allow/skip decision. It supports direct Claude Code, Codex, and Cursor usage checks using local CLI credentials, including the Grok Bot weekly allowance. No resident OpenUsage app is required.

Default provider is `claude`, because this skill is currently installed into Claude Code. For Codex quota checks, pass `--provider=codex`. For Cursor, pass `--provider=cursor`. For the Grok Bot weekly meter only, pass `--provider=grokbot`.

The gate fails closed. If quota is low, unknown, credentials are missing, the endpoint errors, or the response shape is invalid, do not continue with the requested work.

## Required Check

Before doing the expensive work, run:

```bash
scripts/quota-gate --weekly-min=<N> --five-hour-min=<M>
```

For automatic Claude Code enforcement, install/enable the bundled plugin. Claude Code reads `hooks/hooks.json` from the plugin and runs the `UserPromptSubmit` hook automatically. The hook command is:

```bash
${CLAUDE_PLUGIN_ROOT}/skills/quota-gate/scripts/claude-quota-hook
```

The hook runs this gate only when the prompt looks quota-sensitive, and blocks the prompt if quota is below its hard floor or unknown. It conforms to Claude Code's expected format: exit `0`, no stdout to allow, and stdout containing only `{"decision":"block","reason":"..."}` to block.

The plugin hook uses conservative default hard floors (`10%` weekly and `10%` five-hour remaining) so it only stops expensive prompts near exhaustion. The standalone `quota-gate` command keeps a stricter weekly default for explicit/manual checks.

Optional environment controls:

- `QUOTA_GATE_WEEKLY_MIN=<0..100>` to override the hook's weekly hard floor. Default: `10`.
- `QUOTA_GATE_FIVE_HOUR_MIN=<0..100>` to override the hook's five-hour hard floor. Default: `10`.
- `QUOTA_GATE_CACHE_TTL_SECONDS=<n>` to set the usage cache freshness window.
- `QUOTA_GATE_NO_CACHE=1` to bypass the usage cache.
- `QUOTA_GATE_DEBUG=1` to print token-redacted diagnostics to stderr.
- `QUOTA_GATE_HOOK_PATTERN=<javascript-regex>` to override the trigger heuristic.
- `QUOTA_GATE_HOOK_ALWAYS=1` to check every prompt.

For Codex quota checks, select the Codex provider explicitly:

```bash
scripts/quota-gate --provider=codex --weekly-min=<N> --session-min=<M>
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

1. Never estimate provider quota from conversation context.
2. Never continue if the quota check fails.
3. Never ask for manual token input unless `quota-gate` explicitly reports a missing credential/API-key reason for the selected provider.
4. Treat any non-zero exit as a hard stop for the expensive routine.
5. Do not use MCP for this skill.
6. Do not print or request access tokens or refresh tokens.

## Examples

### Example 1

User prompt:

> Use quota-gate. Execute this only if weekly quota remaining is above 50%; otherwise do nothing.

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

> Use Codex only if weekly quota remaining is at least 50%.

Expected action:

```bash
scripts/quota-gate --provider=codex --weekly-min=50
```

### Example 4

User prompt:

> Use quota-gate. Continue only if the Grok Bot weekly allowance has at least 40% remaining.

Expected action:

```bash
scripts/quota-gate --provider=grokbot --weekly-min=40
```

## Using quota-gate from Grok Bot

A Grok Bot agent checks its weekly allowance before expensive work. That allowance is billed through Cursor. quota-gate reads the Cursor CLI login on the computer where the agent runs.

Install the Cursor CLI when `cursor-agent` is not already on `PATH`:

```bash
curl -fsS https://cursor.com/install | bash
```

The installer places `cursor-agent` and `agent` in `~/.local/bin`.

Start login in the background so the command can print a URL and keep waiting:

```bash
NO_OPEN_BROWSER=1 cursor-agent login
```

Send the printed `cursor.com/loginDeepControl` URL to the human. They approve it on any device that is already signed in to Cursor.

Confirm the login:

```bash
cursor-agent status
```

Then run the gate:

```bash
scripts/quota-gate --provider=grokbot --weekly-min=50
```

`--provider=grokbot` checks the Grok Bot weekly meter. Remaining percent is `100 - usagePercent`, and the reset time is `nextResetTimestampUtc`. `--provider=cursor` checks Cursor as well. On a unified plan it uses that same Grok Bot meter. See the unified-plan note below.

A Cursor CLI login lasts about 60 days.

### When the login expires

When the access token is expired, or the usage API returns 401 or 403, quota-gate runs `cursor-agent status` once if the CLI is installed. It re-reads the CLI login and retries the usage request once. quota-gate does not refresh tokens itself, and it does not put the access token or refresh token on the command line.

If the login is still expired or the retry is still unauthorized, the gate exits 1:

```json
{"allowed":false,"reason":"auth_expired","hint":"Login expired. Re-run `NO_OPEN_BROWSER=1 cursor-agent login` in the background, send the printed URL to the human to approve, confirm with `cursor-agent status`, then retry."}
```

Run `NO_OPEN_BROWSER=1 cursor-agent login` in the background again, send the new URL to the human, confirm with `cursor-agent status`, and run quota-gate again.

### Unified plans

Some Cursor subscriptions are unified (`isUnified: true`, or a `membershipType` such as `unified_ultra`). On those plans the Cursor billing-cycle meter can read 0% while Grok Bot shows the shared pool. quota-gate does not treat that 0% as quota left. On a unified plan the Grok Bot meter is the gate. On any other plan, `--provider=cursor` gates on whichever meter has less remaining, so a quiet meter cannot report plenty left.

Missing fields, non-200 responses, and an expired token that the CLI cannot refresh are unknown (exit 1). They are not an allow, and they are not a low-quota result.

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

or, when a Cursor CLI login is expired:

```json
{"allowed":false,"reason":"auth_expired","hint":"Login expired. Re-run `NO_OPEN_BROWSER=1 cursor-agent login` in the background, send the printed URL to the human to approve, confirm with `cursor-agent status`, then retry."}
```

## Verification Checklist

- [ ] Ran `scripts/quota-gate` before expensive work, or verified the Claude Code hook ran it.
- [ ] Continued only on exit `0`.
- [ ] Returned the exact low-quota JSON on exit `2`.
- [ ] Returned the exact unknown-quota JSON on exit `1`.
- [ ] If using the hook, it blocks quota-sensitive prompts on low/unknown quota and stays silent when quota is sufficient.
- [ ] Did not ask for or print OAuth tokens, API keys, or credential files.
