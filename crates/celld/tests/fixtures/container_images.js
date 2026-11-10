// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import { DurableObject } from "cloudflare:workers";

export class ImageObject extends DurableObject {}

export default {
  fetch() { return new Response("ready"); },
};
