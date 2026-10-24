import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURSOR_AUTH_EXPIRED_HINT } from '../skills/quota-gate/scripts/cursor-auth.mjs';
import { SAND_USAGE_URL, SUMMARY_USAGE_URL, buildCursorUsage } from '../skills/quota-gate/scripts/cursor-usage.mjs';
import { redactSecrets } from '../skills/quota-gate/scripts/errors.mjs';
import { writeUsageCache } from '../skills/quota-gate/scripts/cache.mjs';
import { runQuotaGate } from '../skills/quota-gate/scripts/quota-gate.mjs';

const sandFixture = JSON.parse(await readFile(new URL('./fixtures/cursor-sand-usage.json', import.meta.url), 'utf8'));
const unifiedSummaryFixture = JSON.parse(await readFile(new URL('./fixtures/cursor-usage-summary-unified.json', import.meta.url), 'utf8'));
const planSummaryFixture = JSON.parse(await readFile(new URL('./fixtures/cursor-usage-summary.json', import.meta.url), 'utf8'));

const NOW_MS = Date.parse('2026-10-21T06:43:19.645Z');
const FUTURE_EXP = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
const PAST_EXP = Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000);

function cursorJwt({ exp = FUTURE_EXP, sub = 'auth0|user_01TEST', sig = 'sig' } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...(sub ? { sub } : {}), exp })).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

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

async function isolatedHome(token) {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-quota-'));
  const authPath = join(dir, 'auth.json');
  if (token) {
    await writeFile(authPath, `${JSON.stringify({ accessToken: token, refreshToken: 'cursor-refresh-token' }, null, 2)}\n`, 'utf8');
  }
  const env = {
    HOME: dir,
    PATH: dir,
    CURSOR_AUTH_PATH: authPath,
    XDG_CACHE_HOME: join(dir, 'cache')
  };
  return { dir, authPath, env };
}

function cursorFetch({ sand, summary, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === SAND_USAGE_URL) return typeof sand === 'function' ? sand(init, calls) : sand;
    if (String(url) === SUMMARY_USAGE_URL) return typeof summary === 'function' ? summary(init, calls) : summary;
    throw new Error(`unexpected url ${url}`);
  };
}

function assertNoSecrets(text, token) {
  assert.equal(text.includes(token), false);
  assert.equal(text.includes('cursor-refresh-token'), false);
  assert.equal(text.includes('dashboardUrl'), false);
  assert.equal(text.includes('user_01TEST'), false);
}

test('sand usage maps used percent onto remaining weekly quota', () => {
  const usage = buildCursorUsage({
    provider: 'grokbot',
    sand: sandFixture,
    now: () => NOW_MS
  });
  assert.equal(usage.weekly.label, 'Grok Bot');
  assert.equal(usage.weekly.used_pct, 89.1);
  assert.equal(usage.weekly.remaining_pct, 10.9);
  assert.equal(usage.weekly.resets_at, '2026-10-24T18:43:19.645Z');
  assert.equal(usage.weekly.period_duration_ms, 604_800_000);
  assert.equal(usage.weekly.pacing.elapsed_pct, 50);
  assert.equal(usage.weekly.pacing.faster_than_linear_budget, true);
  assert.equal(usage.extra.unified, true);
  assert.equal(usage.extra.on_demand.enabled, false);
  assert.equal(usage.extra.on_demand.dashboardUrl, undefined);
  assert.equal(JSON.stringify(usage).includes('user_01TEST'), false);
});

test('snake_case sand fields and epoch reset timestamps are accepted', () => {
  const usage = buildCursorUsage({
    provider: 'grokbot',
    sand: {
      usage_percent: 40,
      current_period_start: '2026-10-17T18:43:19.645Z',
      next_reset_timestamp_utc: Date.parse('2026-10-24T18:43:19.645Z'),
      is_unified: false,
      has_available_usage: false
    },
    now: () => NOW_MS
  });
  assert.equal(usage.weekly.used_pct, 40);
  assert.equal(usage.weekly.remaining_pct, 60);
  assert.equal(usage.weekly.resets_at, '2026-10-24T18:43:19.645Z');
  assert.equal(usage.extra.unified, false);
  assert.equal(usage.extra.has_available_usage, false);
});

