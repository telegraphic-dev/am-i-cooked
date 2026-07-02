# claude-quota-gate

Claude Code skill that checks remaining Claude subscription usage before expensive work. It bundles a small Node.js script that reuses existing Claude Code OAuth credentials, queries Claude's OAuth usage endpoint, and returns a machine-readable allow/skip decision.

No MCP. No manual token paste. Fail closed by default.

## What it does

`claude-quota-gate` is meant for prompts and routines like:

> Execute this only if weekly quota remaining is above 50%, otherwise do nothing.

Claude should run the gate first:

```bash
node scripts/quota-gate.mjs --weekly-min=50 --five-hour-min=20
```

Then obey the exit code:

- `0`: quota is sufficient; continue.
- `2`: quota is below threshold; stop/do nothing.
- `1`: quota is unknown; stop/do nothing.

The script always prints JSON.

## Installation

Install the skill into Claude Code as you would any local skill repository, or keep this repository checked out and reference the bundled `SKILL.md`.

For local development:

```bash
git clone https://github.com/telegraphic-dev/am-i-cooked.git
cd am-i-cooked
npm test
node scripts/quota-gate.mjs --weekly-min=50 --five-hour-min=20
```

The script uses only standard Node.js APIs and expects modern Node with built-in `fetch`.

## Credential discovery

The gate reuses Claude Code credentials. It does not ask for tokens unless automatic discovery fails.

### macOS

Credential lookup order:

1. If `CLAUDE_CONFIG_DIR` is set, try Claude Code's config-specific Keychain service name:
   - `Claude Code-credentials-<hash>`
   - `<hash>` is the first 8 lowercase hex chars of SHA-256 over the NFC-normalized `CLAUDE_CONFIG_DIR`, matching OpenUsage' Claude credential discovery.
2. Try default Keychain service:
   - `Claude Code-credentials`
3. Fallback to:
   - `$CLAUDE_CONFIG_DIR/.credentials.json`, if `CLAUDE_CONFIG_DIR` is set
   - otherwise `~/.claude/.credentials.json`

Keychain access uses the macOS `security` CLI. The script first tries the current-user account-specific item and then the legacy service-only item, matching OpenUsage' source order.

### Linux

Supported now:

- `$CLAUDE_CONFIG_DIR/.credentials.json`
- `~/.claude/.credentials.json`

TODO: Secret Service/libsecret support.

### Windows

Supported now:

- `%USERPROFILE%`-resolved Node home fallback via `~/.claude/.credentials.json`
- `CLAUDE_CONFIG_DIR/.credentials.json`

TODO: Windows Credential Manager support.

## Token refresh

If the access token is missing or expires within five minutes, the script refreshes it with the discovered refresh token:

```http
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json
```

It uses the Claude Code/OpenUsage client id:

```text
9d1c250a-e61b-44d9-88ed-5944d1962f5e
```

The request body mirrors OpenUsage:

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "...",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "scope": "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
}
```

Refreshed tokens are used in memory only. This MVP does **not** write rotated credentials back to Keychain or credentials files.

## Usage endpoint

The script calls the undocumented Claude OAuth usage endpoint:

```http
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <access token>
anthropic-beta: oauth-2025-04-20
User-Agent: claude-code/2.1.69
Accept: application/json
Content-Type: application/json
```

The endpoint is undocumented and may change without notice. Invalid responses fail closed.

## Usage normalization

The gate handles the response shape used by OpenUsage:

- `five_hour.utilization`: five-hour usage percentage, `0..100`.
- `seven_day.utilization`: weekly usage percentage, `0..100`.
- remaining percentage is `100 - utilization`.
- reset timestamps are preserved when present.
- optional fields such as `seven_day_sonnet`, `extra_usage`, and `limits` are preserved under `usage.extra`.

## CLI options

```bash
node scripts/quota-gate.mjs \
  --weekly-min=50 \
  --five-hour-min=20 \
  --json \
  --no-cache \
  --cache-ttl-seconds=180 \
  --debug
```

Options:

- `--weekly-min=<0..100>`: minimum weekly remaining percentage. Default: `50`.
- `--five-hour-min=<0..100>`: minimum five-hour remaining percentage. Default: `0`.
- `--json`: accepted for clarity; JSON output is always enabled.
- `--no-cache`: bypass read/write cache.
- `--cache-ttl-seconds=<n>`: cache freshness window. Default: `180`.
- `--debug`: print token-redacted diagnostics to stderr.

Thresholds are remaining percentages, not used percentages.

## Exit codes

- `0`: allowed; all requested thresholds are satisfied.
- `2`: skipped; at least one threshold is not met.
- `1`: skipped; quota is unknown due to credentials, auth, endpoint, parsing, or internal error.

## JSON output

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

Unknown/error:

```json
{"allowed":false,"reason":"missing_claude_code_credentials"}
```

or:

```json
{"allowed":false,"reason":"usage_endpoint_429"}
```

## Caching

To avoid hammering the undocumented endpoint, the script caches normalized usage for 180 seconds by default.

Cache location:

- `${XDG_CACHE_HOME}/claude-quota-gate/usage.json`, or
- `~/.cache/claude-quota-gate/usage.json`

If the endpoint fails and a non-stale cached response exists, the script may use the cache. If the cache is stale and the endpoint fails, it exits `1`.

Disable cache:

```bash
node scripts/quota-gate.mjs --no-cache
```

Set TTL:

```bash
node scripts/quota-gate.mjs --cache-ttl-seconds=60
```

## Security considerations

- Never prints access tokens, refresh tokens, or full credential JSON.
- Debug logs redact bearer tokens and token-looking fields.
- Does not store tokens in the project directory.
- Does not write refreshed credentials back to Keychain or credential files in this MVP.
- Cache stores normalized usage only, not credentials.
- Unknown quota fails closed.
- The undocumented endpoint can change; invalid shapes fail closed.

## Troubleshooting

### `missing_claude_code_credentials`

Claude Code credentials were not found. Sign in with Claude Code first:

```bash
claude
```

Then rerun the gate. Only ask for manual token input if the script explicitly reports this reason.

### Keychain access denied

On macOS, the system may deny or prompt for Keychain access. Grant access to the terminal or Claude Code environment running the script. If denied, the script falls back to `.credentials.json` when available; otherwise it fails closed.

### `invalid_usage_response`

The undocumented endpoint returned a shape the script does not understand. This is intentionally a hard stop because continuing would require guessing quota.

### `usage_endpoint_401` / `usage_endpoint_403`

The credential is rejected or lacks access to the usage endpoint. Sign in again with Claude Code. Credentials made for inference-only workflows may not include `user:profile`, which is needed for live usage.

### `usage_endpoint_429`

The usage endpoint rate-limited the request. The script can use a non-stale cache; otherwise it fails closed.

### Claude Code Web credential visibility

Claude Code Web credentials may not be visible to local scripts. This gate reads local Claude Code credential stores only: Keychain on macOS and `.credentials.json` fallback files.

## Assumptions and known risks

- The config-specific Keychain service hashing is copied from OpenUsage: SHA-256 over NFC-normalized `CLAUDE_CONFIG_DIR`, lowercase hex, first 8 chars.
- Token refresh uses OpenUsage's client id and scope body.
- Refreshed tokens are used in memory only and are not persisted.
- Claude Code Web may not expose credentials to this local script.
- The Anthropic OAuth usage endpoint is undocumented and may break without notice.
