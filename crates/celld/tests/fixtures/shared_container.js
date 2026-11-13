// Copyright 2026 Deno Land Inc. Apache-2.0 license.
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

export class Account extends WorkerEntrypoint {
  async fetch(request) {
    const bytes = await request.arrayBuffer();
    return Response.json({
      owner: this.ctx.props.owner,
      key: this.ctx.props.key,
      bytes: bytes.byteLength,
      leakedTransport: request.headers.has('x-celld-egress-key'),
    });
  }
}

export class Machine extends DurableObject {
  async run(owner, command) {
    this.ctx.container.interceptOutboundHttp('softmax.internal', this.ctx.exports.Account({
      props: { owner, key: this.ctx.id.toString() },
    }));
    if (!this.ctx.container.running) this.ctx.container.start({
      enableInternet: true,
      entrypoint: ['sh', '-c', 'while :; do sleep 3600; done'],
      labels: { 'shared.test': this.env.TEST_ID },
    });
    // exec must await startup; a caller does not need a readiness loop.
    const process = await this.ctx.container.exec(['sh', '-c', command]);
    const result = await process.output();
    return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
  }
  stop() { return this.ctx.container.destroy(); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ready');
    const owner = url.searchParams.get('owner');
    const machine = env.MACHINES.getByName(owner);
    if (url.pathname === '/stop') {
      await machine.stop();
      return Response.json({ stopped: true });
    }
    using result = await machine.run(owner, url.searchParams.get('command'));
    const descriptor = Object.getOwnPropertyDescriptor(result, Symbol.dispose);
    return Response.json({
      ...result,
      disposal: { present: typeof descriptor?.value === 'function', enumerable: descriptor?.enumerable, writable: descriptor?.writable, configurable: descriptor?.configurable },
    });
  },
};
