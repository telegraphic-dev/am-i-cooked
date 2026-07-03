import { QuotaGateError } from './errors.mjs';

export const FIVE_HOUR_PERIOD_MS = 5 * 60 * 60 * 1000;
export const WEEKLY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export function evaluateQuotaGate(usage, thresholds) {
  const weekly = usage?.weekly?.remaining_pct;
  const fiveHour = usage?.five_hour?.remaining_pct;
  if (!Number.isFinite(weekly)) throw new QuotaGateError('missing_weekly_usage');
  if (thresholds.five_hour_min_remaining_pct > 0 && !Number.isFinite(fiveHour)) throw new QuotaGateError('missing_five_hour_usage');
  if (Number.isFinite(fiveHour) && fiveHour < thresholds.five_hour_min_remaining_pct) return false;
  return weekly >= thresholds.weekly_min_remaining_pct;
}
