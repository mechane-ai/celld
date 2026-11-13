// Copyright 2026 Deno Land Inc. Apache-2.0 license.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(process.argv[2] || 'target/debug/celld');
const directory = await mkdtemp(join(tmpdir(), 'celld-shared-'));
const token = randomUUID();
const docker = process.env.CELLD_DOCKER || 'docker';
const dockerRead = args => execFileSync(docker, args, { encoding: 'utf8' }).trim();
const logs = [];
let child;
let closed;
let origin;
let passed = false;

async function stop() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGINT');
  let timeout;
  try {
    await Promise.race([closed, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Runtime did not stop; retained ' + directory)), 40000);
    })]);
  } finally { clearTimeout(timeout); }
  child = undefined;
}

async function start() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(binary, ['dev', directory, '--port', String(port), '--no-watch', '--logs'], {
    detached: true, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  closed = new Promise(resolve => child.once('close', resolve));
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && child.exitCode === null) {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Runtime readiness failed\n' + logs.join(''));
}

async function call(owner, command, action = 'run') {
  const url = new URL(action, origin);
  url.searchParams.set('owner', owner);
  if (command) url.searchParams.set('command', command);
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

const accountCommand = "wget -qO- --header='x-owner: forged' --header='x-celld-egress-key: forged' http://softmax.internal/account";

try {
  await copyFile(new URL('fixtures/shared_container.js', import.meta.url), join(directory, 'index.js'));
  await writeFile(join(directory, 'wrangler.jsonc'), JSON.stringify({
    name: 'shared-container-system', main: 'index.js', compatibility_date: '2026-10-01',
    containers: [{ class_name: 'Machine', image: 'alpine:3.20', local_persistent_directories: ['/workspace'] }],
    durable_objects: { bindings: [{ name: 'MACHINES', class_name: 'Machine' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Machine'] }], vars: { TEST_ID: token },
  }));
  await start();
  const first = await call('alpha', 'printf once >> /workspace/effects; printf first');
  assert.equal(first.exitCode, 0, first.stderr);
  assert.deepEqual(first.disposal, { present: true, enumerable: false, writable: true, configurable: true });
  const isolated = await call('beta', 'test ! -e /workspace/effects');
  assert.equal(isolated.exitCode, 0, isolated.stderr);
  const calls = await Promise.all(Array.from({ length: 8 }, (_, i) => call(i % 2 ? 'alpha' : 'beta', accountCommand)));
  const keys = new Map();
  for (const [i, result] of calls.entries()) {
    assert.equal(result.exitCode, 0, result.stderr);
    const account = JSON.parse(result.stdout);
    assert.equal(account.owner, i % 2 ? 'alpha' : 'beta');
    assert.equal(account.leakedTransport, false);
    keys.set(account.owner, account.key);
  }
  assert.notEqual(keys.get('alpha'), keys.get('beta'));
  const hostSpoof = await call('alpha', "wget -T 3 -qO- --header='Host: foreign.invalid' http://softmax.internal/account");
  assert.notEqual(hostSpoof.exitCode, 0);
  const environment = await call('alpha', 'env');
  assert.ok(!environment.stdout.includes('CELLD_EGRESS'));
  const nodes = dockerRead(['ps', '-q', '--filter', `label=celld.user.shared.test=${token}`]).split('\n').filter(Boolean);
  assert.equal(nodes.length, 2);
  const containers = JSON.parse(dockerRead(['inspect', ...nodes]));
  for (const container of containers) {
    assert.ok(container.HostConfig.CapDrop.includes('ALL'));
    assert.ok(container.HostConfig.SecurityOpt.some(option => option.startsWith('no-new-privileges')));
  }
  await call('alpha', undefined, 'stop');
  assert.equal((await call('alpha', 'cat /workspace/effects')).stdout, 'once');
  await stop();
  await start();
  assert.equal((await call('alpha', 'cat /workspace/effects')).stdout, 'once');
  assert.equal((await call('beta', 'test ! -e /workspace/effects')).exitCode, 0);
  const restored = JSON.parse((await call('alpha', accountCommand)).stdout);
  assert.equal(restored.key, keys.get('alpha'));
  passed = true;
  console.log(JSON.stringify({ coldExec: true, rpcDisposal: true, containerReplacement: true, runtimeRestart: true, fileIsolation: true, authenticatedIntercept: true, concurrentRequests: calls.length }));
} finally {
  await stop();
  if (passed) {
    const names = dockerRead(['volume', 'ls', '-q', '--filter', 'label=celld.local-installation']).split('\n').filter(Boolean);
    if (names.length) {
      const volumes = JSON.parse(dockerRead(['volume', 'inspect', ...names]));
      for (const volume of volumes) {
        const owner = volume.Labels['celld.local-installation'];
        if (owner === directory || owner.startsWith(`${directory}/`)) dockerRead(['volume', 'rm', volume.Name]);
      }
    }
    await rm(directory, { recursive: true });
  } else {
    await writeFile(join(directory, 'qualification.log'), logs.join(''));
    console.error('Retained unqualified runtime state at ' + directory);
  }
}
