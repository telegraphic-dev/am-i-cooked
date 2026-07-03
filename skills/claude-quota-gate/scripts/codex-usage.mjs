import { QuotaGateError } from './claude-auth.mjs';
import { FIVE_HOUR_PERIOD_MS, WEEKLY_PERIOD_MS } from './claude-usage.mjs';

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export async function fetchCodexUsage(accessToken, { accountId, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!fetchImpl) throw new QuotaGateError('fetch_unavailable');
  if (!accessToken) throw new QuotaGateError('missing_codex_access_token');

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'claude-quota-gate'
  };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;

  let response;
  try {
    response = await fetchImpl(CODEX_USAGE_URL, { method: 'GET', headers });
  } catch (error) {
    throw new QuotaGateError('codex_usage_network_error', 'codex_usage_network_error', { cause: error });
  }
  if (!response.ok) throw new QuotaGateError(`codex_usage_${response.status}`);

  let body;
  try { body = await response.json(); } catch (error) { throw new QuotaGateError('invalid_codex_usage_response', 'invalid_codex_usage_response', { cause: error }); }
  return normalizeCodexUsageResponse(body, { headers: response.headers, now });
}

export function normalizeCodexUsageResponse(body, { headers, now = Date.now } = {}) {
  if (!body || typeof body !== 'object') throw new QuotaGateError('invalid_codex_usage_response');
  const rateLimit = body.rate_limit && typeof body.rate_limit === 'object' ? body.rate_limit : {};
  const primary = normalizeWindow(rateLimit.primary_window, headerNumber(headers, 'x-codex-primary-used-percent'), 'Session', FIVE_HOUR_PERIOD_MS, now);
  const weekly = normalizeWindow(rateLimit.secondary_window, headerNumber(headers, 'x-codex-secondary-used-percent'), 'Weekly', WEEKLY_PERIOD_MS, now);
  return {
    provider_id: 'codex',
    display_name: 'Codex',
    plan: formatPlan(body.plan_type),
    source: 'codex-direct',
    ...(primary ? { five_hour: primary } : {}),
    ...(weekly ? { weekly } : {}),
    extra: pickExtras(body)
  };
}

function normalizeWindow(input, headerUsed, label, defaultPeriodMs, now) {
  const window = input && typeof input === 'object' ? input : null;
  const rawUsed = number(window?.used_percent) ?? headerUsed;
  if (!Number.isFinite(rawUsed)) return null;
  const periodMs = (number(window?.limit_window_seconds) ?? (defaultPeriodMs / 1000)) * 1000;
  const resetsAt = resetTimestamp(window, now);
  const used = normalizeFreshWindow(rawUsed, resetsAt, periodMs, now);
  return {
    label,
    used_pct: roundPct(used),
    remaining_pct: roundPct(100 - used),
    resets_at: resetsAt,
    period_duration_ms: periodMs
  };
}

function resetTimestamp(window, now) {
  if (!window) return null;
  const resetAt = number(window.reset_at);
  if (Number.isFinite(resetAt)) return new Date(toEpochMs(resetAt)).toISOString();
  const resetAfter = number(window.reset_after_seconds);
  if (Number.isFinite(resetAfter)) return new Date(now() + resetAfter * 1000).toISOString();
  return null;
}

function normalizeFreshWindow(used, resetsAt, periodMs, now) {
  if (!resetsAt || used > 1 || !periodMs) return used;
  const remaining = Date.parse(resetsAt) - now();
  return remaining >= periodMs - 30_000 ? 0 : used;
}

function headerNumber(headers, name) {
  if (!headers?.get) return null;
  return number(headers.get(name));
}

function pickExtras(body) {
  const extra = {};
  for (const key of ['rate_limit_reset_credits', 'additional_rate_limits', 'balance']) {
    if (Object.hasOwn(body, key)) extra[key] = body[key];
  }
  return extra;
}

function formatPlan(plan) {
  return typeof plan === 'string' && plan ? plan.replace(/_/g, ' ') : null;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toEpochMs(value) {
  return Math.abs(value) < 1e10 ? value * 1000 : value;
}

function roundPct(value) {
  return Number(value.toFixed(2));
}
