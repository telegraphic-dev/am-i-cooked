# quota-gate

`quota-gate` is an agent quota preflight skill for checking remaining AI coding subscription usage before expensive, long-running, or automated work. It ships a small Node.js gate that returns a stable machine-readable allow/skip decision.

By default it reads Claude usage directly from local Claude Code credentials. It currently supports Claude Code and Codex directly, using the same local credentials their CLIs already store. Additional provider adapters can be added without requiring a resident OpenUsage app.

## Installation

Install the skill with [skills.sh](https://skills.sh):

```bash
npx --yes skills add telegraphic-dev/am-i-cooked --global --agent claude-code --agent codex --skill quota-gate
```

For local development:

```bash
git clone https://github.com/telegraphic-dev/am-i-cooked.git
cd am-i-cooked
npm test
skills/quota-gate/scripts/quota-gate --weekly-min=50 --five-hour-min=20
```

For Claude Code quota-sensitive prompts, run the default Claude provider before starting the work:

```bash
scripts/quota-gate --weekly-min=50 --five-hour-min=20
```

For automatic Claude Code enforcement, install the bundled `UserPromptSubmit` hook. The hook stays silent for ordinary prompts, runs `quota-gate` for quota-sensitive prompts, and blocks the prompt when quota is low or unknown:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/skills/quota-gate/scripts/claude-quota-hook"
          }
        ]
      }
    ]
  }
}
```

Tune hook thresholds with environment variables in the Claude Code process:

```bash
export QUOTA_GATE_WEEKLY_MIN=50
export QUOTA_GATE_FIVE_HOUR_MIN=20
```

The default trigger regex is intentionally conservative. Override it with `QUOTA_GATE_HOOK_PATTERN`, or set `QUOTA_GATE_HOOK_ALWAYS=1` to check every prompt.

For Codex quota checks, select the Codex provider explicitly:

```bash
scripts/quota-gate --provider=codex --weekly-min=50 --session-min=20
```

Thresholds are minimum **remaining** percentages.

## Decision contract

Exit codes:

- `0`: quota is sufficient; continue.
- `2`: quota is below threshold; stop.
- `1`: quota is unknown because credentials, auth, endpoint, parsing, or another internal check failed; stop.

The script always prints JSON.

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

Below threshold:

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

Unknown:

```json
{"allowed":false,"reason":"missing_claude_code_credentials"}
```

or:

```json
{"allowed":false,"reason":"usage_endpoint_429"}
```

## CLI options

```bash
scripts/quota-gate \
  --provider=claude \
  --weekly-min=50 \
  --five-hour-min=20 \
  --json \
  --no-cache \
  --cache-ttl-seconds=180 \
  --debug
```

Options:

- `--provider=<claude|codex>`: provider to check. Default: `claude`.
- `--weekly-min=<0..100>`: minimum weekly remaining percentage. Default: `50`.
- `--five-hour-min=<0..100>` / `--session-min=<0..100>`: minimum session/five-hour remaining percentage. Default: `0`.
- `--json`: accepted for clarity; JSON output is always enabled.
- `--no-cache`: bypass read/write cache.
- `--cache-ttl-seconds=<n>`: cache freshness window. Default: `180`.
- `--debug`: print token-redacted diagnostics to stderr.

## Provider-specific behavior

The gate has a generic decision contract, cache layer, thresholds, and exit-code behavior. Provider-specific code is intentionally limited to credential discovery, token refresh, usage endpoint calls, and response normalization.

### Claude Code credentials

The Claude provider reuses local Claude Code credentials.

#### macOS

Lookup order:

1. Config-specific Keychain service when `CLAUDE_CONFIG_DIR` is set:
   - `Claude Code-credentials-<hash>`
   - `<hash>` is the first 8 lowercase hex chars of SHA-256 over the NFC-normalized `CLAUDE_CONFIG_DIR`, matching Claude Code's config-specific credential lookup.
2. Default Keychain service:
   - `Claude Code-credentials`
3. Credentials file:
   - `$CLAUDE_CONFIG_DIR/.credentials.json`, when `CLAUDE_CONFIG_DIR` is set
   - otherwise `~/.claude/.credentials.json`

Keychain access uses the macOS `security` CLI. The script first tries the current-user account-specific item and then the legacy service-only item.

#### Linux

Supported credential files:

- `$CLAUDE_CONFIG_DIR/.credentials.json`
- `~/.claude/.credentials.json`

#### Windows

Supported credential files:

- `CLAUDE_CONFIG_DIR/.credentials.json`
- `~/.claude/.credentials.json` resolved through Node's home directory handling

### Codex credentials

The Codex provider reuses local Codex CLI credentials. Lookup order:

1. `$CODEX_HOME/auth.json`, when `CODEX_HOME` is set
2. `~/.config/codex/auth.json`
3. `~/.codex/auth.json`

Codex API-key-only auth is not enough for subscription quota checks; the gate fails closed with `codex_api_key_only`.

## Token refresh

### Claude Code

If the Claude access token is missing or expires within five minutes, the script refreshes it with the discovered refresh token:

```http
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json
```

It uses the Claude Code OAuth client id:

```text
9d1c250a-e61b-44d9-88ed-5944d1962f5e
```

Request body:

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "...",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "scope": "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
}
```

