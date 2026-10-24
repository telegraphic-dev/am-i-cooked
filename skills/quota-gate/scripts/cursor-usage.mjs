import { QuotaGateError } from './errors.mjs';
import { cursorUserId } from './cursor-auth.mjs';
import { WEEKLY_PERIOD_MS } from './usage-core.mjs';

export const SAND_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus';
export const SUMMARY_USAGE_URL = 'https://cursor.com/api/usage-summary';

export async function fetchCursorMeters({ accessToken, provider, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!fetchImpl) throw new QuotaGateError('fetch_unavailable');
  if (!accessToken) throw new QuotaGateError('missing_cursor_credentials');

  const sand = await fetchSandUsage(accessToken, { fetchImpl });
  if (provider === 'grokbot') return buildCursorUsage({ provider, sand, summary: null, now });

  const unifiedFromSand = sandIsUnified(sand);
  const userId = cursorUserId(accessToken);
  if (!userId && !unifiedFromSand) throw new QuotaGateError('invalid_cursor_token');

  let summary = null;
  if (userId) {
    try {
      summary = await fetchPlanSummary(accessToken, userId, { fetchImpl });
    } catch (error) {
      // On a unified plan the sand meter is the shared pool. A plan-summary failure must not
      // turn a known sand reading into an allow based on a missing or zero Cursor meter.
      if (!unifiedFromSand) throw error;
    }
  }

  return buildCursorUsage({ provider, sand, summary, now });
}

export function buildCursorUsage({ provider, sand, summary = null, now = Date.now } = {}) {
  const sandMeter = normalizeSand(sand, now);
  if (provider === 'grokbot') {
    return {
      provider_id: 'grokbot',
      display_name: 'Grok Bot',
      plan: sandMeter.plan,
      source: 'cursor-direct',
      weekly: sandMeter.window,
      extra: { unified: sandMeter.unified, ...sandMeter.extra }
    };
  }

  const summaryUnified = membershipIsUnified(summary?.membershipType);
  const unified = sandMeter.unified || summaryUnified;
  const planMeter = summary ? normalizePlan(summary, { now, required: !unified }) : null;
  if (!unified && !planMeter) throw new QuotaGateError('invalid_cursor_usage_response', 'missing_cursor_plan_usage');

  let weekly = sandMeter.window;
  let authoritative = 'grokbot';
  if (!unified && planMeter.window.used_pct > sandMeter.window.used_pct) {
    weekly = planMeter.window;
    authoritative = 'cursor_plan';
  }

  return {
    provider_id: 'cursor',
    display_name: 'Cursor',
    plan: (typeof summary?.membershipType === 'string' && summary.membershipType) || sandMeter.plan,
    source: 'cursor-direct',
    weekly,
    extra: {
      authoritative_meter: authoritative,
      unified,
      grokbot: meterSnapshot(sandMeter.window),
      cursor_plan: planMeter
        ? { ...meterSnapshot(planMeter.window), ignored_for_decision: unified }
        : { ignored_for_decision: true, unavailable: true },
      ...sandMeter.extra
    }
  };
}

async function fetchSandUsage(accessToken, { fetchImpl }) {
  const response = await request(fetchImpl, SAND_USAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1'
    },
    body: '{}'
  }, 'cursor_sand_usage');
  return readJson(response, 'invalid_cursor_usage_response');
}

async function fetchPlanSummary(accessToken, userId, { fetchImpl }) {
  const response = await request(fetchImpl, SUMMARY_USAGE_URL, {
    method: 'GET',
    headers: {
      Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${accessToken}`)}`,
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0'
    }
  }, 'cursor_plan_usage');
  return readJson(response, 'invalid_cursor_usage_response');
}

async function request(fetchImpl, url, init, codePrefix) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'manual' });
  } catch (error) {
    throw new QuotaGateError(`${codePrefix}_network_error`, `${codePrefix}_network_error`, { cause: error });
  }
  if (!response.ok) {
    throw new QuotaGateError(`${codePrefix}_${response.status}`, `${codePrefix}_error`, { status: response.status });
  }
  return response;
}

async function readJson(response, code) {
  try {
    return await response.json();
  } catch (error) {
    throw new QuotaGateError(code, code, { cause: error });
  }
}

