import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUsageResponse, evaluateQuotaGate } from '../skills/claude-quota-gate/scripts/claude-usage.mjs';
import { runQuotaGate } from '../skills/claude-quota-gate/scripts/quota-gate.mjs';
import { redactSecrets } from '../skills/claude-quota-gate/scripts/claude-auth.mjs';
import { writeUsageCache } from '../skills/claude-quota-gate/scripts/cache.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/usage-response.json', import.meta.url), 'utf8'));

function okResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function streams() {
  let out = '';
  let err = '';
  return {
    stdout: { write(chunk) { out += chunk; } },
    stderr: { write(chunk) { err += chunk; } },
    get out() { return out; },
    get err() { return err; },
    json() { return JSON.parse(out); }
  };
}

async function tempEnvWithCredentials(oauth = { accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: Date.now() + 3_600_000 }) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-quota-gate-test-'));
  await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
  return { dir, env: { ...process.env, CLAUDE_CONFIG_DIR: dir, XDG_CACHE_HOME: join(dir, 'cache') } };
}

test('usage normalization converts utilization to remaining percentages', () => {
  const usage = normalizeUsageResponse(fixture, { now: () => Date.parse('2026-07-02T14:30:00Z') });
  assert.equal(usage.five_hour.used_pct, 25);
  assert.equal(usage.five_hour.remaining_pct, 75);
  assert.equal(usage.weekly.used_pct, 60);
  assert.equal(usage.weekly.remaining_pct, 40);
  assert.equal(usage.weekly.resets_at, '2026-07-08T00:00:00Z');
  assert.equal(usage.five_hour.pacing.period_duration_ms, 18_000_000);
  assert.equal(usage.five_hour.pacing.elapsed_pct, 50);
  assert.equal(usage.five_hour.pacing.faster_than_linear_budget, false);
  assert.ok(usage.weekly.pacing.faster_than_linear_budget);
  assert.ok(usage.extra.seven_day_sonnet);
});

test('gate passes when both remaining values meet thresholds', () => {
  const usage = normalizeUsageResponse(fixture);
  assert.equal(evaluateQuotaGate(usage, { weekly_min_remaining_pct: 40, five_hour_min_remaining_pct: 75 }), true);
});

test('gate fails when weekly is below threshold', () => {
  const usage = normalizeUsageResponse(fixture);
  assert.equal(evaluateQuotaGate(usage, { weekly_min_remaining_pct: 41, five_hour_min_remaining_pct: 0 }), false);
});

test('gate fails when five-hour is below threshold', () => {
  const usage = normalizeUsageResponse(fixture);
  assert.equal(evaluateQuotaGate(usage, { weekly_min_remaining_pct: 0, five_hour_min_remaining_pct: 76 }), false);
});

test('CLI returns exit code 2 when weekly threshold is not met', async () => {
  const { dir, env } = await tempEnvWithCredentials();
  const io = streams();
  let calls = 0;
  const code = await runQuotaGate({
    argv: ['--weekly-min=50', '--no-cache', '--provider=claude'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: async () => { calls += 1; return okResponse(fixture); }
  });
  await rm(dir, { recursive: true, force: true });
  assert.equal(code, 2);
  assert.equal(calls, 1);
  assert.deepEqual(io.json().allowed, false);
  assert.equal(io.json().reason, 'below_threshold');
});

test('missing credentials returns exit code 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-quota-gate-empty-'));
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--no-cache', '--provider=claude'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, XDG_CACHE_HOME: join(dir, 'cache') },
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  await rm(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.equal(io.json().allowed, false);
  assert.equal(io.json().reason, 'missing_claude_code_credentials');
});

test('endpoint error returns exit code 1', async () => {
  const { dir, env } = await tempEnvWithCredentials();
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--no-cache', '--provider=claude'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: async () => okResponse({ error: 'rate limited' }, 429)
  });
  await rm(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.equal(io.json().reason, 'usage_endpoint_429');
});

