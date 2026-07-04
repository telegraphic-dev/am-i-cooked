import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { extractPrompt, shouldCheckQuota, gateArgs } from '../skills/quota-gate/scripts/claude-quota-hook.mjs';

const hook = resolve('skills/quota-gate/scripts/claude-quota-hook');

async function fakeGate(script) {
  const dir = await mkdtemp(join(tmpdir(), 'quota-hook-gate-'));
  const command = join(dir, 'fake-gate.sh');
  await writeFile(command, script, 'utf8');
  await chmod(command, 0o755);
  return command;
}

async function runHook(input, env = {}) {
  return await new Promise(resolvePromise => {
    const child = spawn(hook, [], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('extractPrompt reads Claude hook prompt fields', () => {
  assert.equal(extractPrompt({ prompt: 'run this long-running job' }), 'run this long-running job');
  assert.equal(extractPrompt({ userPrompt: 'use quota-gate' }), 'use quota-gate');
  assert.equal(extractPrompt({ message: 'hello' }), 'hello');
});

test('shouldCheckQuota only triggers on quota-sensitive prompts by default', () => {
  assert.equal(shouldCheckQuota('hello Claude'), false);
  assert.equal(shouldCheckQuota('run this long-running refactor'), true);
  assert.equal(shouldCheckQuota('use quota-gate before this'), true);
  assert.equal(shouldCheckQuota('anything', { QUOTA_GATE_HOOK_ALWAYS: '1' }), true);
});

test('gateArgs maps hook environment to quota-gate CLI flags', () => {
  assert.deepEqual(gateArgs({ QUOTA_GATE_WEEKLY_MIN: '60', QUOTA_GATE_FIVE_HOUR_MIN: '25', QUOTA_GATE_NO_CACHE: 'true' }), [
    '--provider=claude',
    '--weekly-min=60',
    '--five-hour-min=25',
    '--no-cache'
  ]);
});

test('Claude hook stays silent when prompt is not quota-sensitive', async () => {
  const command = await fakeGate('#!/bin/sh\necho should-not-run\nexit 2\n');
  const result = await runHook({ prompt: 'please explain this small function' }, { QUOTA_GATE_COMMAND: command });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
});

test('Claude hook stays silent when quota-gate allows work', async () => {
  const command = await fakeGate('#!/bin/sh\nprintf \'{"allowed":true,"reason":"ok"}\\n\'\nexit 0\n');
  const result = await runHook({ prompt: 'run this long-running refactor' }, { QUOTA_GATE_COMMAND: command });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
});

test('Claude hook blocks when quota-gate reports low quota', async () => {
  const command = await fakeGate('#!/bin/sh\nprintf \'{"allowed":false,"reason":"below_threshold"}\\n\'\nexit 2\n');
  const result = await runHook({ prompt: 'run this long-running refactor' }, { QUOTA_GATE_COMMAND: command });
  assert.equal(result.code, 0);
  const json = JSON.parse(result.stdout);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /low_ai_quota/);
});

test('Claude hook blocks when quota is unknown', async () => {
  const command = await fakeGate('#!/bin/sh\nprintf \'{"allowed":false,"reason":"missing_claude_code_credentials"}\\n\'\nexit 1\n');
  const result = await runHook({ prompt: 'use quota-gate before this' }, { QUOTA_GATE_COMMAND: command });
  assert.equal(result.code, 0);
  const json = JSON.parse(result.stdout);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /missing_claude_code_credentials/);
});