function normalizeSand(body, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new QuotaGateError('invalid_cursor_usage_response');
  }
  if (pick(body, 'usesPooledEnterpriseAllowance', 'uses_pooled_enterprise_allowance') === true) {
    throw new QuotaGateError('cursor_pooled_enterprise_usage');
  }
  const includedLimitZero = pick(body, 'includedLimitZero', 'included_limit_zero') === true;
  const hasNonZeroIncludedLimit = pick(body, 'hasNonZeroIncludedLimit', 'has_non_zero_included_limit');
  if (includedLimitZero || hasNonZeroIncludedLimit === false) {
    throw new QuotaGateError('cursor_no_included_quota');
  }

  const used = finitePercent(pick(body, 'usagePercent', 'usage_percent'));
  if (used == null) throw new QuotaGateError('invalid_cursor_usage_response', 'invalid_usage_percent');

  const resetsAt = asIso(pick(body, 'nextResetTimestampUtc', 'next_reset_timestamp_utc'));
  const periodStart = asIso(pick(body, 'currentPeriodStart', 'current_period_start'));
  const periodMs = periodBetween(periodStart, resetsAt) ?? (resetsAt ? WEEKLY_PERIOD_MS : null);
  const planName = stringOrNull(pick(body, 'cursorPlanName', 'cursor_plan_name'));
  const extra = {
    has_available_usage: booleanOrUndefined(pick(body, 'hasAvailableUsage', 'has_available_usage')),
    billing_brand: stringOrNull(pick(body, 'billingBrand', 'billing_brand')),
    cursor_plan_name: planName,
    on_demand: publicOnDemand(pick(body, 'onDemandSettings', 'on_demand_settings'))
  };
  for (const key of Object.keys(extra)) {
    if (extra[key] === undefined || extra[key] === null) delete extra[key];
  }

  return {
    unified: sandIsUnified(body),
    plan: planName,
    window: buildWindow({ label: 'Grok Bot', used, resetsAt, periodMs, now }),
    extra
  };
}

function normalizePlan(summary, { now, required }) {
  if (!summary || typeof summary !== 'object') {
    if (required) throw new QuotaGateError('invalid_cursor_usage_response', 'missing_cursor_plan_usage');
    return null;
  }
  const plan = summary.individualUsage?.plan ?? summary.individual_usage?.plan;
  const used = finitePercent(plan && typeof plan === 'object' ? pick(plan, 'totalPercentUsed', 'total_percent_used') : undefined);
  if (used == null) {
    if (required) throw new QuotaGateError('invalid_cursor_usage_response', 'missing_cursor_plan_usage');
    return null;
  }
  const resetsAt = asIso(pick(summary, 'billingCycleEnd', 'billing_cycle_end'));
  const periodMs = periodBetween(asIso(pick(summary, 'billingCycleStart', 'billing_cycle_start')), resetsAt);
  return {
    window: buildWindow({ label: 'Cursor', used, resetsAt, periodMs, now })
  };
}

function sandIsUnified(body) {
  return pick(body, 'isUnified', 'is_unified') === true;
}

function membershipIsUnified(value) {
  return typeof value === 'string' && value.toLowerCase().startsWith('unified');
}

function buildWindow({ label, used, resetsAt, periodMs, now }) {
  const window = {
    label,
    used_pct: roundPct(used),
    remaining_pct: roundPct(Math.max(0, 100 - used)),
    resets_at: resetsAt
  };
  if (periodMs) window.period_duration_ms = periodMs;
  const pacing = periodMs ? calculatePacing(used, resetsAt, periodMs, now) : null;
  if (pacing) window.pacing = pacing;
  return window;
}

function meterSnapshot(window) {
  return {
    used_pct: window.used_pct,
    remaining_pct: window.remaining_pct,
    resets_at: window.resets_at
  };
}

function calculatePacing(usedPct, resetsAt, periodDurationMs, now) {
  if (!resetsAt || !periodDurationMs) return null;
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

function finitePercent(value) {
  const used = Number(value);
  if (!Number.isFinite(used) || used < 0 || used > 100) return null;
  return used;
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] != null) return obj[key];
  }
  return undefined;
}

function asIso(value) {
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value.trim());
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = Math.abs(value) < 1e10 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

function periodBetween(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return end - start;
}

function publicOnDemand(value) {
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  for (const key of ['visible', 'eligible', 'enabled']) {
    if (typeof value[key] === 'boolean') out[key] = value[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanOrUndefined(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function roundPct(value) {
  return Number(value.toFixed(2));
}
