// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer, get } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const binary = resolve(repository, process.argv[2] || 'target/debug/celld');
await access(binary, constants.X_OK);
const docker = process.env.CELLD_DOCKER || 'docker';
const image = process.env.CELLD_HOST_SERVICE_TEST_IMAGE || 'node:24.22.1-alpine';
const directory = await mkdtemp(join(tmpdir(), 'celld-host-services-'));
const token = randomUUID();
const clients = new Set();
const services = [];
const projects = [];
const nativeLinux = process.platform === 'linux';
const helperProfile = process.env.CELLD_HOST_SERVICE_TEST_PROFILE || (binary.includes('/debug/') ? 'dev' : 'release');
const helperArguments = ['test', '--locked', '--profile', helperProfile, '-p', 'celld', '--test', 'container_host_services_fixture'];
const dockerRead = args => execFileSync(docker, args, { encoding: 'utf8' }).trim();
const pause = () => new Promise(resolve => setTimeout(resolve, 25));

async function listen(server, host) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function startService() {
  const server = createServer({ key, cert }, (request, response) => {
    const authorized = request.headers.authorization === `Bearer ${token}`;
    response.writeHead(authorized ? 200 : 401);
    response.end(authorized ? 'native-host-service' : 'unauthorized');
  });
  services.push(server);
  return listen(server, '0.0.0.0');
}

async function stop(project, signal = 'SIGINT') {
  const running = project.running;
  if (!running) return;
  if (signal === 'SIGKILL') {
    const children = spawnSync('pgrep', ['-P', String(running.child.pid)], { encoding: 'utf8' });
    assert.equal(children.status, 0, 'the fixture owns a native child before simulating abrupt loss');
    for (const text of children.stdout.trim().split(/\s+/).filter(Boolean)) {
      process.kill(Number(text), 'SIGKILL');
    }
  }
  if (running.child.exitCode === null && running.child.signalCode === null) {
    try { process.kill(-running.child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  let timeout;
  try {
    const status = await Promise.race([
      running.closed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`node did not stop; retained ${project.directory}`)), 40000);
      }),
    ]);
    if (signal !== 'SIGKILL') assert.equal(status.code, 0, running.logs.join(''));
  } finally { clearTimeout(timeout); }
  project.running = undefined;
}

