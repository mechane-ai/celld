// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { constants } from "node:fs";
import { access, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const binary = resolve(repository, process.argv[2] || "target/debug/celld");
await access(binary, constants.X_OK);
const directory = await mkdtemp(join(tmpdir(), "celld-storage-transactions-"));
const pending = [];
const barrier = createServer((_request, response) => {
  pending.push(response);
  if (pending.length === 2) {
    for (const peer of pending.splice(0)) peer.end("released");
  }
});
let child;
let closed;
let exited = false;
const logs = [];
try {
  await new Promise((resolve, reject) => {
    barrier.once("error", reject);
    barrier.listen(0, "127.0.0.1", resolve);
  });
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const alarmTime = Date.now() + 3600000;
  await copyFile(new URL("fixtures/storage_transactions.js", import.meta.url), join(directory, "index.js"));
  await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify({
    name: "storage-transaction-regression",
    main: "index.js",
    compatibility_date: "2026-10-01",
    durable_objects: { bindings: [{ name: "GATES", class_name: "TransactionGate" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["TransactionGate"] }],
    vars: { BARRIER_ORIGIN: `http://127.0.0.1:${barrier.address().port}`, ALARM_TIME: String(alarmTime) },
  }));
  child = spawn(binary, ["dev", directory, "--port", String(port), "--no-watch", "--logs"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  closed = new Promise((resolve) => child.once("close", () => { exited = true; resolve(); }));
  child.once("error", (error) => { exited = true; logs.push(String(error)); });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  let ready = false;
  while (!ready && Date.now() < deadline && !exited) {
    try {
      ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, `celld became ready\n${logs.join("")}`);
  const response = await fetch(origin, { signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.deepEqual(JSON.parse(text), { completed: [true, true], alarm: alarmTime });
  assert.equal(pending.length, 0, "the fixture holds no response while transactions finish");
  console.log("concurrent storage transactions complete with the committed alarm");
} finally {
  let timeout;
  if (child?.pid && !exited) {
    const stop = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    stop("SIGINT");
    timeout = setTimeout(() => { if (!exited) stop("SIGKILL"); }, 5000);
  }
  if (closed) await closed;
  clearTimeout(timeout);
  for (const response of pending) response.destroy();
  barrier.closeAllConnections();
  await new Promise((resolve) => barrier.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