test('unified cursor check ignores a zero plan meter', () => {
  const usage = buildCursorUsage({
    provider: 'cursor',
    sand: sandFixture,
    summary: unifiedSummaryFixture,
    now: () => NOW_MS
  });
  assert.equal(usage.weekly.used_pct, 89.1);
  assert.equal(usage.weekly.remaining_pct, 10.9);
  assert.equal(usage.extra.unified, true);
  assert.equal(usage.extra.authoritative_meter, 'grokbot');
  assert.equal(usage.extra.cursor_plan.used_pct, 0);
  assert.equal(usage.extra.cursor_plan.ignored_for_decision, true);
});

test('membershipType unified_* is enough to ignore the plan meter', () => {
  const usage = buildCursorUsage({
    provider: 'cursor',
    sand: { ...sandFixture, isUnified: false },
    summary: unifiedSummaryFixture,
    now: () => NOW_MS
  });
  assert.equal(usage.extra.unified, true);
  assert.equal(usage.weekly.used_pct, 89.1);
  assert.equal(usage.extra.cursor_plan.ignored_for_decision, true);
});

test('non-unified cursor check keeps the more-used meter', () => {
  const sandHigher = buildCursorUsage({
    provider: 'cursor',
    sand: { ...sandFixture, isUnified: false, usagePercent: 70 },
    summary: { ...planSummaryFixture, individualUsage: { plan: { totalPercentUsed: 10 } } },
    now: () => NOW_MS
  });
  assert.equal(sandHigher.extra.unified, false);
  assert.equal(sandHigher.extra.authoritative_meter, 'grokbot');
  assert.equal(sandHigher.weekly.used_pct, 70);

  const planHigher = buildCursorUsage({
    provider: 'cursor',
    sand: { ...sandFixture, isUnified: false, usagePercent: 10 },
    summary: planSummaryFixture,
    now: () => NOW_MS
  });
  assert.equal(planHigher.extra.authoritative_meter, 'cursor_plan');
  assert.equal(planHigher.weekly.label, 'Cursor');
  assert.equal(planHigher.weekly.used_pct, 80);
  assert.equal(planHigher.weekly.remaining_pct, 20);
  assert.equal(planHigher.weekly.resets_at, '2026-11-01T00:00:00.000Z');
});

test('grokbot provider reads only the sand meter and allows when remaining is enough', async () => {
  const token = cursorJwt({ sig: 'grokbot-allow-secret' });
  const { dir, authPath, env } = await isolatedHome(token);
  const before = await readFile(authPath, 'utf8');
  const calls = [];
  const io = streams();
  let cliCalls = 0;
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--weekly-min=10', '--no-cache', '--debug'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => { cliCalls += 1; },
    fetchImpl: cursorFetch({
      sand: okResponse({ ...sandFixture, usagePercent: 20, isUnified: true }),
      summary: () => { throw new Error('summary must not be called'); },
      calls
    })
  });
  const after = await readFile(authPath, 'utf8');
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 0);
  assert.equal(cliCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SAND_USAGE_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{}');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.headers['Connect-Protocol-Version'], '1');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(io.json().allowed, true);
  assert.equal(io.json().usage.provider_id, 'grokbot');
  assert.equal(io.json().usage.weekly.remaining_pct, 80);
  assert.equal(after, before);
  assertNoSecrets(`${io.out}\n${io.err}`, token);
  assert.match(io.err, /credential source=cli/);
});

test('cursor provider does not allow a unified plan from the zero plan meter', async () => {
  const token = cursorJwt({ sig: 'unified-secret' });
  const { dir, env } = await isolatedHome(token);
  const calls = [];
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=cursor', '--weekly-min=20', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => { throw new Error('cli must not run'); },
    fetchImpl: cursorFetch({
      sand: okResponse(sandFixture),
      summary: (init) => {
        const cookie = init.headers.Cookie;
        assert.equal(cookie, `WorkosCursorSessionToken=${encodeURIComponent(`user_01TEST::${token}`)}`);
        return okResponse(unifiedSummaryFixture);
      },
      calls
    })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 2);
  assert.equal(io.json().reason, 'below_threshold');
  assert.equal(io.json().usage.weekly.used_pct, 89.1);
  assert.equal(io.json().usage.weekly.remaining_pct, 10.9);
  assert.equal(io.json().usage.extra.authoritative_meter, 'grokbot');
  assert.equal(io.json().usage.extra.cursor_plan.used_pct, 0);
  assert.equal(io.json().usage.extra.cursor_plan.ignored_for_decision, true);
  assert.equal(calls.length, 2);
  assertNoSecrets(io.out, token);
});

