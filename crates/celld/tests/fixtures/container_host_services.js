// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import { DurableObject } from 'cloudflare:workers';
import process from 'node:process';

const request = `
const https = require('node:https');
const request = https.get(process.argv[1], {
  ca: Buffer.from(process.env.HOST_SERVICE_CA, 'base64'),
  servername: 'host.docker.internal',
  headers: { authorization: 'Bearer ' + process.env.HOST_SERVICE_TOKEN },
}, response => {
  response.pipe(process.stdout);
  response.on('end', () => { process.exitCode = response.statusCode === 200 ? 0 : 1; });
});
request.setTimeout(2000, () => request.destroy(new Error('host service timed out')));
request.on('error', error => { console.error(error.code || error.message); process.exitCode = 1; });
`;

export class HostServiceObject extends DurableObject {
  async probe(input) {
    process.env.CELLD_CONTAINER_HOST_SERVICES = String(input.requestedPort);
    if (!this.ctx.container.running) {
      this.ctx.container.start({
        enableInternet: input.internet,
        entrypoint: ['node', '-e', 'setTimeout(() => {}, 300000)'],
        env: {
          HOST_SERVICE_CA: this.env.TEST_CA,
          HOST_SERVICE_TOKEN: this.env.TEST_TOKEN,
          CELLD_CONTAINER_HOST_SERVICES: String(input.requestedPort),
        },
        labels: { 'host-service.test': this.env.TEST_ID },
        hostServices: [input.requestedPort],
      });
    }
    const deadline = Date.now() + 10000;
    while (!(await this.ctx.container.inspect())?.image) {
      if (Date.now() >= deadline) throw new Error('fixture container did not start');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const execution = await this.ctx.container.exec(['node', '-e', request, input.url]);
    const output = await execution.output();
    return {
      exitCode: output.exitCode,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/health') return new Response(env.TEST_MODE);
    const input = await request.json();
    const stub = env.INSTANCES.get(env.INSTANCES.idFromName(input.internet ? 'open' : 'internal'));
    return Response.json(await stub.probe(input));
  },
};
