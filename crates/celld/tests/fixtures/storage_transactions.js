// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import { DurableObject } from "cloudflare:workers";

export class TransactionGate extends DurableObject {
  async arm() {
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.getAlarm();
      const deadline = Number(this.env.ALARM_TIME);
      if (current === null || current > deadline) {
        await transaction.setAlarm(deadline);
      }
    });
  }

  async work() {
    await fetch(this.env.BARRIER_ORIGIN);
    await this.arm();
    await this.arm();
    return true;
  }

  async alarmTime() {
    return this.ctx.storage.getAlarm();
  }

  startBackground() {
    this.backgroundReady = Promise.withResolvers();
    this.backgroundController = new AbortController();
    // A successful Durable Object event retains its pending I/O without waitUntil.
    this.backgroundFetch = fetch(`${this.env.BARRIER_ORIGIN}/background`, {
      signal: this.backgroundController.signal,
    }).catch(() => {});
    this.backgroundWork = (async () => {
      await this.backgroundReady.promise;
      await this.arm();
    })();
    return true;
  }

  async finishBackground() {
    this.backgroundReady.resolve();
    try {
      await this.backgroundWork;
      return this.ctx.storage.getAlarm();
    } finally {
      this.backgroundController.abort();
      await this.backgroundFetch;
    }
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ready");
    if (path === "/background") {
      const stub = env.GATES.get(env.GATES.idFromName("background-transactions"));
      await stub.startBackground();
      return Response.json({ alarm: await stub.finishBackground() });
    }
    const stub = env.GATES.get(env.GATES.idFromName("concurrent-transactions"));
    const completed = await Promise.all([stub.work(), stub.work()]);
    return Response.json({ completed, alarm: await stub.alarmTime() });
  },
};
