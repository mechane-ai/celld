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
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/health") return new Response("ready");
    const stub = env.GATES.get(env.GATES.idFromName("concurrent-transactions"));
    const completed = await Promise.all([stub.work(), stub.work()]);
    return Response.json({ completed, alarm: await stub.alarmTime() });
  },
};
