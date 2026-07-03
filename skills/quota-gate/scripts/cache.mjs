import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_TTL_SECONDS = 180;

export function defaultCachePath(env = process.env, name = 'usage') {
  const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim()
    ? env.XDG_CACHE_HOME
    : join(homedir(), '.cache');
  const safeName = String(name).replace(/[^a-z0-9_.-]+/gi, '-');
  return join(base, 'quota-gate', `${safeName}.json`);
}

export async function readUsageCache({ path = defaultCachePath(), ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now } = {}) {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !parsed.cached_at || !parsed.usage) {
      return { hit: false, reason: 'invalid_cache' };
    }
    const ageMs = now() - Date.parse(parsed.cached_at);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > ttlSeconds * 1000) {
      return { hit: false, reason: 'stale_cache' };
    }
    return { hit: true, usage: parsed.usage, cached_at: parsed.cached_at };
  } catch (error) {
    if (error?.code === 'ENOENT') return { hit: false, reason: 'cache_miss' };
    return { hit: false, reason: 'cache_read_error' };
  }
}

export async function writeUsageCache(usage, { path = defaultCachePath(), now = Date.now } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ cached_at: new Date(now()).toISOString(), usage }, null, 2);
  await writeFile(path, payload, { encoding: 'utf8', mode: 0o600 });
}

export { DEFAULT_TTL_SECONDS };
