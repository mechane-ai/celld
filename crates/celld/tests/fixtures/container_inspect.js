// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import { DurableObject } from "cloudflare:workers";

export class InspectObject extends DurableObject {
  inspect() { return this.ctx.container.inspect(); }

  begin(machine) {
    this.ctx.container.start({
      enableInternet: true,
      entrypoint: ["sh", "-c", "while :; do sleep 3600; done"],
      env: { INSPECT_PRIVATE_VALUE: "fixture-private-value" },
      labels: { "mechane.machine": machine, "inspect.test": this.env.TEST_ID },
    });
    return true;
  }

  async conflict(machine) {
    let refused = false;
    try { this.begin(machine); } catch { refused = true; }
    return { refused, info: await this.inspect() };
  }

  async stop() {
    await this.ctx.container.destroy();
    return this.inspect();
  }

  async fail() {
    this.ctx.container.start({
      enableInternet: true,
      entrypoint: ["/missing-container-inspect-fixture"],
      labels: { "inspect.test": this.env.TEST_ID },
    });
    let failed = false;
    try { await this.ctx.container.monitor(); } catch { failed = true; }
    return { failed, info: await this.inspect() };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ready");
    const stub = env.INSTANCES.get(env.INSTANCES.idFromName("inspect-regression"));
    try {
      switch (url.pathname) {
        case "/begin": return Response.json(await stub.begin(url.searchParams.get("machine")));
        case "/conflict": return Response.json(await stub.conflict(url.searchParams.get("machine")));
        case "/stop": return Response.json(await stub.stop());
        case "/fail": return Response.json(await stub.fail());
        default: return Response.json(await stub.inspect());
      }
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
