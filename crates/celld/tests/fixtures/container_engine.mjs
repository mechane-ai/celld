#!/usr/bin/env node
// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const args = process.argv.slice(2);
const directory = process.env.CELLD_IMAGE_TEST_STATE;
const mode = process.env.CELLD_IMAGE_TEST_MODE;
const real = parameters => spawnSync(process.env.CELLD_IMAGE_TEST_DOCKER, parameters, { encoding: 'utf8' });
const finish = result => {
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
};

if (args[0] === 'build') {
  const built = real(args);
  if (built.status !== 0) finish(built);
  const image = built.stdout.trim();
  const inspected = real(['image', 'inspect', '--format', '{{json .RootFS.Layers}}{{json .Config}}', image]);
  if (inspected.status !== 0) finish(inspected);
  const key = createHash('sha256').update(inspected.stdout.trim()).digest('hex');
  fs.writeFileSync(`${directory}/fence-reference`, `celld-image:${key}`);
  if (mode === 'concurrent') {
    const barrier = await fetch(process.env.CELLD_IMAGE_TEST_BARRIER);
    if (!barrier.ok) throw new Error('fixture build barrier failed');
  }
  finish(built);
}

const reference = fs.existsSync(`${directory}/fence-reference`)
  ? fs.readFileSync(`${directory}/fence-reference`, 'utf8') : undefined;
const inspecting = args[0] === 'image' && args[1] === 'inspect' && args.at(-1) === reference;
if (inspecting && mode === 'conflicting-reference') {
  finish(real([...args.slice(0, -1), 'alpine:3.20']));
}
if (inspecting && (mode === 'failed-tag-matching' || mode === 'failed-tag-conflicting')) {
  const marker = `${directory}/inspected`;
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'first inspection');
    process.stderr.write('fixture: reference not installed at first inspection\n');
    process.exit(1);
  }
  if (mode === 'failed-tag-conflicting') {
    finish(real([...args.slice(0, -1), 'alpine:3.20']));
  }
}
if (args[0] === 'tag' && args.at(-1) === reference && mode?.startsWith('failed-tag-')) {
  if (mode === 'failed-tag-matching') real(args);
  fs.writeFileSync(`${directory}/tag-failed`, 'failure injected after tag attempt');
  process.stderr.write('fixture: concurrent image tag failed\n');
  process.exit(1);
}
finish(real(args));
