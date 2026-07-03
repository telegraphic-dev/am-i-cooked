import { QuotaGateError } from './claude-auth.mjs';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_USAGE_BETA = 'oauth-2025-04-20';
export const DEFAULT_USER_AGENT = 'claude-code/2.1.69';

export const FIVE_HOUR_PERIOD_MS = 5 * 60 * 60 * 1000;
export const WEEKLY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export async function fetchClaudeUsage(accessToken, { fetchImpl = globalThis.fetch, userAgent = DEFAULT_USER_AGENT, now = Date.now } = {}) {
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

  return normalizeUsageResponse(body, { now });
}

export function normalizeUsageResponse(body, { now = Date.now } = {}) {
  if (!body || typeof body !== 'object') throw new QuotaGateError('invalid_usage_response');

  const fiveHour = normalizeWindow(body.five_hour, 'five_hour', FIVE_HOUR_PERIOD_MS, now);
  const weekly = normalizeWindow(body.seven_day, 'seven_day', WEEKLY_PERIOD_MS, now);
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

function normalizeWindow(input, field, periodDurationMs, now) {
  if (!input || typeof input !== 'object') throw new QuotaGateError('invalid_usage_response', `missing_${field}`);
  const used = Number(input.utilization);
  if (!Number.isFinite(used) || used < 0 || used > 100) {
    throw new QuotaGateError('invalid_usage_response', `invalid_${field}_utilization`);
  }
  const resetsAt = pickResetTimestamp(input);
  const window = {
    used_pct: roundPct(used),
    remaining_pct: roundPct(100 - used),
    resets_at: resetsAt
  };
  const pacing = calculatePacing(used, resetsAt, periodDurationMs, now);
  if (pacing) window.pacing = pacing;
  return window;
}

function pickResetTimestamp(input) {
  for (const key of ['resets_at', 'reset_at', 'resetsAt', 'resetAt', 'next_reset_at', 'nextResetAt']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key].trim();
    if (typeof input[key] === 'number' && Number.isFinite(input[key])) return new Date(toEpochMs(input[key])).toISOString();
  }
  return null;
}

function calculatePacing(usedPct, resetsAt, periodDurationMs, now) {
  if (!resetsAt) return null;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const nowMs = now();
  const startMs = resetMs - periodDurationMs;
  const elapsedMs = Math.min(Math.max(nowMs - startMs, 0), periodDurationMs);
  const elapsedPct = (elapsedMs / periodDurationMs) * 100;
  const usedMinusExpectedPct = usedPct - elapsedPct;
  return {
    period_duration_ms: periodDurationMs,
    elapsed_pct: roundPct(elapsedPct),
    expected_used_pct: roundPct(elapsedPct),
    used_minus_expected_pct: roundPct(usedMinusExpectedPct),
    burn_rate_ratio: elapsedPct > 0 ? roundPct(usedPct / elapsedPct) : null,
    faster_than_linear_budget: usedMinusExpectedPct > 0
  };
}

function toEpochMs(value) {
  return Math.abs(value) < 1e10 ? value * 1000 : value;
}

function roundPct(value) {
  return Number(value.toFixed(2));
}

export function evaluateQuotaGate(usage, thresholds) {
  const weekly = usage?.weekly?.remaining_pct;
  const fiveHour = usage?.five_hour?.remaining_pct;
  if (!Number.isFinite(weekly)) throw new QuotaGateError('missing_weekly_usage');
  if (thresholds.five_hour_min_remaining_pct > 0 && !Number.isFinite(fiveHour)) throw new QuotaGateError('missing_five_hour_usage');
  if (Number.isFinite(fiveHour) && fiveHour < thresholds.five_hour_min_remaining_pct) return false;
  return weekly >= thresholds.weekly_min_remaining_pct;
}
