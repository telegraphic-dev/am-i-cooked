#!/usr/bin/env node
import { discoverClaudeCredentials, getClaudeAccessToken, QuotaGateError, redactSecrets } from './claude-auth.mjs';
import { evaluateQuotaGate, fetchClaudeUsage } from './claude-usage.mjs';
import { discoverCodexCredentials, getCodexAccessToken } from './codex-auth.mjs';
import { fetchCodexUsage } from './codex-usage.mjs';
import { DEFAULT_TTL_SECONDS, defaultCachePath, readUsageCache, writeUsageCache } from './cache.mjs';

export function parseArgs(argv) {
  const options = {
    weekly_min_remaining_pct: 50,
    five_hour_min_remaining_pct: 0,
    provider: 'claude',
    json: true,
    noCache: false,
    cacheTtlSeconds: DEFAULT_TTL_SECONDS,
    debug: false
  };

  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--no-cache') options.noCache = true;
    else if (arg === '--debug') options.debug = true;
    else if (arg.startsWith('--weekly-min=')) options.weekly_min_remaining_pct = parseThreshold(arg, '--weekly-min=');
    else if (arg.startsWith('--five-hour-min=')) options.five_hour_min_remaining_pct = parseThreshold(arg, '--five-hour-min=');
    else if (arg.startsWith('--session-min=')) options.five_hour_min_remaining_pct = parseThreshold(arg, '--session-min=');
    else if (arg.startsWith('--provider=')) options.provider = parseIdentifier(arg, '--provider=');
    else if (arg.startsWith('--cache-ttl-seconds=')) {
      const raw = Number(arg.slice('--cache-ttl-seconds='.length));
      if (!Number.isFinite(raw) || raw < 0) throw new QuotaGateError('invalid_cache_ttl_seconds');
      options.cacheTtlSeconds = raw;
    } else {
      throw new QuotaGateError('invalid_argument', `unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseThreshold(arg, prefix) {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new QuotaGateError('invalid_threshold');
  }
  return value;
}

function parseIdentifier(arg, prefix) {
  const value = arg.slice(prefix.length).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) throw new QuotaGateError('invalid_identifier');
  return value;
}

export async function runQuotaGate({ argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr, now = Date.now } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    writeJson(stdout, unknownPayload(errorCode(error)));
    return 1;
  }

  const thresholds = {
    weekly_min_remaining_pct: options.weekly_min_remaining_pct,
    five_hour_min_remaining_pct: options.five_hour_min_remaining_pct
  };

  const debug = (message) => {
    if (options.debug) stderr.write(`${redactSecrets(String(message))}\n`);
  };

  try {
    const usage = await getUsageWithCache({ options, env, fetchImpl, now, debug });
    const allowed = evaluateQuotaGate(usage, thresholds);
    writeJson(stdout, { allowed, reason: allowed ? 'ok' : 'below_threshold', thresholds, usage });
    return allowed ? 0 : 2;
  } catch (error) {
    debug(`quota gate failed: ${errorCode(error)}`);
    writeJson(stdout, unknownPayload(errorCode(error)));
    return 1;
  }
}

async function getUsageWithCache({ options, env, fetchImpl, now, debug }) {
  const cachePath = defaultCachePath(env, cacheName(options));
  if (!options.noCache) {
    const cached = await readUsageCache({ path: cachePath, ttlSeconds: options.cacheTtlSeconds, now });
    if (cached.hit) {
      debug('using non-stale usage cache');
      return cached.usage;
    }
  }

  try {
    const usage = await fetchUsage({ options, env, fetchImpl, now, debug });
    if (!options.noCache) await writeUsageCache(usage, { path: cachePath, now });
    return usage;
  } catch (error) {
    if (!options.noCache) {
      const cached = await readUsageCache({ path: cachePath, ttlSeconds: options.cacheTtlSeconds, now });
      if (cached.hit) {
        debug(`endpoint failed (${errorCode(error)}), using non-stale cache`);
        return cached.usage;
      }
    }
    throw error;
  }
}

async function fetchUsage({ options, env, fetchImpl, now, debug }) {
  switch (options.provider) {
    case 'claude': {
      const authCandidate = await discoverClaudeCredentials({ env });
      const { accessToken, source, refreshed } = await getClaudeAccessToken({ env, fetchImpl, now, authCandidate });
      debug(`usage source=claude-direct credential source=${source} refreshed=${refreshed}`);
      const usage = await fetchClaudeUsage(accessToken, { fetchImpl, now });
      return { provider_id: 'claude', display_name: 'Claude', source: 'claude-direct', ...usage };
    }
    case 'codex': {
      const credential = await discoverCodexCredentials({ env });
      const { accessToken, accountId, refreshed } = await getCodexAccessToken({ credential, fetchImpl, now });
      debug(`usage source=codex-direct credential source=${credential.path} refreshed=${refreshed}`);
      return await fetchCodexUsage(accessToken, { accountId, fetchImpl, now });
    }
    default:
      throw new QuotaGateError('unsupported_direct_provider');
  }
}

function cacheName(options) {
  return `${options.provider}-direct`;
}

function writeJson(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function unknownPayload(reason) {
  return { allowed: false, reason };
}

function errorCode(error) {
  return error instanceof QuotaGateError && error.code ? error.code : 'internal_error';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await runQuotaGate();
  process.exitCode = code;
}
