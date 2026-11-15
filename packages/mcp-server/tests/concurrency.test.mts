/**
 * Regression tests: tool calls that arrive together before the first
 * connection is up.
 *
 * MCP clients (Claude Code among them) often send several tool calls in
 * parallel as the first thing they do. Each call goes through getRdpClient(),
 * which calls connect() while isConnected() is still false, so every caller
 * opened its own socket on the same RDPClient and raced the intro packet and
 * the console-actor lookup. All of them then failed with "Could not find
 * Zotero console actor", while a single first call succeeded.
 *
 * The race lives in the real socket handshake and actor discovery, so these
 * run against a live Zotero (a mock would hide it) and skip when no Zotero
 * with the bridge answers on ZOTERO_RDP_PORT (default 6100).
 *
 * The handshake cases at the end use a scripted RDP server instead. What they
 * check is RDPClient's own connection state (when it counts as connected,
 * what a failed attempt leaves behind), and only a fake server can hold the
 * intro packet back for a fixed time or drop the socket before sending it.
 */
import net from "node:net";
import { describe, expect, it } from "vitest";
import { createClient, type RDPClient } from "../src/rdp/index.js";
import type { GripValue } from "../src/rdp/index.js";

const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");
const CALLS = 4;
// The interleaving is timing-dependent, so each live case repeats.
const ROUNDS = 10;

/** Readiness: the port must answer AND `Zotero` must resolve in the target. */
async function zoteroReady(): Promise<string> {
  const client = createClient({ port: RDP_PORT });
  try {
    await client.connect();
    const r = await client.evaluateJS("typeof Zotero");
    const t = r.exception ? "exception" : await client.gripToValueAsync(r.result as GripValue);
    return t === "function" || t === "object" ? "" : `typeof Zotero is ${String(t)} on port ${RDP_PORT}`;
  } catch (e) {
    return `no bridge on port ${RDP_PORT}: ${(e as Error).message}`;
  } finally {
    try { client.disconnect(); } catch { /* not connected */ }
  }
}

const notReady = await zoteroReady();
if (notReady) {
  console.warn(`[concurrency.test] skipping - ${notReady}`);
}

/**
 * What getRdpClient() does for every tool call, then an eval that needs the
 * Zotero global: a call routed to a context without it reports an exception.
 */
async function callLikeATool(client: RDPClient, n: number): Promise<unknown> {
  if (!client.isConnected()) {
    await client.connect();
  }
  const r = await client.evaluateJS(`typeof Zotero.Libraries === "object" ? ${n} + 1 : "no Zotero"`);
  expect(r.exceptionMessage ?? r.exception).toBeFalsy();
  return client.gripToValueAsync(r.result as GripValue);
}

async function parallelRound(connectFirst: boolean): Promise<void> {
  const client = createClient({ port: RDP_PORT });
  try {
    if (connectFirst) await client.connect();
    const results = await Promise.all(
      Array.from({ length: CALLS }, (_, i) => callLikeATool(client, i))
    );
    expect(results).toEqual(Array.from({ length: CALLS }, (_, i) => i + 1));
  } finally {
    client.disconnect();
  }
}

describe.skipIf(Boolean(notReady))("parallel first calls (live Zotero)", () => {
  it("serves every call when they all arrive before the first connection", async () => {
    for (let round = 0; round < ROUNDS; round++) await parallelRound(false);
  });

  it("serves every call when they arrive after connect but before the console actor is known", async () => {
    for (let round = 0; round < ROUNDS; round++) await parallelRound(true);
  });
});

/** A loopback port with nothing listening on it (yet). */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function sendPacket(sock: net.Socket, message: object): void {
  if (sock.destroyed) return;
  const json = JSON.stringify(message);
  sock.write(`${Buffer.byteLength(json)}:${json}`);
}

const PROCESSES = [{ actor: "process1", isParent: true }];

/**
 * Minimal RDP server for the handshake. Like Firefox's DevTools server, it
 * sends the intro packet before serving any request; `introDelayMs` stands in
 * for a busy Zotero main thread. It answers listProcesses and nothing else.
 */
