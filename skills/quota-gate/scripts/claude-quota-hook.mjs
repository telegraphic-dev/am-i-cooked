#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TRIGGER_PATTERN = String.raw`\b(expensive|long[- ]running|automated|quota[- ]sensitive|use (claude[- ])?quota[- ]gate|subagents?|agent swarm|multi[- ]agent|large refactor|mass refactor)\b`;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function extractPrompt(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['prompt', 'user_prompt', 'userPrompt', 'message', 'text']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
}

function shouldCheckQuota(prompt, env = process.env) {
  if (env.QUOTA_GATE_HOOK_ALWAYS === '1' || env.QUOTA_GATE_HOOK_ALWAYS === 'true') return true;
  if (!prompt.trim()) return false;
  const pattern = env.QUOTA_GATE_HOOK_PATTERN || DEFAULT_TRIGGER_PATTERN;
  return new RegExp(pattern, 'i').test(prompt);
}

function gateArgs(env = process.env) {
  const weeklyMin = env.QUOTA_GATE_WEEKLY_MIN || '10';
  const fiveHourMin = env.QUOTA_GATE_FIVE_HOUR_MIN || '10';
  const args = ['--provider=claude', `--weekly-min=${weeklyMin}`, `--five-hour-min=${fiveHourMin}`];
  if (env.QUOTA_GATE_CACHE_TTL_SECONDS) args.push(`--cache-ttl-seconds=${env.QUOTA_GATE_CACHE_TTL_SECONDS}`);
  if (env.QUOTA_GATE_NO_CACHE === '1' || env.QUOTA_GATE_NO_CACHE === 'true') args.push('--no-cache');
  if (env.QUOTA_GATE_DEBUG === '1' || env.QUOTA_GATE_DEBUG === 'true') args.push('--debug');
  return args;
}

function runGate(command, args, env = process.env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: 1, stdout: '', stderr: error.message }));
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function parseGateReason(stdout, stderr) {
  try {
    const json = JSON.parse(stdout);
    if (typeof json.reason === 'string') return json.reason;
  } catch {}
  const trimmed = stderr.trim();
  return trimmed ? trimmed.slice(0, 500) : 'unknown_ai_quota';
}

function blockDecision(reason) {
  return {
    decision: 'block',
    reason: `quota-gate blocked this Claude Code prompt: ${reason}`
  };
}

async function main({ env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let input = {};
  const rawInput = await readStdin();
  if (rawInput.trim()) {
    try {
      input = JSON.parse(rawInput);
    } catch {
      stdout.write(JSON.stringify(blockDecision('invalid_hook_input')) + '\n');
      return 0;
    }
  }

  const prompt = extractPrompt(input);
  if (!shouldCheckQuota(prompt, env)) return 0;

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const command = env.QUOTA_GATE_COMMAND || join(scriptDir, 'quota-gate');
  const result = await runGate(command, gateArgs(env), env);
  if (result.code === 0) return 0;

  const reason = result.code === 2 ? 'low_ai_quota' : parseGateReason(result.stdout, result.stderr);
  stdout.write(JSON.stringify(blockDecision(reason)) + '\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => process.exit(code)).catch(error => {
    process.stdout.write(JSON.stringify(blockDecision(error?.message || 'unknown_ai_quota')) + '\n');
    process.exit(0);
  });
}

export { DEFAULT_TRIGGER_PATTERN, extractPrompt, shouldCheckQuota, gateArgs, blockDecision };
