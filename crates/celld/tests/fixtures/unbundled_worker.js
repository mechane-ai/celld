// Copyright 2026 Deno Land Inc. Apache-2.0 license.

// This module is copied and deployed unchanged, including this comment.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { existsSync, readFileSync } from "node:fs";
import add from "./wasm/add.wasm";
import { value } from "./lib/value.js";

const wasm = new WebAssembly.Instance(add);

export class CandidateObject extends DurableObject {
  async inspect() {
    const calls = (await this.ctx.storage.get("calls") || 0) + 1;
    await this.ctx.storage.put("calls", calls);
    return { calls, sum: wasm.exports.add(2, 3), value };
  }
}

export class AuxiliaryEntrypoint extends WorkerEntrypoint {}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ready");
    if (path === "/bytes") return new Response(readFileSync("/bundle/candidate/worker.js"));
    if (path === "/wasm") return new Response(readFileSync("/bundle/candidate/wasm/add.wasm"));
    if (path === "/unselected") return Response.json(existsSync("/bundle/unselected.js"));
    if (path === "/entry") return new Response(readFileSync("/bundle/src/entry.mjs"));
    if (path === "/lazy") {
      const name = "unused";
      const module = await import(`./${name}.js`);
      return new Response(module.default);
    }
    return Response.json(await env.OBJECTS.getByName("same-object").inspect());
  },
};