async function fakeRdpServer(port = 0, introDelayMs = 0): Promise<net.Server> {
  const server = net.createServer((sock) => {
    sock.on("error", () => { /* the client may drop the socket at any time */ });
    let introSent = false;
    const held: Array<() => void> = [];
    setTimeout(() => {
      sendPacket(sock, { from: "root", applicationType: "browser", traits: {} });
      introSent = true;
      held.splice(0).forEach((reply) => reply());
    }, introDelayMs);
    let buf = "";
    sock.on("data", (data) => {
      buf += data.toString();
      let m: RegExpMatchArray | null;
      while ((m = buf.match(/^(\d+):/)) && buf.length >= m[0].length + Number(m[1])) {
        const msg = JSON.parse(buf.slice(m[0].length, m[0].length + Number(m[1])));
        buf = buf.slice(m[0].length + Number(m[1]));
        if (msg.type !== "listProcesses") continue;
        const reply = () => sendPacket(sock, { from: "root", processes: PROCESSES });
        if (introSent) reply();
        else held.push(reply);
      }
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return server;
}

function clientFor(port: number): RDPClient {
  const client = createClient({ host: "127.0.0.1", port, timeout: 2000 });
  client.setKeepaliveEnabled(false);
  return client;
}

describe("connect() handshake (fake RDP server, no Zotero needed)", () => {
  it("rejects every concurrent caller, then starts a fresh attempt", async () => {
    const port = await freePort();
    const client = clientFor(port);
    const attempts = await Promise.allSettled([client.connect(), client.connect(), client.connect()]);
    expect(attempts.every((a) => a.status === "rejected")).toBe(true);
    // Something answers now. A connect() that kept handing back the failed
    // shared attempt would still reject here, and the server could never
    // connect again until it was restarted.
    const server = await fakeRdpServer(port);
    try {
      await expect(client.connect()).resolves.toBeUndefined();
    } finally {
      client.disconnect();
      server.close();
    }
  });

  it("rejects, rather than hangs, when the socket closes before the intro", async () => {
    const server = net.createServer((sock) => sock.destroy());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const client = clientFor((server.address() as net.AddressInfo).port);
    try {
      await expect(client.connect()).rejects.toThrow(/closed before Zotero answered/);
    } finally {
      client.disconnect();
      server.close();
    }
  });

  it("does not count as connected until the intro arrives", async () => {
    // A tool call landing between the TCP connect and the intro used to see
    // isConnected() === true, skip the shared attempt and send to root. The
    // intro, which also comes from root, then answered that request, and the
    // first connect() never saw it and waited for the socket timeout.
    const server = await fakeRdpServer(0, 200);
    const client = clientFor((server.address() as net.AddressInfo).port);
    try {
      const first = client.connect();
      first.catch(() => { /* asserted below; avoids an unhandled rejection if this test fails early */ });
      await new Promise((r) => setTimeout(r, 50)); // TCP is up, the intro is not
      // What getRdpClient() does for a second tool call:
      if (!client.isConnected()) await client.connect();
      const reply = await client.sendMessage({ to: "root", type: "listProcesses" });
      expect(reply.processes).toEqual(PROCESSES);
      await expect(first).resolves.toBeUndefined();
    } finally {
      client.disconnect();
      server.close();
    }
  });
});

describe.skipIf(Boolean(notReady))("replies that complete out of order (live Zotero)", () => {
  it("gives each evaluation its own result when a slow one was sent first", async () => {
    const client = createClient({ port: RDP_PORT });
    try {
      await client.connect();
      // Warm up: find the console actor before the race we want to test.
      await client.evaluateJS("1");
      const slow = client.evaluateJS(
        `(async () => { await new Promise(r => setTimeout(r, 300)); return "slow"; })()`
      );
      const fast = client.evaluateJS(`"fast"`);
      const [s, f] = await Promise.all([slow, fast]);
      expect(await client.gripToValueAsync(s.result as GripValue)).toBe("slow");
      expect(await client.gripToValueAsync(f.result as GripValue)).toBe("fast");
    } finally {
      client.disconnect();
    }
  });
});