test('non-unified cursor provider gates on the more-used meter', async () => {
  const token = cursorJwt();
  const { dir, env } = await isolatedHome(token);
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=cursor', '--weekly-min=50', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => { throw new Error('cli must not run'); },
    fetchImpl: cursorFetch({
      sand: okResponse({ ...sandFixture, isUnified: false, usagePercent: 10 }),
      summary: okResponse(planSummaryFixture)
    })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 2);
  assert.equal(io.json().usage.extra.unified, false);
  assert.equal(io.json().usage.extra.authoritative_meter, 'cursor_plan');
  assert.equal(io.json().usage.weekly.remaining_pct, 20);
});

test('unified sand reading stands when the plan summary fails', async () => {
  const token = cursorJwt();
  const { dir, env } = await isolatedHome(token);
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=cursor', '--weekly-min=50', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => { throw new Error('cli must not run'); },
    fetchImpl: cursorFetch({
      sand: okResponse({ ...sandFixture, usagePercent: 15 }),
      summary: okResponse({ error: 'unavailable' }, 500)
    })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 0);
  assert.equal(io.json().usage.weekly.remaining_pct, 85);
  assert.equal(io.json().usage.extra.cursor_plan.unavailable, true);
  assert.equal(io.json().usage.extra.cursor_plan.ignored_for_decision, true);
});

test('non-unified plan summary failure stays unknown', async () => {
  const token = cursorJwt();
  const { dir, env } = await isolatedHome(token);
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=cursor', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => { throw new Error('cli must not run'); },
    fetchImpl: cursorFetch({
      sand: okResponse({ ...sandFixture, isUnified: false, usagePercent: 10 }),
      summary: okResponse({ error: 'unavailable' }, 500)
    })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 1);
  assert.equal(io.json().reason, 'cursor_plan_usage_500');
});

test('missing sand usage percent is unknown', async () => {
  const token = cursorJwt();
  const { dir, env } = await isolatedHome(token);
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    fetchImpl: cursorFetch({ sand: okResponse({ hasAvailableUsage: true }) })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 1);
  assert.equal(io.json().reason, 'invalid_cursor_usage_response');
});

test('a zero included limit is unknown instead of plenty left', async () => {
  const token = cursorJwt();
  const { dir, env } = await isolatedHome(token);
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--weekly-min=50', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    fetchImpl: cursorFetch({ sand: okResponse({ usagePercent: 0, includedLimitZero: true }) })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 1);
  assert.equal(io.json().reason, 'cursor_no_included_quota');
});

test('pooled enterprise usage is unknown', async () => {
  const token = cursorJwt();
  const { dir, env } = await isolatedHome(token);
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    fetchImpl: cursorFetch({ sand: okResponse({ usagePercent: 0, usesPooledEnterpriseAllowance: true }) })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 1);
  assert.equal(io.json().reason, 'cursor_pooled_enterprise_usage');
});

test('non-200 sand response is unknown and does not refresh', async () => {
  const token = cursorJwt();
  const { dir, env } = await isolatedHome(token);
  const io = streams();
  let cliCalls = 0;
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => { cliCalls += 1; },
    fetchImpl: cursorFetch({ sand: okResponse({ error: 'rate limited' }, 429) })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 1);
  assert.equal(io.json().reason, 'cursor_sand_usage_429');
  assert.equal(cliCalls, 0);
});

test('missing cursor auth is unknown and does not call the CLI', async () => {
  const { dir, env } = await isolatedHome();
  const io = streams();
  let cliCalls = 0;
  const code = await runQuotaGate({
    argv: ['--provider=cursor', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => { cliCalls += 1; },
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 1);
  assert.equal(io.json().reason, 'missing_cursor_credentials');
  assert.match(io.json().hint, /cursor-agent login/);
  assert.equal(cliCalls, 0);
});

test('CURSOR_ACCESS_TOKEN overrides auth.json', async () => {
  const fileToken = cursorJwt({ sig: 'file-secret' });
  const envToken = cursorJwt({ sig: 'env-secret' });
  const { dir, env } = await isolatedHome(fileToken);
  const calls = [];
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--weekly-min=10', '--no-cache'],
    env: { ...env, CURSOR_ACCESS_TOKEN: envToken },
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    fetchImpl: cursorFetch({
      sand: okResponse({ ...sandFixture, usagePercent: 5 }),
      calls
    })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 0);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${envToken}`);
});

test('an expired env token falls through to a live CLI token', async () => {
  const expired = cursorJwt({ exp: PAST_EXP, sig: 'expired-env-secret' });
  const live = cursorJwt({ sig: 'live-file-secret' });
  const { dir, env } = await isolatedHome(live);
  const calls = [];
  const io = streams();
  let cliCalls = 0;
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--weekly-min=10', '--no-cache'],
    env: { ...env, CURSOR_ACCESS_TOKEN: expired },
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => { cliCalls += 1; },
    fetchImpl: cursorFetch({
      sand: okResponse({ ...sandFixture, usagePercent: 5 }),
      calls
    })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 0);
  assert.equal(cliCalls, 0);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${live}`);
});

