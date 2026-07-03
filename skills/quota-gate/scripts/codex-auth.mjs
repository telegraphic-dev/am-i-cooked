import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { QuotaGateError } from './claude-auth.mjs';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_REFRESH_URL = 'https://auth.openai.com/oauth/token';

export async function discoverCodexCredentials({ env = process.env } = {}) {
  const paths = codexAuthPaths(env);
  for (const path of paths) {
    try {
      const raw = await readFile(path, 'utf8');
      const auth = parseCodexAuth(raw);
      if (auth?.tokens?.access_token) return { path, auth };
      if (auth?.OPENAI_API_KEY) throw new QuotaGateError('codex_api_key_only');
    } catch (error) {
      if (error instanceof QuotaGateError) throw error;
      if (error?.code !== 'ENOENT') continue;
    }
  }
  throw new QuotaGateError('missing_codex_credentials');
}

export async function getCodexAccessToken({ credential, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const auth = credential?.auth;
  if (!auth?.tokens?.access_token) throw new QuotaGateError('missing_codex_access_token');
  if (!needsRefresh(auth, now)) return { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id, refreshed: false };
  if (!auth.tokens.refresh_token) throw new QuotaGateError('missing_codex_refresh_token');
  if (!fetchImpl) throw new QuotaGateError('fetch_unavailable');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CODEX_CLIENT_ID,
    refresh_token: auth.tokens.refresh_token
  });

  let response;
  try {
    response = await fetchImpl(CODEX_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body
    });
  } catch (error) {
    throw new QuotaGateError('codex_refresh_network_error', 'codex_refresh_network_error', { cause: error });
  }

  if (!response.ok) throw new QuotaGateError(`codex_refresh_${response.status}`);
  let json;
  try { json = await response.json(); } catch (error) { throw new QuotaGateError('invalid_codex_refresh_response', 'invalid_codex_refresh_response', { cause: error }); }
  if (!json?.access_token) throw new QuotaGateError('invalid_codex_refresh_response');

  const nextAuth = structuredClone(auth);
  nextAuth.tokens.access_token = json.access_token;
  if (json.refresh_token) nextAuth.tokens.refresh_token = json.refresh_token;
  if (json.id_token) nextAuth.tokens.id_token = json.id_token;
  nextAuth.last_refresh = new Date(now()).toISOString();
  await writeFile(credential.path, `${JSON.stringify(nextAuth, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  return { accessToken: json.access_token, accountId: nextAuth.tokens.account_id, refreshed: true };
}

function codexAuthPaths(env) {
  if (env.CODEX_HOME?.trim()) return [join(env.CODEX_HOME.trim(), 'auth.json')];
  return [join(homedir(), '.config', 'codex', 'auth.json'), join(homedir(), '.codex', 'auth.json')];
}

function parseCodexAuth(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function needsRefresh(auth, now) {
  const expiresAt = jwtExpiresAt(auth.tokens?.access_token);
  if (expiresAt) return expiresAt - now() <= 5 * 60 * 1000;
  if (!auth.last_refresh) return false;
  const lastRefresh = Date.parse(auth.last_refresh);
  return Number.isFinite(lastRefresh) && now() - lastRefresh > 8 * 24 * 60 * 60 * 1000;
}

function jwtExpiresAt(token) {
  if (!token || !token.includes('.')) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
