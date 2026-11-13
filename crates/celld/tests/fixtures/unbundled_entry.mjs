// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import worker, { CandidateObject } from "../candidate/worker.js";
export { AuxiliaryEntrypoint } from "../candidate/worker.js";

export class PreservedObject extends CandidateObject {
  async inspect() {
    return { ...await super.inspect(), wrapper: true };
  }
}

export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, env, ctx);
  },
};