test('expired token asks the CLI to refresh, re-reads auth.json, and retries once', async () => {
  const expired = cursorJwt({ exp: PAST_EXP, sig: 'expired-secret' });
  const fresh = cursorJwt({ sig: 'fresh-secret' });
  const { dir, authPath, env } = await isolatedHome(expired);
  const calls = [];
  const cliCalls = [];
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=cursor', '--weekly-min=50', '--no-cache', '--debug'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async ({ args }) => {
      cliCalls.push(args);
      await writeFile(authPath, `${JSON.stringify({ accessToken: fresh, refreshToken: 'next-refresh-token' })}\n`);
    },
    fetchImpl: cursorFetch({
      sand: okResponse({ ...sandFixture, usagePercent: 10 }),
      summary: okResponse(unifiedSummaryFixture),
      calls
    })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 0);
  assert.deepEqual(cliCalls, [['status']]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${fresh}`);
  assert.equal(calls[1].init.headers.Cookie, `WorkosCursorSessionToken=${encodeURIComponent(`user_01TEST::${fresh}`)}`);
  assertNoSecrets(`${io.out}\n${io.err}`, expired);
  assert.equal(io.out.includes(fresh), false);
  assert.equal(io.err.includes('next-refresh-token'), false);
});

test('expired token stays unknown when the CLI does not refresh it', async () => {
  const expired = cursorJwt({ exp: PAST_EXP, sig: 'still-expired-secret' });
  const { dir, env } = await isolatedHome(expired);
  const io = streams();
  let fetches = 0;
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => ({ installed: false }),
    fetchImpl: async () => { fetches += 1; return okResponse(sandFixture); }
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 1);
  assert.equal(fetches, 0);
  assert.equal(io.json().reason, 'auth_expired');
  assert.equal(io.json().hint, CURSOR_AUTH_EXPIRED_HINT);
  assert.match(io.json().hint, /NO_OPEN_BROWSER=1 cursor-agent login/);
  assert.match(io.json().hint, /cursor-agent status/);
  assert.equal(io.out.includes(expired), false);
});

test('401 triggers one CLI refresh and a single retry', async () => {
  const rejected = cursorJwt({ sig: 'rejected-secret' });
  const fresh = cursorJwt({ sig: 'retried-secret' });
  const { dir, authPath, env } = await isolatedHome(rejected);
  const seen = [];
  let cliCalls = 0;
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--weekly-min=10', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => {
      cliCalls += 1;
      await writeFile(authPath, JSON.stringify({ accessToken: fresh, refreshToken: 'refresh-2' }));
    },
    fetchImpl: cursorFetch({
      sand: (init) => {
        seen.push(init.headers.Authorization);
        return okResponse(seen.length === 1 ? { error: 'unauthorized' } : { ...sandFixture, usagePercent: 12 }, seen.length === 1 ? 401 : 200);
      }
    })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 0);
  assert.equal(cliCalls, 1);
  assert.deepEqual(seen, [`Bearer ${rejected}`, `Bearer ${fresh}`]);
});

test('403 after an unchanged CLI refresh is auth_expired', async () => {
  const token = cursorJwt({ sig: 'forbidden-secret' });
  const { dir, env } = await isolatedHome(token);
  let fetches = 0;
  let cliCalls = 0;
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=cursor', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => { cliCalls += 1; },
    fetchImpl: cursorFetch({
      sand: () => { fetches += 1; return okResponse({ error: 'forbidden' }, 403); },
      summary: () => { throw new Error('summary must not be called'); }
    })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 1);
  assert.equal(cliCalls, 1);
  assert.equal(fetches, 1);
  assert.equal(io.json().reason, 'auth_expired');
  assert.match(io.json().hint, /cursor-agent login/);
});

test('a second 401 after refresh stays auth_expired', async () => {
  const first = cursorJwt({ sig: 'first-secret' });
  const second = cursorJwt({ sig: 'second-secret' });
  const { dir, authPath, env } = await isolatedHome(first);
  let fetches = 0;
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    runCommand: async () => {
      await writeFile(authPath, JSON.stringify({ accessToken: second }));
    },
    fetchImpl: cursorFetch({
      sand: () => { fetches += 1; return okResponse({ error: 'unauthorized' }, 401); }
    })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 1);
  assert.equal(fetches, 2);
  assert.equal(io.json().reason, 'auth_expired');
});

test('cursor-agent status refreshes auth.json without receiving the token on argv', async () => {
  const expired = cursorJwt({ exp: PAST_EXP, sig: 'argv-expired-secret' });
  const fresh = cursorJwt({ sig: 'argv-fresh-secret' });
  const { dir, authPath, env } = await isolatedHome(expired);
  const logPath = join(dir, 'cli-log.json');
  const scriptPath = join(dir, 'cursor-agent');
  const nextAuth = `${JSON.stringify({ accessToken: fresh, refreshToken: 'cli-wrote-refresh' })}\n`;
  await writeFile(scriptPath, `#!/bin/sh
printf '%s\\n' "$1" > "$CURSOR_AGENT_LOG"
printf '%s\\n' "$NO_OPEN_BROWSER" >> "$CURSOR_AGENT_LOG"
if [ -n "$CURSOR_ACCESS_TOKEN" ]; then
  printf '%s\\n' present >> "$CURSOR_AGENT_LOG"
else
  printf '%s\\n' absent >> "$CURSOR_AGENT_LOG"
fi
if [ -n "$CURSOR_AGENT_NEXT_AUTH" ]; then
  printf '%s' "$CURSOR_AGENT_NEXT_AUTH" > "$CURSOR_AUTH_PATH"
fi
`, 'utf8');
  await chmod(scriptPath, 0o755);
  const calls = [];
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--weekly-min=10', '--no-cache'],
    env: {
      ...env,
      PATH: dir,
      CURSOR_ACCESS_TOKEN: expired,
      CURSOR_AGENT_BIN: scriptPath,
      CURSOR_AGENT_LOG: logPath,
      CURSOR_AGENT_NEXT_AUTH: nextAuth
    },
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    fetchImpl: cursorFetch({
      sand: okResponse({ ...sandFixture, usagePercent: 8 }),
      calls
    })
  });
  const log = await readFile(logPath, 'utf8');
  const rewritten = await readFile(authPath, 'utf8');
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 0);
  assert.equal(log, 'status\n1\nabsent\n');
  assert.equal(log.includes(expired), false);
  assert.equal(rewritten.includes(fresh), true);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${fresh}`);
  assert.equal(io.out.includes(expired), false);
  assert.equal(io.out.includes(fresh), false);
});

