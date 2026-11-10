// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const binary = resolve(repository, process.argv[2] || 'target/debug/celld');
await access(binary, constants.X_OK);
const engine = execFileSync('which', [process.env.CELLD_DOCKER || 'docker'], { encoding: 'utf8' }).trim();
execFileSync(engine, ['info'], { stdio: 'ignore' });
const directory = await mkdtemp(join(tmpdir(), 'celld-container-images-'));
const peers = [];
const barrier = createServer((_request, response) => {
  peers.push(response);
  if (peers.length === 2) for (const peer of peers.splice(0)) peer.end('released');
});
const children = [];
let sequence = 0;

async function stop(record) {
  if (!record.child.pid || record.exited) return;
  const signal = name => {
    try { process.kill(-record.child.pid, name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signal('SIGINT');
  const timeout = setTimeout(() => { if (!record.exited) signal('SIGKILL'); }, 5000);
  await record.closed;
  clearTimeout(timeout);
}

async function start(mode, success) {
  const project = join(directory, `${mode}-${sequence++}`);
  await mkdir(project);
  await copyFile(new URL('fixtures/container_images.js', import.meta.url), join(project, 'index.js'));
  const wrapper = join(project, 'engine.mjs');
  await copyFile(new URL('fixtures/container_engine.mjs', import.meta.url), wrapper);
  await chmod(wrapper, 0o755);
  await writeFile(join(project, 'wrangler.jsonc'), JSON.stringify({
    name: 'container-image-regression', main: 'index.js', compatibility_date: '2026-10-01',
    containers: [{ class_name: 'ImageObject', image: 'alpine:3.20' }],
    durable_objects: { bindings: [{ name: 'IMAGES', class_name: 'ImageObject' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['ImageObject'] }],
  }));
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(binary, ['dev', project, '--port', String(port), '--no-watch', '--logs'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, CELLD_DOCKER: wrapper, CELLD_IMAGE_TEST_DOCKER: engine,
      CELLD_IMAGE_TEST_MODE: mode, CELLD_IMAGE_TEST_STATE: project,
      CELLD_IMAGE_TEST_BARRIER: `http://127.0.0.1:${barrier.address().port}`,
    },
  });
  const record = { child, exited: false, logs: [] };
  record.closed = new Promise(resolve => child.once('close', () => { record.exited = true; resolve(); }));
  child.once('error', error => { record.exited = true; record.logs.push(String(error)); });
  child.stdout.on('data', chunk => record.logs.push(String(chunk)));
  child.stderr.on('data', chunk => record.logs.push(String(chunk)));
  children.push(record);
  const deadline = Date.now() + 60000;
  let ready = false;
  while (!ready && !record.exited && Date.now() < deadline) {
    try { ready = (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(ready, success, `${mode} readiness\n${record.logs.join('')}`);
  if (!success) assert.ok(record.exited, `${mode} failed rather than hanging`);
  return { record, project };
}

try {
  await new Promise((resolve, reject) => {
    barrier.once('error', reject);
    barrier.listen(0, '127.0.0.1', resolve);
  });
  const starts = await Promise.allSettled([start('concurrent', true), start('concurrent', true)]);
  const concurrent = starts.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  assert.equal(peers.length, 0, 'both real fence builds crossed the explicit barrier');
  for (const item of concurrent) await stop(item.record);
  const recovered = await start('failed-tag-matching', true);
  await readFile(join(recovered.project, 'tag-failed'));
  await stop(recovered.record);
  const conflict = await start('conflicting-reference', false);
  assert.match(conflict.record.logs.join(''), /content-addressed container image .* has different content/);
  const failed = await start('failed-tag-conflicting', false);
  await readFile(join(failed.project, 'tag-failed'));
  assert.match(failed.record.logs.join(''), /fixture: concurrent image tag failed/);
  console.log('concurrent image resolution and matching tag recovery pass; conflicting content stays refused');
} finally {
  for (const record of children) await stop(record);
  for (const peer of peers) peer.destroy();
  barrier.closeAllConnections();
  await new Promise(resolve => barrier.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
