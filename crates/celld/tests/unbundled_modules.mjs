// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const binary = resolve(repository, process.argv[2] || "target/debug/celld");
await access(binary, constants.X_OK);
const directory = await mkdtemp(join(tmpdir(), "celld-unbundled-modules-"));
const source = await readFile(new URL("fixtures/unbundled_worker.js", import.meta.url));
const entry = await readFile(new URL("fixtures/unbundled_entry.mjs", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const configuration = {
  name: "unbundled-modules-regression",
  main: "src/entry.mjs",
  compatibility_date: "2026-10-01",
  compatibility_flags: ["nodejs_compat"],
  no_bundle: true,
  find_additional_modules: true,
  base_dir: ".",
  rules: [
    { type: "ESModule", globs: ["candidate/worker.js"], fallthrough: true },
    { type: "ESModule", globs: ["candidate/**/*.js"] },
    { type: "CompiledWasm", globs: ["candidate/**/*.wasm"] },
  ],
  durable_objects: { bindings: [{ name: "OBJECTS", class_name: "PreservedObject" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["PreservedObject"] }],
};
let sequence = 0;

async function project(config) {
  const path = join(directory, String(++sequence));
  await mkdir(join(path, "src"), { recursive: true });
  await mkdir(join(path, "candidate/lib"), { recursive: true });
  await mkdir(join(path, "candidate/wasm"), { recursive: true });
  await writeFile(join(path, "src/entry.mjs"), entry);
  await writeFile(join(path, "candidate/worker.js"), source);
  await writeFile(join(path, "candidate/lib/value.js"), "export const value = 'nested-module';\n");
  await writeFile(join(path, "candidate/unused.js"), "export default 'lazy-module';\n");
  // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
  await writeFile(join(path, "candidate/wasm/add.wasm"), Buffer.from("0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b", "hex"));
  await writeFile(join(path, "unselected.js"), "throw new Error('not in the configured inventory');\n");
  await writeFile(join(path, "wrangler.jsonc"), JSON.stringify(config));
  return path;
}

async function run(path, check) {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(binary, ["dev", path, "--port", String(port), "--no-watch", "--logs"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  let exited = false;
  const closed = new Promise((resolve) => child.once("close", (code) => { exited = true; resolve(code); }));
  child.once("error", (error) => logs.push(String(error)));
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  try {
    await check({ origin: `http://127.0.0.1:${port}`, closed, logs, exited: () => exited });
  } catch (error) {
    console.error(logs.join(""));
    throw error;
  } finally {
    let timeout;
    if (!exited && child.pid) {
      const stop = (signal) => {
        try { process.kill(-child.pid, signal); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      };
      stop("SIGINT");
      timeout = setTimeout(() => { if (!exited) stop("SIGKILL"); }, 5000);
    }
    await closed;
    clearTimeout(timeout);
  }
}

async function ready({ origin, exited, logs }) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !exited()) {
    try {
      if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`unbundled Worker became ready\n${logs.join("")}`);
}

async function rejects(config, pattern, prepare = async () => {}) {
  const path = await project(config);
  await prepare(path);
  await run(path, async ({ closed, logs }) => {
    let timeout;
    try {
      const code = await Promise.race([closed, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("invalid inventory was not rejected")), 15000);
      })]);
      assert.notEqual(code, 0);
      assert.match(logs.join(""), pattern);
    } finally { clearTimeout(timeout); }
  });
}

try {
  const path = await project(configuration);
  await run(path, async (state) => {
    await ready(state);
    const request = (suffix) => fetch(`${state.origin}${suffix}`, { signal: AbortSignal.timeout(10000) });
    for (const calls of [1, 2]) {
      const response = await request("/");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { calls, sum: 5, value: "nested-module", wrapper: true });
    }
    assert.equal(await (await request("/lazy")).text(), "lazy-module");
    const loaded = Buffer.from(await (await request("/bytes")).arrayBuffer());
    assert.deepEqual(loaded, source, "the ordinary isolate retains the exact candidate module bytes");
    assert.equal(digest(loaded), digest(source));
    assert.deepEqual(Buffer.from(await (await request("/wasm")).arrayBuffer()), await readFile(join(path, "candidate/wasm/add.wasm")));
    assert.equal(await (await request("/unselected")).json(), false);
    assert.deepEqual(Buffer.from(await (await request("/entry")).arrayBuffer()), entry);
    assert.deepEqual(await readFile(join(path, "candidate/worker.js")), source);
  });

  const implicitBase = { ...configuration, main: "entry.mjs" };
  delete implicitBase.base_dir;
  const defaultPath = await project(implicitBase);
  await writeFile(join(defaultPath, "entry.mjs"), entry.toString().replaceAll("../candidate/", "./candidate/"));
  await run(defaultPath, async (state) => {
    await ready(state);
    const response = await fetch(state.origin, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { calls: 1, sum: 5, value: "nested-module", wrapper: true });
  });

  const legacy = { name: "legacy-prebuilt-wasm", main: "src/entry.mjs", no_bundle: true };
  const legacyPath = await project(legacy);
  // Legacy discovery is below the entry directory, independent of opt-in rules.
  await mkdir(join(legacyPath, "src/lib"));
  await writeFile(join(legacyPath, "src/lib/add.wasm"), await readFile(join(legacyPath, "candidate/wasm/add.wasm")));
  await writeFile(join(legacyPath, "src/entry.mjs"), `import m from './lib/add.wasm';
export default {fetch() {return new Response(String(new WebAssembly.Instance(m).exports.add(2, 3)));}};\n`);
  await run(legacyPath, async (state) => {
    await ready(state);
    assert.equal(await (await fetch(state.origin, { signal: AbortSignal.timeout(10000) })).text(), "5");
  });

  await rejects({ ...configuration, base_dir: "../" }, /inside the project/);
  await rejects({ ...configuration, base_dir: "candidate" }, /main.*inside.*base_dir/);
  await rejects({ ...configuration, base_dir: "missing" }, /resolve module.*base_dir/);
  await rejects({ ...configuration, base_dir: "outside" }, /inside the project/, async (path) => {
    await symlink(directory, join(path, "outside"), "dir");
  });
  await rejects({ ...configuration, find_additional_modules: "true" }, /must be a boolean/);
  await rejects({ ...configuration, no_bundle: false }, /requires.*no_bundle/);
  await rejects({ ...configuration, define: { VALUE: "1" } }, /no_bundle.*define/);
  await rejects({ ...configuration, rules: [{ type: "CommonJS", globs: ["**/*.js"] }] }, /unsupported unbundled module type/);
  await rejects({ ...configuration, rules: [{ type: "ESModule", globs: ["../*.js"] }] }, /must stay inside/);
  await rejects({ ...configuration, main: "node:fs" }, /invalid deployment module name/, async (path) => {
    await writeFile(join(path, "node:fs"), entry);
  });
  await rejects({ ...configuration, main: "bad\\entry.mjs" }, /invalid deployment module name/, async (path) => {
    await writeFile(join(path, "bad\\entry.mjs"), entry);
  });
  await rejects({ ...configuration, rules: [
    { type: "ESModule", globs: ["candidate/**/*.js"] },
    { type: "CompiledWasm", globs: ["candidate/**/*.js"] },
  ] }, /conflicting module types/);
  await rejects(configuration, /not a regular file/, async (path) => {
    await rm(join(path, "candidate/unused.js"));
    await symlink(join(path, "unselected.js"), join(path, "candidate/unused.js"));
  });
  await rejects(configuration, /worker\.js|unresolved/, async (path) => {
    await rm(join(path, "candidate/worker.js"));
  });
  console.log(`ordinary unbundled ESM/Wasm, inherited Durable Object, exact SHA-256 ${digest(source)}, and unsafe inventories verified`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