test('cursor usage cache hit skips the network', async () => {
  const { dir, env } = await isolatedHome();
  const cached = buildCursorUsage({
    provider: 'cursor',
    sand: { ...sandFixture, usagePercent: 10 },
    summary: unifiedSummaryFixture,
    now: () => NOW_MS
  });
  await writeUsageCache(cached, {
    path: join(dir, 'cache', 'quota-gate', 'cursor-direct.json'),
    now: () => NOW_MS
  });
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=cursor', '--weekly-min=50'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    fetchImpl: async () => { throw new Error('network should not be called'); }
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 0);
  assert.equal(io.json().allowed, true);
  assert.equal(io.json().usage.weekly.remaining_pct, 90);
});

test('cursor five-hour threshold fails closed because there is no five-hour window', async () => {
  const token = cursorJwt();
  const { dir, env } = await isolatedHome(token);
  const io = streams();
  const code = await runQuotaGate({
    argv: ['--provider=grokbot', '--five-hour-min=10', '--no-cache'],
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    now: () => NOW_MS,
    fetchImpl: cursorFetch({ sand: okResponse({ ...sandFixture, usagePercent: 10 }) })
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(code, 1);
  assert.equal(io.json().reason, 'missing_five_hour_usage');
});

test('debug redaction covers cursor JWTs and session cookies', () => {
  const token = cursorJwt({ sig: 'debug-secret' });
  const redacted = redactSecrets(`Authorization: Bearer ${token} Cookie: WorkosCursorSessionToken=${encodeURIComponent(`user_01TEST::${token}`)}`);
  assert.equal(redacted.includes(token), false);
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /WorkosCursorSessionToken=\[REDACTED\]/);
});
