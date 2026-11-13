# WebAssembly

A Worker bundle can import a `.wasm` file. As in Wrangler, the import gives
the compiled module, not the bytes.

```js
import addModule from "./add.wasm";

const { exports } = new WebAssembly.Instance(addModule);

export default {
  fetch() {
    return new Response(String(exports.add(2, 3)));
  },
};
```

`celld deploy` uploads each imported wasm file beside the bundle and marks the
deployment with the `wasm-v1` feature. A node that predates this feature
refuses the deployment, so a mixed fleet fails at deploy time, not at request
time.

celld compiles each wasm module once per process, so later isolates and cell
activations reuse it.

## Example

The [WebAssembly example](../examples/wasm) compiles a Rust Durable Object and
imports its WebAssembly module.

<!-- celld-example: wasm -->

## Prebuilt Workers

With `no_bundle: true`, celld preserves the entry JavaScript byte for byte. It
applies Wrangler's default `**/*.wasm` and `**/*.wasm?module` patterns below
the directory that contains `main`. For example, `main: "./dist/shim.mjs"` can
import `"./add.wasm"` or `"./lib/add.wasm"` from `dist`. The module names keep
these relative paths. This mode does not require esbuild.

The scan uploads WASM files that the JavaScript does not import, so use a
dedicated build output directory. It skips `.git`, `.celld`, `.wrangler`, and
symbolic links to directories. It refuses a symbolic link whose name matches a
WASM pattern, so copy the file into the build output instead.

To deploy a prebuilt JavaScript module graph without processing it again, opt
into [Wrangler's additional module settings](https://developers.cloudflare.com/workers/wrangler/bundling/#find-additional-modules):

```jsonc
{
  "name": "prebuilt-app",
  "main": "./entry.mjs",
  "no_bundle": true,
  "find_additional_modules": true,
  "base_dir": ".",
  "rules": [
    { "type": "ESModule", "globs": ["candidate/**/*.js"] },
    { "type": "CompiledWasm", "globs": ["candidate/**/*.wasm"] }
  ]
}
```

The entry can import `./candidate/worker.js`, including its named Durable
Object exports. Every selected file reaches the same ordinary Worker module
registry with its original bytes and its path relative to `base_dir`.
Module types participate in deployment identity. A node without `es-modules-v1`
refuses this deployment.

`base_dir` defaults to the entry's directory. It must remain inside the project,
and the entry must be inside it. celld does not follow directory symlinks and
refuses selected symlinks, unsafe names, conflicting module types, invalid UTF-8
JavaScript, and unsupported rule types. A rule's `fallthrough: true` permits
another rule of that type; otherwise a later rule of that type is refused.
The default Wasm patterns apply unless a `CompiledWasm` rule replaces them.

For compatibility with existing celld prebuilt deployments, JavaScript discovery
requires explicit `find_additional_modules: true`, rather than Wrangler's
implicit default for `no_bundle`. Only `ESModule` and `CompiledWasm` discovery
are currently supported, and this mode requires `no_bundle: true`; it does not
partially bundle or transform selected files. Without the opt-in, the existing
entry-and-Wasm behavior above is unchanged.

## Rust with workers-rs

[workers-rs](https://github.com/cloudflare/workers-rs) builds a JavaScript shim
and a wasm file, and the shim is a normal entry point for `celld deploy`.

1. Install the build tool: `cargo install worker-build`.
2. Build the crate: `worker-build --release`.
3. Point the config at the shim:

```jsonc
{
  "name": "my-app",
  "main": "./build/worker/shim.mjs",
  "compatibility_date": "2026-01-01",
}
```

4. Deploy: `celld deploy`.

celld resolves entrypoint and Durable Object classes through the shim's Proxy
wrapper. A workers-rs API that needs a runtime feature missing from
[Cloudflare compatibility](cloudflare-compat.md) does not work.

## Dynamic Workers

Pass wasm to a dynamically loaded worker as `{ wasm: bytes }` in the `modules`
map, and the worker imports a compiled module. celld refuses bare bytes, as
workerd does.

```js
const worker = env.loader.load({
  compatibilityDate: "2025-01-01",
  mainModule: "main.js",
  modules: {
    "main.js": `import m from "./add.wasm"; ...`,
    "add.wasm": { wasm: wasmBytes },
  },
});
```

## Limits

Wasm bytes count against the deployment size limits like JavaScript modules. A
module that does not compile fails the importing module with a
`WebAssembly.CompileError` that names the file.
