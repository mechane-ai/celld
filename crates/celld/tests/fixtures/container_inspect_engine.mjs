#!/usr/bin/env node
// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import { spawnSync } from 'node:child_process';

const result = spawnSync(process.env.CELLD_INSPECT_TEST_DOCKER, process.argv.slice(2), {
  env: { ...process.env, DOCKER_HOST: process.env.CELLD_INSPECT_TEST_DOCKER_HOST },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
