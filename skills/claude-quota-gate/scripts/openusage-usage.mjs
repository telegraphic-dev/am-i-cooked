import { QuotaGateError } from './claude-auth.mjs';
import { FIVE_HOUR_PERIOD_MS, WEEKLY_PERIOD_MS } from './claude-usage.mjs';

export const DEFAULT_OPENUSAGE_BASE_URL = 'http://127.0.0.1:6736';

const POOL_LABELS = {
  default: { session: ['session', '5-hour', 'five hour', 'five-hour'], weekly: ['weekly'] },
  gemini: { session: ['session'], weekly: ['weekly'] },
  claude: { session: ['claude'], weekly: ['claude weekly'] },
  spark: { session: ['spark'], weekly: ['spark weekly'] }
};

export async function fetchOpenUsageProviderUsage(providerId, {
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_OPENUSAGE_BASE_URL,
  pool = 'default',
  now = Date.now
} = {}) {
  if (!fetchImpl) throw new QuotaGateError('fetch_unavailable');
  if (!providerId) throw new QuotaGateError('missing_provider');

  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/usage/${encodeURIComponent(providerId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
  } catch (error) {
    throw new QuotaGateError('openusage_unavailable', 'openusage_unavailable', { cause: error });
  }

  if (response.status === 204) throw new QuotaGateError('openusage_no_snapshot');
  if (response.status === 404) throw new QuotaGateError('openusage_provider_not_found');
  if (!response.ok) throw new QuotaGateError(`openusage_endpoint_${response.status}`);

  let snapshot;
  try {
    snapshot = await response.json();
  } catch (error) {
    throw new QuotaGateError('invalid_openusage_response', 'invalid_openusage_response', { cause: error });
  }

  return normalizeOpenUsageSnapshot(snapshot, { pool, now });
}

export function normalizeOpenUsageSnapshot(snapshot, { pool = 'default', now = Date.now } = {}) {
  if (!snapshot || typeof snapshot !== 'object') throw new QuotaGateError('invalid_openusage_response');
  if (!Array.isArray(snapshot.lines)) throw new QuotaGateError('invalid_openusage_response');

  const metrics = {};
  for (const line of snapshot.lines) {
    if (!line || line.type !== 'progress') continue;
    const normalized = normalizeProgressLine(line, now);
    if (normalized) metrics[normalized.key] = normalized.metric;
  }

  const labels = POOL_LABELS[pool] ?? POOL_LABELS.default;
  const fiveHour = pickMetric(metrics, labels.session);
  const weekly = pickMetric(metrics, labels.weekly);

  return {
    provider_id: snapshot.providerId ?? null,
    display_name: snapshot.displayName ?? snapshot.providerId ?? null,
    plan: snapshot.plan ?? null,
    source: 'openusage',
    ...(fiveHour ? { five_hour: fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    metrics,
    fetched_at: snapshot.fetchedAt ?? null
  };
}

function normalizeProgressLine(line, now) {
  const used = Number(line.used);
  const limit = Number(line.limit);
  if (!line.label || !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  const usedPct = (used / limit) * 100;
  const metric = {
    label: String(line.label),
    used,
    limit,
    used_pct: roundPct(usedPct),
    remaining_pct: roundPct(100 - usedPct),
    format: line.format ?? null,
    resets_at: typeof line.resetsAt === 'string' ? line.resetsAt : null
  };
  if (Number.isFinite(line.periodDurationMs)) {
    metric.period_duration_ms = Number(line.periodDurationMs);
    const pacing = calculatePacing(usedPct, metric.resets_at, metric.period_duration_ms, now);
    if (pacing) metric.pacing = pacing;
  }
  return { key: metricKey(line.label), metric };
}

function pickMetric(metrics, labels) {
  for (const label of labels) {
    const exact = metrics[metricKey(label)];
    if (exact) return exact;
  }
  const entries = Object.values(metrics);
  for (const label of labels) {
    const normalized = metricKey(label);
    const found = entries.find((m) => metricKey(m.label).includes(normalized));
    if (found) return found;
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

export function metricKey(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function roundPct(value) {
  return Number(value.toFixed(2));
}

export { FIVE_HOUR_PERIOD_MS, WEEKLY_PERIOD_MS };