Refreshed Claude tokens are used in memory for the current check. They are not written back to Keychain or credential files.

### Codex

When the Codex access token is near expiry, the script refreshes it with the discovered refresh token:

```http
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded
Accept: application/json
```

Refreshed Codex tokens are written back to the Codex `auth.json`, matching CLI-style token persistence.

## Usage endpoint

### Claude Code

The script calls Claude's OAuth usage endpoint:

```http
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <access token>
anthropic-beta: oauth-2025-04-20
User-Agent: claude-code/2.1.69
Accept: application/json
Content-Type: application/json
```

The endpoint is undocumented and may change. Invalid responses fail closed.

### Codex

For Codex, the script calls ChatGPT's usage endpoint:

```http
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <access token>
ChatGPT-Account-Id: <account id, when present>
User-Agent: quota-gate
Accept: application/json
```

The endpoint is undocumented and may change. Invalid responses fail closed.

## Usage normalization

The gate normalizes provider responses into `weekly` and optional `five_hour` windows with `used_pct`, `remaining_pct`, and reset metadata when available.

For Claude usage:

- `five_hour.utilization`: five-hour usage percentage, `0..100`.
- `seven_day.utilization`: weekly usage percentage, `0..100`.
- remaining percentage is `100 - utilization`.
- reset timestamps are preserved when present.
- optional fields such as `seven_day_sonnet`, `extra_usage`, and `limits` are preserved under `usage.extra`.

For Codex usage:

- `rate_limit.primary_window.used_percent`: session/five-hour usage percentage, when present.
- `rate_limit.secondary_window.used_percent`: weekly usage percentage, when present.
- `reset_after_seconds`, `reset_at`, and `limit_window_seconds` are converted into reset and period metadata.
- optional fields such as `rate_limit_reset_credits`, `additional_rate_limits`, and `balance` are preserved under `usage.extra`.

When `resets_at` is present, the script also adds advisory `pacing` metadata. It uses the known window duration — five hours for `five_hour`, seven days for `weekly` — and the reset time to estimate whether current usage is ahead of a linear budget:

```json
{
  "pacing": {
    "period_duration_ms": 604800000,
    "elapsed_pct": 42.5,
    "expected_used_pct": 42.5,
    "used_minus_expected_pct": 12.5,
    "burn_rate_ratio": 1.29,
    "faster_than_linear_budget": true
  }
}
```

The gate decision uses remaining percentage thresholds only. Pacing is informational.

## Caching

The script caches normalized usage for 180 seconds by default.

Cache location:

- `${XDG_CACHE_HOME}/quota-gate/<provider>-direct.json`, or
- `~/.cache/quota-gate/<provider>-direct.json`

If the endpoint fails and a non-stale cached response exists, the script can use the cache. If the cache is stale and the endpoint fails, it exits `1`.

Disable cache:

```bash
scripts/quota-gate --no-cache
```

Set TTL:

```bash
scripts/quota-gate --cache-ttl-seconds=60
```

## Security

- Access tokens, refresh tokens, and full credential JSON are never printed.
- Debug logs redact bearer tokens and token-looking fields.
- Tokens are not stored in the project directory.
- Cache stores normalized usage only, not credentials.
- Unknown quota fails closed.

## Troubleshooting

### `missing_claude_code_credentials`

Claude Code credentials were not found. Sign in with Claude Code first:

```bash
claude
```

Then rerun the gate.

### `missing_codex_credentials`

Codex credentials were not found. Sign in with Codex CLI first, then rerun:

```bash
codex
```

### `codex_api_key_only`

Codex is configured with an API key but not subscription OAuth credentials. The gate cannot check subscription quota from an API key, so it fails closed.

### Keychain access denied

On macOS, grant Keychain access to the terminal or Claude Code environment running the script. If Keychain access is denied, the script falls back to `.credentials.json` when available; otherwise it fails closed.

### `invalid_usage_response` / `invalid_codex_usage_response`

The usage endpoint returned a shape the script does not understand. The gate stops instead of guessing quota.

### `usage_endpoint_401` / `usage_endpoint_403` / `codex_usage_401` / `codex_usage_403`

The credential is rejected or lacks access to the usage endpoint. Sign in again with the relevant CLI. Claude credentials made for inference-only workflows may not include `user:profile`, which is needed for live usage.

### `usage_endpoint_429` / `codex_usage_429`

The usage endpoint rate-limited the request. The script can use a non-stale cache; otherwise it fails closed.

### Claude Code Web credential visibility

Claude Code Web credentials may not be visible to local scripts. This gate reads local Claude Code credential stores only.
