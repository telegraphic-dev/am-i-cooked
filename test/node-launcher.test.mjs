import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const launcher = resolve('skills/quota-gate/scripts/quota-gate');
const currentNode = process.execPath;

async function runLauncher(args, options = {}) {
  try {
    const result = await execFileAsync(launcher, args, {
      ...options,
      maxBuffer: 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('launcher finds Node from NVM when PATH has no node', async () => {
  const home = await mkdtemp(join(tmpdir(), 'quota-gate-nvm-'));
  const nodePath = join(home, '.nvm', 'versions', 'node', 'v20.99.0', 'bin', 'node');
  await mkdir(dirname(nodePath), { recursive: true });
  await symlink(currentNode, nodePath);

  const result = await runLauncher(['--no-cache'], {
    env: {
      HOME: home,
      PATH: '/definitely-no-node-here',
      CLAUDE_CONFIG_DIR: join(home, 'missing-credentials'),
      XDG_CACHE_HOME: join(home, 'cache')
    }
  });

  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).reason, 'missing_claude_code_credentials');
});

test('launcher fails closed with JSON when Node >=20 is unavailable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'quota-gate-no-node-'));
  const binDir = join(home, 'bin');
  const sedPath = join(binDir, 'sed');
  await mkdir(binDir, { recursive: true });
  await symlink('/bin/sed', sedPath);

  const result = await runLauncher(['--weekly-min=50'], {
    env: {
      HOME: home,
      PATH: binDir,
      CLAUDE_CONFIG_DIR: join(home, 'missing-credentials'),
      XDG_CACHE_HOME: join(home, 'cache')
    }
  });

  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).reason, 'node_runtime_missing');
});

test('launcher is executable', async () => {
  await chmod(launcher, 0o755);
  const result = await runLauncher(['--no-cache'], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(await mkdtemp(join(tmpdir(), 'quota-gate-exec-')), 'missing-credentials')
    }
  });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /"allowed":false/);
});


test('deprecated claude-quota-gate launcher delegates to renamed quota-gate skill', async () => {
  const home = await mkdtemp(join(tmpdir(), 'quota-gate-legacy-'));
  const legacy = resolve('skills/claude-quota-gate/scripts/quota-gate');
  let result;
  try {
    const output = await execFileAsync(legacy, ['--no-cache'], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(home, 'missing-credentials'),
        XDG_CACHE_HOME: join(home, 'cache')
      },
      maxBuffer: 1024 * 1024
    });
    result = { code: 0, stdout: output.stdout };
  } catch (error) {
    result = { code: error.code, stdout: error.stdout };
  }

  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).reason, 'missing_claude_code_credentials');
});
