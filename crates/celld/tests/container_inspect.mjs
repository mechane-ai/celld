// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as engineRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const binary = resolve(repository, process.argv[2] || 'target/debug/celld');
await access(binary, constants.X_OK);
const docker = execFileSync('which', [process.env.CELLD_DOCKER || 'docker'], { encoding: 'utf8' }).trim();
const dockerHost = process.env.DOCKER_HOST || execFileSync(docker, [
  'context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}',
], { encoding: 'utf8' }).trim();
assert.ok(dockerHost.startsWith('unix://'), 'the fixture uses a local Docker engine');
const dockerSocket = dockerHost.slice('unix://'.length);
const directory = await mkdtemp(join(tmpdir(), 'celld-inspect-'));
const socket = join(directory, 'engine.sock');
const token = randomUUID();
const machine = randomUUID();
const createdContainers = new Set();
let name;
let holdStart = true;
let held;
let release;
const startHeld = new Promise(resolve => { held = resolve; });
const released = new Promise(resolve => { release = resolve; });
const engine = createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const url = new URL(incoming.url, 'http://docker');
  const creating = incoming.method === 'POST' && url.pathname.endsWith('/containers/create');
  if (creating) {
    const options = JSON.parse(body);
    if (options.Labels?.['celld.user.inspect.test'] === token) name = url.searchParams.get('name');
  }
  if (holdStart && name && incoming.method === 'POST' && url.pathname.endsWith(`/containers/${name}/start`)) {
    holdStart = false;
    held();
    await released;
  }
  const forwarded = engineRequest({
    socketPath: dockerSocket, method: incoming.method, path: incoming.url, headers: incoming.headers,
  }, response => {
    const answer = [];
    if (creating) response.on('data', chunk => answer.push(chunk));
    response.on('end', () => {
      if (creating && response.statusCode === 201) {
        const id = JSON.parse(Buffer.concat(answer)).Id;
        if (id) createdContainers.add(id);
      }
    });
    outgoing.writeHead(response.statusCode, response.headers);
    response.pipe(outgoing);
  });
  forwarded.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end('fixture Docker transport failed');
  });
  forwarded.end(body);
});
engine.on('upgrade', (request, stream, head) => {
  const target = connect(dockerSocket, () => {
    target.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      target.write(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`);
    }
    target.write('\r\n');
    if (head.length) target.write(head);
    stream.pipe(target);
    target.pipe(stream);
  });
  target.on('error', () => stream.destroy());
  stream.on('error', () => target.destroy());
});
let child;
let closed;
let exited = false;
const logs = [];

try {
  await new Promise((resolve, reject) => {
    engine.once('error', reject);
    engine.listen(socket, resolve);
  });
  await copyFile(new URL('fixtures/container_inspect.js', import.meta.url), join(directory, 'index.js'));
  const wrapper = join(directory, 'docker.mjs');
  await copyFile(new URL('fixtures/container_inspect_engine.mjs', import.meta.url), wrapper);
  await chmod(wrapper, 0o755);
  await writeFile(join(directory, 'wrangler.jsonc'), JSON.stringify({
    name: 'container-inspect-regression', main: 'index.js', compatibility_date: '2026-10-01',
    containers: [{ class_name: 'InspectObject', image: 'alpine:3.20' }],
    durable_objects: { bindings: [{ name: 'INSTANCES', class_name: 'InspectObject' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['InspectObject'] }], vars: { TEST_ID: token },
  }));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  child = spawn(binary, ['dev', directory, '--port', String(port), '--no-watch', '--logs'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, DOCKER_HOST: `unix://${socket}`, CELLD_DOCKER: wrapper,
      CELLD_INSPECT_TEST_DOCKER: docker, CELLD_INSPECT_TEST_DOCKER_HOST: dockerHost,
    },
  });
  closed = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
  child.once('error', error => { exited = true; logs.push(String(error)); });
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let ready = false;
  while (!ready && !exited && Date.now() < deadline) {
    try { ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ready, `celld readiness\n${logs.join('')}`);
  const read = async path => {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(30000) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  assert.equal(await read('/inspect'), null);
  const starting = read(`/begin?machine=${machine}`);
  let timeout;
  await Promise.race([
    startHeld,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Docker start was not held')), 30000); }),
  ]);
  clearTimeout(timeout);
  const pending = await read('/inspect');
  assert.deepEqual(pending, { image: '', labels: { 'mechane.machine': machine, 'inspect.test': token } });
  const actual = JSON.parse(execFileSync(docker, ['inspect', '--format', '{{json .Config.Labels}}', name], { encoding: 'utf8' }));
  assert.equal(actual['celld.user.mechane.machine'], machine);
  release();
  assert.equal(await starting, true);
  const running = await read('/inspect');
  const image = execFileSync(docker, ['inspect', '--format', '{{.Config.Image}}', name], { encoding: 'utf8' }).trim();
  assert.deepEqual(running, { image, labels: pending.labels });
  assert.equal(JSON.stringify(running).includes('fixture-private-value'), false);
  const conflict = await read(`/conflict?machine=${randomUUID()}`);
  assert.deepEqual(conflict, { refused: true, info: running });
  assert.equal(await read('/stop'), null);
  assert.deepEqual(await read('/fail'), { failed: true, info: null });
  await read('/stop');
  for (const id of createdContainers) spawnSync(docker, ['rm', '-f', id], { stdio: 'ignore' });
  const id = execFileSync(docker, [
    'create', '--name', name, '--label', 'celld.node=fixture-conflict',
    '--label', 'codex.task=celld-inspect-regression', 'alpine:3.20', 'sh', '-c', 'sleep 3600',
  ], { encoding: 'utf8' }).trim();
  createdContainers.add(id);
  execFileSync(docker, ['start', name], { stdio: 'ignore' });
  const foreign = await fetch(`${origin}/inspect`, { signal: AbortSignal.timeout(10000) });
  assert.equal(foreign.status, 500);
  assert.match((await foreign.json()).error, /container identity does not match/);
  console.log('Docker-backed inspection covers absent, starting, running, failed, destroyed, and conflicting identities');
} finally {
  release();
  if (child?.pid && !exited) {
    const stop = signal => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    stop('SIGINT');
    const timeout = setTimeout(() => { if (!exited) stop('SIGKILL'); }, 5000);
    await closed;
    clearTimeout(timeout);
  }
  const cleanupFailures = [];
  for (const id of createdContainers) {
    spawnSync(docker, ['rm', '-f', id], { stdio: 'ignore' });
    const remaining = spawnSync(docker, ['ps', '-a', '--filter', `id=${id}`, '--format', '{{.ID}}'], { encoding: 'utf8' });
    if (remaining.status !== 0 || remaining.stdout.trim()) cleanupFailures.push(id);
  }
  engine.closeAllConnections();
  await new Promise(resolve => engine.close(resolve));
  if (cleanupFailures.length) {
    throw new Error(`fixture containers remain: ${cleanupFailures.join(', ')}; project retained at ${directory}`);
  }
  await rm(directory, { recursive: true, force: true });
}
