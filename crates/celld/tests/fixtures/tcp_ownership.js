// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

export class SocketOwner extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.beginConnect = Promise.withResolvers();
    this.prepared = Promise.withResolvers();
    this.connected = Promise.withResolvers();
    this.beginWrite = Promise.withResolvers();
  }

  async work(upgrade) {
    this.ctx.waitUntil(fetch(`${this.env.BARRIER_ORIGIN}/hold`));
    let socket;
    if (upgrade) {
      socket = connect({ hostname: "127.0.0.1", port: Number(this.env.TLS_PORT) }, { secureTransport: "starttls" });
      await socket.opened;
    }
    this.prepared.resolve();
    await this.beginConnect.promise;
    socket = socket ? socket.startTls() : connect({ hostname: "127.0.0.1", port: Number(this.env.TCP_PORT) });
    try {
      await socket.opened;
      this.connected.resolve();
      await this.beginWrite.promise;
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode("owned-echo"));
      const reader = socket.readable.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      writer.releaseLock();
      return new TextDecoder().decode(value);
    } finally {
      await socket.close();
    }
  }

  async ready() {
    await this.prepared.promise;
    return true;
  }

  async open() {
    this.beginConnect.resolve();
    await this.connected.promise;
    return true;
  }

  write() {
    this.beginWrite.resolve();
    return true;
  }
}

export default {
  async fetch(request, env) {
    const mode = new URL(request.url).pathname.slice(1);
    if (mode === "health") return new Response("ready");
    const owner = env.OWNERS.get(env.OWNERS.idFromName(mode));
    const result = owner.work(mode === "starttls");
    await owner.ready();
    await owner.open();
    await owner.write();
    return Response.json({ echo: await result });
  },
};