test('invalid response shape returns exit code 1', async () => {
  const { dir, env } = await tempEnvWithCredentials();
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--no-cache', '--provider=claude'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: async () => okResponse({ five_hour: {}, seven_day: {} })
  });
  await rm(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.equal(io.json().reason, 'invalid_usage_response');
});

test('cache hit avoids network call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-quota-gate-cache-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, XDG_CACHE_HOME: join(dir, 'cache') };
  await writeUsageCache(normalizeUsageResponse(fixture), { path: join(dir, 'cache', 'claude-quota-gate', 'claude-default-direct.json') });
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--weekly-min=40', '--provider=claude'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: async () => { throw new Error('network should not be called'); }
  });
  await rm(dir, { recursive: true, force: true });
  assert.equal(code, 0);
  assert.equal(io.json().allowed, true);
});

test('stale cache does not allow success if endpoint fails', async () => {
  const { dir, env } = await tempEnvWithCredentials();
  await writeUsageCache(normalizeUsageResponse(fixture), {
    path: join(dir, 'cache', 'claude-quota-gate', 'claude-default-direct.json'),
    now: () => Date.now() - 10_000
  });
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--cache-ttl-seconds=1', '--provider=claude'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: async () => okResponse({ error: 'server error' }, 500)
  });
  await rm(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.equal(io.json().reason, 'usage_endpoint_500');
});

test('debug logs do not expose tokens', async () => {
  const { dir, env } = await tempEnvWithCredentials({ accessToken: 'secret-access-token', refreshToken: 'secret-refresh-token', expiresAt: Date.now() + 3_600_000 });
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--debug', '--no-cache', '--weekly-min=40', '--provider=claude'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer secret-access-token');
      return okResponse(fixture);
    }
  });
  await rm(dir, { recursive: true, force: true });
  assert.equal(code, 0);
  assert.doesNotMatch(io.err, /secret-access-token|secret-refresh-token/);
  assert.equal(redactSecrets('Authorization: Bearer secret-access-token'), 'Authorization: Bearer [REDACTED]');
});


const codexUsageResponse = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 20, reset_after_seconds: 7200, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 45, reset_after_seconds: 518400, limit_window_seconds: 604800 }
  }
};

test('Codex provider gate reads Codex auth and usage directly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-quota-gate-'));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    tokens: { access_token: 'codex-access-token', refresh_token: 'codex-refresh-token', account_id: 'account-123' },
    last_refresh: new Date().toISOString()
  }), 'utf8');
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=codex', '--weekly-min=50', '--session-min=70', '--no-cache'],
    env: { ...process.env, CODEX_HOME: dir },
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(init.headers.Authorization, 'Bearer codex-access-token');
      assert.equal(init.headers['ChatGPT-Account-Id'], 'account-123');
      return okResponse(codexUsageResponse);
    },
    now: () => Date.parse('2026-07-03T08:00:00Z')
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 0);
  const json = io.json();
  assert.equal(json.allowed, true);
  assert.equal(json.usage.provider_id, 'codex');
  assert.equal(json.usage.source, 'codex-direct');
  assert.equal(json.usage.five_hour.remaining_pct, 80);
  assert.equal(json.usage.weekly.remaining_pct, 55);
});

test('Codex provider gate fails when quota is below threshold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-quota-gate-low-'));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'codex-access-token' } }), 'utf8');
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=codex', '--weekly-min=60', '--no-cache'],
    env: { ...process.env, CODEX_HOME: dir },
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: async () => okResponse(codexUsageResponse)
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 2);
  assert.equal(io.json().reason, 'below_threshold');
});

test('unsupported direct providers fail closed', async () => {
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=antigravity', '--no-cache'],
    env: process.env,
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });

  assert.equal(code, 1);
  assert.equal(io.json().reason, 'unsupported_direct_provider');
});
