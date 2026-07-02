import { QuotaGateError } from './claude-auth.mjs';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_USAGE_BETA = 'oauth-2025-04-20';
export const DEFAULT_USER_AGENT = 'claude-code/2.1.69';

export async function fetchClaudeUsage(accessToken, { fetchImpl = globalThis.fetch, userAgent = DEFAULT_USER_AGENT } = {}) {
  if (!fetchImpl) throw new QuotaGateError('fetch_unavailable');
  if (!accessToken) throw new QuotaGateError('missing_access_token');

  let response;
  try {
    response = await fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': CLAUDE_USAGE_BETA,
        'User-Agent': userAgent,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    throw new QuotaGateError('usage_endpoint_network_error', 'usage_endpoint_network_error', { cause: error });
  }

  if (!response.ok) throw new QuotaGateError(`usage_endpoint_${response.status}`, 'usage_endpoint_error', { status: response.status });

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new QuotaGateError('invalid_usage_response', 'invalid_usage_response', { cause: error });
  }

  return normalizeUsageResponse(body);
}

export function normalizeUsageResponse(body) {
  if (!body || typeof body !== 'object') throw new QuotaGateError('invalid_usage_response');

  const fiveHour = normalizeWindow(body.five_hour, 'five_hour');
  const weekly = normalizeWindow(body.seven_day, 'seven_day');
  const extra = {};
  for (const key of ['seven_day_sonnet', 'extra_usage', 'limits']) {
    if (Object.hasOwn(body, key)) extra[key] = body[key];
  }

  return {
    five_hour: fiveHour,
    weekly,
    ...(Object.keys(extra).length ? { extra } : {})
  };
}

function normalizeWindow(input, field) {
  if (!input || typeof input !== 'object') throw new QuotaGateError('invalid_usage_response', `missing_${field}`);
  const used = Number(input.utilization);
  if (!Number.isFinite(used) || used < 0 || used > 100) {
    throw new QuotaGateError('invalid_usage_response', `invalid_${field}_utilization`);
  }
  return {
    used_pct: roundPct(used),
    remaining_pct: roundPct(100 - used),
    resets_at: pickResetTimestamp(input)
  };
}

function pickResetTimestamp(input) {
  for (const key of ['resets_at', 'reset_at', 'resetsAt', 'resetAt', 'next_reset_at', 'nextResetAt']) {
    if (typeof input[key] === 'string' && input[key]) return input[key];
  }
  return null;
}

function roundPct(value) {
  return Number(value.toFixed(2));
}

export function evaluateQuotaGate(usage, thresholds) {
  const weekly = usage?.weekly?.remaining_pct;
  const fiveHour = usage?.five_hour?.remaining_pct;
  if (!Number.isFinite(weekly) || !Number.isFinite(fiveHour)) throw new QuotaGateError('invalid_usage_response');
  return weekly >= thresholds.weekly_min_remaining_pct && fiveHour >= thresholds.five_hour_min_remaining_pct;
}
