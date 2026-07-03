import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { QuotaGateError } from './errors.mjs';

const execFileAsync = promisify(execFile);

export const PROD_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
export const PROD_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_OAUTH_SCOPE = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function credentialFilePath(env = process.env) {
  return join(expandHome(env.CLAUDE_CONFIG_DIR || '~/.claude'), '.credentials.json');
}

export function expandHome(path) {
  if (!path || path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function keychainServiceCandidates(env = process.env) {
  const base = 'Claude Code-credentials';
  if (!env.CLAUDE_CONFIG_DIR || !env.CLAUDE_CONFIG_DIR.trim()) return [base];
  return [`${base}-${hashSuffix(env.CLAUDE_CONFIG_DIR)}`, base];
}

export function hashSuffix(value) {
  // Mirrors Claude Code's config-specific credential suffix: SHA-256 over the
  // normalized config dir, rendered as lowercase hex and truncated to 8 chars.
  return createHash('sha256').update(value.normalize('NFC'), 'utf8').digest('hex').slice(0, 8);
}

export async function discoverClaudeCredentials({ env = process.env, readKeychain = readMacKeychainPassword, readTextFile = readFile } = {}) {
  const candidates = [];

  if (platform() === 'darwin') {
    for (const service of keychainServiceCandidates(env)) {
      const currentUser = await safeKeychainRead(() => readKeychain(service, userInfo().username));
      if (currentUser) candidates.push({ source: 'keychain_current_user', service, raw: currentUser });

      const legacy = await safeKeychainRead(() => readKeychain(service));
      if (legacy) candidates.push({ source: 'keychain_legacy', service, raw: legacy });
    }
  }

  const file = credentialFilePath(env);
  if (existsSync(file)) {
    try {
      candidates.push({ source: 'file', path: file, raw: await readTextFile(file, 'utf8') });
    } catch {
      // Treat unreadable files as missing candidates. The gate fails closed if nothing usable remains.
    }
  }

  for (const candidate of candidates) {
    const parsed = parseCredentialText(candidate.raw);
    if (parsed?.claudeAiOauth?.accessToken || parsed?.claudeAiOauth?.refreshToken) {
      return { ...candidate, credentials: parsed, oauth: parsed.claudeAiOauth };
    }
  }

  throw new QuotaGateError('missing_claude_code_credentials');
}

async function safeKeychainRead(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function readMacKeychainPassword(service, account) {
  const args = ['find-generic-password'];
  if (account) args.push('-a', account);
  args.push('-s', service, '-w');
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', args, { timeout: 5000, maxBuffer: 1024 * 1024 });
    const value = stdout.trim();
    return value || null;
  } catch (error) {
    // security exits 44 when the item is not found. Other failures include locked/denied keychain.
    if (error?.code === 44) return null;
    throw new QuotaGateError('keychain_access_failed', 'keychain_access_failed', { cause: error });
  }
}

export function parseCredentialText(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some copied Keychain blobs are hex-encoded JSON; accept that format too.
    if (/^(?:[\da-f]{2})+$/i.test(trimmed)) {
      try {
        return JSON.parse(Buffer.from(trimmed, 'hex').toString('utf8'));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function needsRefresh(oauth, now = Date.now) {
  if (!oauth?.accessToken) return true;
  if (typeof oauth.expiresAt !== 'number') return false;
  return oauth.expiresAt - now() <= REFRESH_BUFFER_MS;
}

export async function getClaudeAccessToken({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, authCandidate } = {}) {
  const candidate = authCandidate || await discoverClaudeCredentials({ env });
  const oauth = candidate.oauth;

  if (!needsRefresh(oauth, now)) return { accessToken: oauth.accessToken, source: candidate.source, refreshed: false };
  if (!oauth?.refreshToken) throw new QuotaGateError('missing_claude_refresh_token');

  const refreshed = await refreshClaudeToken(oauth.refreshToken, { fetchImpl });
  return { accessToken: refreshed.accessToken, source: candidate.source, refreshed: true };
}

export async function refreshClaudeToken(refreshToken, { fetchImpl = globalThis.fetch } = {}) {
  if (!fetchImpl) throw new QuotaGateError('fetch_unavailable');
  const response = await fetchImpl(PROD_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: PROD_CLIENT_ID,
      scope: CLAUDE_OAUTH_SCOPE
    })
  });

  if (!response.ok) throw new QuotaGateError(`refresh_endpoint_${response.status}`, 'refresh_failed', { status: response.status });

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new QuotaGateError('invalid_refresh_response', 'invalid_refresh_response', { cause: error });
  }

  if (!body || typeof body.access_token !== 'string' || !body.access_token) {
    throw new QuotaGateError('invalid_refresh_response');
  }

  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : undefined
  };
}


