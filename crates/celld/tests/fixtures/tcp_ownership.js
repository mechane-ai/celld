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

  async upload() {
    this.ctx.waitUntil(fetch(`${this.env.BARRIER_ORIGIN}/hold`));
    const object = await this.env.FILES.get("owned");
    this.prepared.resolve();
    await fetch(`${this.env.BARRIER_ORIGIN}/r2-ready`);
    await this.beginConnect.promise;
    this.connected.resolve();
    await this.beginWrite.promise;
    const response = await fetch(`${this.env.BARRIER_ORIGIN}/upload`, {
      method: "POST",
      headers: { "content-length": String(object.size) },
      body: object.body,
    });
    return response.text();
  }

  async holdBody() {
    this.ctx.waitUntil(fetch(`${this.env.BARRIER_ORIGIN}/hold`));
    this.savedBody = (await this.env.FILES.get("owned")).body;
    return true;
  }

  async refuseForeignBody() {
    try {
      await fetch(`${this.env.BARRIER_ORIGIN}/upload`, {
        method: "POST",
        body: this.savedBody,
      });
      return false;
    } catch {
      return true;
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
    if (mode === "r2" || mode === "r2-foreign")
      await env.FILES.put("owned", "owned-echo");
    if (mode === "r2-foreign") {
      await owner.holdBody();
      return Response.json({ refused: await owner.refuseForeignBody() });
    }
    const result = mode === "r2" ? owner.upload() : owner.work(mode === "starttls");
    if (mode === "r2") await fetch(`${env.BARRIER_ORIGIN}/wait-r2-ready`);
    await Promise.race([owner.ready(), result]);
    await Promise.race([owner.open(), result]);
    await owner.write();
    return Response.json({ echo: await result });
  },
};