async function start(project, ports) {
  const reservation = createHttpServer();
  const port = await listen(reservation, '127.0.0.1');
  await new Promise(resolve => reservation.close(resolve));
  const logs = [];
  const environment = { ...process.env, CELLD_TEST_DATA_DIR: project.statePath || './state' };
  delete environment.CELLD_CONTAINER_HOST_SERVICES;
  if (ports !== undefined) environment.CELLD_CONTAINER_HOST_SERVICES = ports;
  const child = spawn(binary, ['dev', project.directory, '--port', String(port), '--no-watch', '--logs'], {
    detached: true,
    cwd: project.directory,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.once('error', error => logs.push(String(error)));
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  project.running = { child, closed, logs, origin: `http://127.0.0.1:${port}` };
  clients.add(project);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      if ((await fetch(`${project.running.origin}/health`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await pause();
  }
  throw new Error(`node did not reconcile before readiness\n${logs.join('')}`);
}

async function publishConfiguration(project, containers) {
  const configuration = structuredClone(project.configuration);
  if (!containers) delete configuration.containers;
  configuration.vars.TEST_MODE = containers ? 'containers' : 'container-free';
  const path = join(project.directory, 'wrangler.jsonc');
  await writeFile(path, JSON.stringify(configuration));
  const nonce = randomUUID();
  execFileSync('cargo', [...helperArguments, '--', '--ignored', '--exact', 'publish_local_fixture'], {
    cwd: repository,
    env: {
      ...process.env,
      RUSTUP_TOOLCHAIN: '1.98.1',
      CELLD_HOST_SERVICE_TEST_PROJECT: project.directory,
      CELLD_HOST_SERVICE_TEST_NONCE: nonce,
    },
    stdio: 'pipe',
  });
  const receipt = JSON.parse(await readFile(join(project.directory, 'fixture-publication.json'), 'utf8'));
  assert.equal(receipt.nonce, nonce, 'the exact owning publication helper ran');
  const candidateVersion = spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim().split(' ')[1];
  assert.equal(receipt.packageVersion, candidateVersion, 'fixture publication uses the candidate source version');
}

async function reloadWithoutContainers(project) {
  await publishConfiguration(project, false);
  const internal = /celld internal listening on (\S+)/.exec(project.running.logs.join(''))?.[1];
  assert.ok(internal, 'the native operator listener is known');
  const response = await fetch(`http://${internal}/reload`, { method: 'POST', signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, await response.text());
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const current = await fetch(`${project.running.origin}/health`, { signal: AbortSignal.timeout(1000) });
    if (await current.text() === 'container-free') return;
    await pause();
  }
  throw new Error('the native generation did not adopt the container-free deployment');
}

async function probe(project, port, { internet = true, direct = false } = {}) {
  const host = direct ? bridgeGateway(internet) : 'host.docker.internal';
  const response = await fetch(`${project.running.origin}/probe`, {
    method: 'POST',
    body: JSON.stringify({ url: `https://${host}:${port}`, internet, requestedPort: port }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

function bridgeGateway(internet) {
  const network = JSON.parse(dockerRead(['network', 'inspect', internet ? 'celld' : 'celld-internal']))[0];
  const gateway = network.IPAM.Config.map(config => config.Gateway).find(address => /^\d+\./.test(address));
  assert.ok(gateway, 'the bridge has an IPv4 gateway');
  return gateway;
}

function ownedContainers(project) {
  return dockerRead(['ps', '-aq', '--filter', `label=celld.user.host-service.test=${project.id}`]).split('\n').filter(Boolean);
}

function expectAllowed(output) {
  assert.equal(output.exitCode, 0, JSON.stringify(output));
  assert.equal(output.stdout, 'native-host-service');
}

function expectDenied(output) {
  assert.notEqual(output.exitCode, 0, JSON.stringify(output));
  assert.equal(output.stdout, '');
}

let key;
let cert;
try {
  for (const value of ['0', '65536', '*', '443-444', 'localhost:443', '443,,444', '-1', '+1', ' ', '443,']) {
    const result = spawnSync(binary, ['--version'], { env: { ...process.env, CELLD_CONTAINER_HOST_SERVICES: value }, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `invalid native declaration was accepted: ${JSON.stringify(value)}`);
    assert.match(result.stderr, /CELLD_CONTAINER_HOST_SERVICES/);
  }
  for (const value of ['', '1,65535,443,443', ' 443, 8443 ']) {
    const result = spawnSync(binary, ['--version'], { env: { ...process.env, CELLD_CONTAINER_HOST_SERVICES: value }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  execFileSync('cargo', [...helperArguments, '--no-run'], {
    cwd: repository, env: { ...process.env, RUSTUP_TOOLCHAIN: '1.98.1' }, stdio: 'pipe',
  });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
    '-subj', '/CN=host.docker.internal', '-addext', 'subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  key = await readFile(join(directory, 'key.pem'));
  cert = await readFile(join(directory, 'cert.pem'));
  const firstPort = await startService();
  const secondPort = await startService();
  await new Promise((resolve, reject) => {
    get(`https://127.0.0.1:${firstPort}`, { ca: cert, headers: { authorization: `Bearer ${token}` } }, response => {
      response.resume();
      response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error('host service control failed')));
    }).on('error', reject);
  });
  for (const name of ['first', 'second']) {
    const project = { id: randomUUID(), directory: join(directory, name) };
    projects.push(project);
    await mkdir(project.directory);
    await copyFile(new URL('fixtures/container_host_services.js', import.meta.url), join(project.directory, 'index.js'));
    project.configuration = {
      name: `host-services-${name}`, main: 'index.js', compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'],
      containers: [{ class_name: 'HostServiceObject', image }],
      durable_objects: { bindings: [{ name: 'INSTANCES', class_name: 'HostServiceObject' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['HostServiceObject'] }],
      vars: { TEST_ID: project.id, TEST_TOKEN: token, TEST_CA: cert.toString('base64'), TEST_MODE: 'containers' },
    };
    await writeFile(join(project.directory, 'wrangler.jsonc'), JSON.stringify(project.configuration));
  }
  const [first, second] = projects;
  await start(first, '');
  if (nativeLinux) expectDenied(await probe(first, firstPort, { direct: true }));
  await stop(first);
  await start(first, String(firstPort));
  expectAllowed(await probe(first, firstPort));
  if (nativeLinux) {
    expectDenied(await probe(first, secondPort));
    expectAllowed(await probe(first, firstPort, { internet: false }));
  }
  const info = JSON.parse(dockerRead(['inspect', ...ownedContainers(first)]))
    .find(info => info.HostConfig.NetworkMode === 'celld');
  assert.ok(info, 'the opted-in container uses the open bridge');
  if (nativeLinux) {
    assert.deepEqual(info.HostConfig.ExtraHosts, [`host.docker.internal:${bridgeGateway(true)}`]);
  } else {
    assert.ok(!info.HostConfig.ExtraHosts?.some(value => value.startsWith('host.docker.internal:')));
  }
  const firstLiveIds = ownedContainers(first);
  await start(second, `${firstPort},${secondPort}`);
  for (const id of firstLiveIds) assert.equal(dockerRead(['inspect', '--format', '{{.State.Running}}', id]), 'true');
  expectAllowed(await probe(second, secondPort));
  expectAllowed(await probe(first, firstPort));
  const orphans = ownedContainers(first);
  assert.ok(orphans.length > 0);
  await stop(first, 'SIGKILL');
  await symlink('state', join(first.directory, 'state-alias'));
  first.statePath = './state-alias';
  await start(first, '');
  for (const id of orphans) assert.notEqual(spawnSync(docker, ['inspect', id], { stdio: 'ignore' }).status, 0);
  expectAllowed(await probe(second, firstPort));
  await reloadWithoutContainers(second);
  await stop(second);
  await publishConfiguration(second, true);
  await start(second, `${firstPort},${secondPort}`);
  expectAllowed(await probe(second, secondPort));
  const recoveryOrphans = ownedContainers(second);
  assert.ok(recoveryOrphans.length > 0);
  const receipt = join(second.directory, 'state/container-fence.json');
  assert.equal((await stat(receipt)).mode & 0o777, 0o600);
  await reloadWithoutContainers(second);
  if (nativeLinux) expectAllowed(await probe(first, secondPort, { direct: true }));
  await stop(second, 'SIGKILL');
  await start(second, undefined);
  for (const id of recoveryOrphans) assert.notEqual(spawnSync(docker, ['inspect', id], { stdio: 'ignore' }).status, 0);
  if (nativeLinux) expectDenied(await probe(first, secondPort, { direct: true }));
  await stop(second);
  await assert.rejects(stat(receipt), { code: 'ENOENT' });
  if (nativeLinux) expectDenied(await probe(first, firstPort, { direct: true }));
  await stop(first);
  assert.deepEqual(projects.flatMap(ownedContainers), []);
  console.log(nativeLinux
    ? 'Native TLS host service: exact/default denial, no widening, relative-directory overlap, alias recovery, container-free reload, unset receipt recovery and cleanup passed'
    : 'Desktop TLS forwarding: alias unchanged, relative-directory overlap, alias recovery, container-free reload, unset receipt recovery and cleanup passed; Linux port isolation is not asserted');
} finally {
  let failure;
  for (const project of clients) {
    try { await stop(project); } catch (error) { failure ??= error; }
  }
  if (failure) throw new Error(`gateway ports retained; reconcile ${directory}`, { cause: failure });
  for (const server of services) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(directory, { recursive: true, force: true });
}
