import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { QuotaGateError } from './errors.mjs';

const execFileAsync = promisify(execFile);

export const CLI_REFRESH_TIMEOUT_MS = 20_000;

export const CURSOR_AUTH_EXPIRED_HINT = 'Login expired. Re-run `NO_OPEN_BROWSER=1 cursor-agent login` in the background, send the printed URL to the human to approve, confirm with `cursor-agent status`, then retry.';

export const CURSOR_MISSING_CREDENTIALS_HINT = 'Cursor CLI login not found. Install with `curl -fsS https://cursor.com/install | bash`, run `NO_OPEN_BROWSER=1 cursor-agent login` in the background, send the printed URL to the human to approve, then confirm with `cursor-agent status`.';

function homeDir(env) {
  return env.HOME?.trim() || homedir();
}

export function cursorAuthPaths(env = process.env) {
  if (env.CURSOR_AUTH_PATH?.trim()) return [env.CURSOR_AUTH_PATH.trim()];
  if (env.CURSOR_CONFIG_DIR?.trim()) return [join(env.CURSOR_CONFIG_DIR.trim(), 'auth.json')];

  const home = homeDir(env);
  const paths = [];
  if (platform() === 'darwin') paths.push(join(home, '.cursor', 'auth.json'));
  if (platform() === 'win32') {
    const appData = env.APPDATA?.trim() || join(home, 'AppData', 'Roaming');
    paths.push(join(appData, 'Cursor', 'auth.json'));
  }
  if (env.XDG_CONFIG_HOME?.trim()) paths.push(join(env.XDG_CONFIG_HOME.trim(), 'cursor', 'auth.json'));
  paths.push(join(home, '.config', 'cursor', 'auth.json'));
  return [...new Set(paths)];
}

export function decodeJwtPayload(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function isAccessTokenExpired(token, now = Date.now) {
  const payload = decodeJwtPayload(token);
  if (!payload || !Number.isFinite(payload.exp)) return false;
  return payload.exp * 1000 <= now();
}

export function cursorUserId(token) {
  const sub = decodeJwtPayload(token)?.sub;
  if (typeof sub !== 'string' || !sub.trim()) return null;
  const id = sub.split('|').pop();
  return id?.trim() || null;
}

function authExpired() {
  return new QuotaGateError('auth_expired', 'auth_expired', { hint: CURSOR_AUTH_EXPIRED_HINT });
}

function missingCredentials() {
  return new QuotaGateError('missing_cursor_credentials', 'missing_cursor_credentials', { hint: CURSOR_MISSING_CREDENTIALS_HINT });
}

async function readAccessTokenFile(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.accessToken !== 'string' || !parsed.accessToken.trim()) return null;
    return parsed.accessToken.trim();
  } catch {
    return null;
  }
}

async function credentialCandidates({ env, skipEnv }) {
  const candidates = [];
  if (!skipEnv && env.CURSOR_ACCESS_TOKEN?.trim()) {
    candidates.push({ accessToken: env.CURSOR_ACCESS_TOKEN.trim(), source: 'env' });
  }
  for (const path of cursorAuthPaths(env)) {
    const accessToken = await readAccessTokenFile(path);
    if (accessToken) candidates.push({ accessToken, source: 'cli', path });
  }
  return candidates;
}

function selectCredential(candidates, now) {
  if (!candidates.length) return null;
  return candidates.find(candidate => !isAccessTokenExpired(candidate.accessToken, now)) || candidates[0];
}

async function isExecutableFile(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findCursorAgentBin(env = process.env) {
  const candidates = [];
  if (env.CURSOR_AGENT_BIN?.trim()) candidates.push(env.CURSOR_AGENT_BIN.trim());
  const dirs = [];
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (dir?.trim()) dirs.push(dir);
  }
  dirs.push(join(homeDir(env), '.local', 'bin'));
  for (const dir of dirs) candidates.push(join(dir, 'cursor-agent'));
  candidates.push(join(homeDir(env), '.local', 'bin', 'agent'));

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function childEnv(env) {
  const next = { ...env, NO_OPEN_BROWSER: '1' };
  delete next.CURSOR_ACCESS_TOKEN;
  return next;
}

// Ask the installed Cursor CLI to refresh. The CLI rewrites auth.json when it can.
// This process never calls an OAuth token endpoint and never sends tokens on argv.
export async function tryRefreshCursorAuth({ env = process.env, runCommand, debug = () => {} } = {}) {
  try {
    if (runCommand) {
      debug('cursor cli refresh via cursor-agent status');
      const result = await runCommand({ args: ['status'] });
      if (result && result.installed === false) return false;
      return true;
    }
    const bin = await findCursorAgentBin(env);
    if (!bin) return false;
    debug('cursor cli refresh via cursor-agent status');
    await execFileAsync(bin, ['status'], {
      env: childEnv(env),
      timeout: CLI_REFRESH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'cursor_cli_not_installed') return false;
    return true;
  }
}

export function isCursorAuthFailure(error) {
  return error instanceof QuotaGateError && (error.status === 401 || error.status === 403);
}

export async function withCursorAccessToken({ env = process.env, runCommand, now = Date.now, debug = () => {} } = {}, fn) {
  let skipEnv = false;
  let refreshed = false;
  let seenToken = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const credential = selectCredential(await credentialCandidates({ env, skipEnv }), now);
    if (!credential?.accessToken) throw refreshed ? authExpired() : missingCredentials();

    const sameToken = seenToken && credential.accessToken === seenToken;
    if (sameToken && (refreshed || isAccessTokenExpired(credential.accessToken, now))) throw authExpired();

    if (isAccessTokenExpired(credential.accessToken, now)) {
      seenToken = credential.accessToken;
      if (refreshed || !(await tryRefreshCursorAuth({ env, runCommand, debug }))) throw authExpired();
      refreshed = true;
      skipEnv = true;
      continue;
    }

    seenToken = credential.accessToken;
    try {
      debug(`usage source=cursor-direct credential source=${credential.source} refreshed=${refreshed}`);
      return await fn({ ...credential, refreshed });
    } catch (error) {
      if (!isCursorAuthFailure(error)) throw error;
      if (refreshed || !(await tryRefreshCursorAuth({ env, runCommand, debug }))) throw authExpired();
      refreshed = true;
      skipEnv = true;
    }
  }

  throw authExpired();
}
