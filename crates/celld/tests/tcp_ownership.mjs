// Copyright 2026 Deno Land Inc. Apache-2.0 license.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const binary = resolve(repository, process.argv[2] || "target/debug/celld");
const directory = await mkdtemp(join(tmpdir(), "celld-tcp-ownership-"));
const held = new Set();
const peers = new Set();
const servers = [];
const listen = async (server) => {
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
};
const echo = (socket) => socket.on("data", (bytes) => socket.write(bytes));
const track = (server) => server.on("connection", (socket) => {
  peers.add(socket);
  socket.once("close", () => peers.delete(socket));
});
let child;
let closed;
let exited = false;
const logs = [];
const tlsErrors = [];
let phase = "setup";
let opensslVersion;
try {
  opensslVersion = execFileSync("openssl", ["version"], { encoding: "utf8" }).trim();
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth"], { stdio: "ignore" });
  const barrierPort = await listen(createHttpServer((_request, response) => {
    held.add(response);
    response.once("close", () => held.delete(response));
  }));
  const tcpPort = await listen(track(createTcpServer(echo)));
  const tls = track(createTlsServer({ key: await readFile(key), cert: await readFile(certificate) }, echo));
  tls.on("tlsClientError", (error) => tlsErrors.push({ code: error.code, message: error.message }));
  const tlsPort = await listen(tls);
  const reservation = createHttpServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  await copyFile(new URL("fixtures/tcp_ownership.js", import.meta.url), join(directory, "index.js"));
  await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify({
    name: "tcp-owner-regression",
    main: "index.js",
    compatibility_date: "2026-10-01",
    durable_objects: { bindings: [{ name: "OWNERS", class_name: "SocketOwner" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["SocketOwner"] }],
    vars: { BARRIER_ORIGIN: `http://127.0.0.1:${barrierPort}`, TCP_PORT: String(tcpPort), TLS_PORT: String(tlsPort) },
  }));
  child = spawn(binary, ["dev", directory, "--port", String(port), "--no-watch", "--logs"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CELLD_EXTRA_CA_CERTS: certificate },
  });
  closed = new Promise((resolve) => child.once("close", () => { exited = true; resolve(); }));
  child.once("error", (error) => { exited = true; logs.push(String(error)); });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  let ready = false;
  while (!ready && Date.now() < deadline && !exited) {
    try { ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, `celld became ready\n${logs.join("")}`);
  for (const mode of ["connect", "starttls"]) {
    phase = mode;
    const response = await fetch(`${origin}/${mode}`, { signal: AbortSignal.timeout(10000) });
    const body = await response.text();
    assert.equal(response.status, 200, `${mode}: ${body}\n${logs.join("")}`);
    assert.deepEqual(JSON.parse(body), { echo: "owned-echo" });
  }
  console.log("TCP connect and startTLS retain their originating event across foreign turns");
} catch (error) {
  throw new Error(`${phase}: ${error}\n${opensslVersion}\nTLS errors: ${JSON.stringify(tlsErrors)}\n${logs.join("")}`, { cause: error });
} finally {
  for (const response of held) response.end("released");
  let timer;
  if (child?.pid && !exited) {
    const stop = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    stop("SIGINT");
    timer = setTimeout(() => { if (!exited) stop("SIGKILL"); }, 5000);
  }
  if (closed) await closed;
  clearTimeout(timer);
  for (const socket of peers) socket.destroy();
  for (const server of servers) {
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  await rm(directory, { recursive: true, force: true });
}
