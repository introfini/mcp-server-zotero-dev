/**
 * RDPClient bookkeeping: which packet answers which request, and which socket
 * an event belongs to (#35).
 *
 * These run against a scripted RDP server, not a live Zotero. What they check
 * is the client's own state: the requests it is waiting on, the socket it
 * counts as current, the reconnect in flight. Only a scripted server can hold
 * a reply past its request's timeout, delay an intro by a fixed time, or keep
 * a replaced socket open long enough for its late events to arrive, and what
 * Zotero would evaluate plays no part in any of it.
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RDPClient } from "../src/rdp/index.js";

type Packet = Record<string, unknown>;

interface Conn {
  /** 0 for the first connection the server accepted, 1 for the next, ... */
  index: number;
  sock: net.Socket;
  send(packet: Packet): void;
}

interface ScriptedServer {
  port: number;
  conns: Conn[];
  close(): Promise<void>;
}

const INTRO: Packet = { from: "root", applicationType: "browser", traits: {} };

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let servers: ScriptedServer[] = [];
let clients: RDPClient[] = [];

afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients = [];
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

/**
 * A scripted RDP server. Like Firefox's DevTools server it sends the intro
 * packet on accept (after `introDelayMs(index)` for that connection), then
 * hands every request to `onRequest`.
 */
async function rdpServer(
  onRequest: (conn: Conn, msg: Packet) => void,
  opts: { introDelayMs?: (index: number) => number; allowHalfOpen?: boolean } = {}
): Promise<ScriptedServer> {
  const conns: Conn[] = [];
  const server = net.createServer({ allowHalfOpen: opts.allowHalfOpen ?? false }, (sock) => {
    sock.on("error", () => { /* the client may drop the socket at any time */ });
    const conn: Conn = {
      index: conns.length,
      sock,
      send(packet) {
        if (sock.destroyed || !sock.writable) return;
        const json = JSON.stringify(packet);
        sock.write(`${Buffer.byteLength(json)}:${json}`);
      },
    };
    conns.push(conn);
    setTimeout(() => conn.send(INTRO), opts.introDelayMs?.(conn.index) ?? 0);
    let buf = Buffer.alloc(0);
    sock.on("data", (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      for (;;) {
        const colon = buf.indexOf(0x3a);
        if (colon < 0) break;
        const len = Number(buf.subarray(0, colon).toString("ascii"));
        if (buf.length < colon + 1 + len) break;
        const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString("utf8")) as Packet;
        buf = buf.subarray(colon + 1 + len);
        onRequest(conn, msg);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const scripted: ScriptedServer = {
    port: (server.address() as net.AddressInfo).port,
    conns,
    close() {
      for (const c of conns) c.sock.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
  servers.push(scripted);
  return scripted;
}

/**
 * A busy Zotero main thread: replies wait until release(), in the order their
 * requests arrived; after release() they go out at once.
 */
function mainThread(): { reply(send: () => void): void; release(): void } {
  let held: Array<() => void> | null = [];
  return {
    reply(send) {
      if (held) held.push(send);
      else send();
    },
    release() {
      const queued = held ?? [];
      held = null;
      queued.forEach((send) => send());
    },
  };
}

function clientFor(port: number, timeout = 2000): RDPClient {
  const client = new RDPClient({ host: "127.0.0.1", port, timeout });
  client.setKeepaliveEnabled(false);
  clients.push(client);
  return client;
}

describe("a reply that arrives after its request timed out (#35 item 1)", () => {
  it("does not hand an evaluation's late acknowledgment and result to the next evaluation", async () => {
    // The repro from #35. A synchronous eval holds Zotero's main thread past
    // the request timeout: every reply waits until `release()`. Eval A times
    // out before its acknowledgment, eval B goes to the same console actor,
    // then the main thread frees up and A's acknowledgment and result arrive
    // first. Before the fix, A's acknowledgment gave B A's resultID and B
    // resolved with "A-result".
    const zotero = mainThread();
    const server = await rdpServer((conn, msg) => {
      if (msg.to === "root") {
        zotero.reply(() => conn.send(INTRO));
        return;
      }
      const resultID = `r${String(msg.text)}`;
      zotero.reply(() => {
        conn.send({ from: "console1", resultID });
        conn.send({ from: "console1", type: "evaluationResult", resultID, result: `${String(msg.text)}-result` });
      });
    });
    const client = clientFor(server.port, 500);
    await client.connect();

    const a = client.sendMessage({ to: "console1", type: "evaluateJSAsync", text: "A" });
    // Keepalive-style traffic (its reply is held too). It keeps the socket's
    // idle timer, which equals the request timeout, from closing the
    // connection before B is sent.
    await delay(250);
    const root = client.sendMessage({ to: "root", type: "getRoot" });
    await expect(a).rejects.toThrow(/Request timeout for evaluateJSAsync to console1/);

    const b = client.sendMessage({ to: "console1", type: "evaluateJSAsync", text: "B" });
    zotero.release();
    expect((await b).result).toBe("B-result");
    await expect(root).resolves.toMatchObject({ from: "root" });
  });

  it("does not hand a plain request's late reply to the next request to that actor", async () => {
    // The same for a request answered once: root answers its requests in
    // order, so the first reply that comes from root after a timeout is the
    // timed-out request's own.
    const zotero = mainThread();
    let listed = 0;
    const server = await rdpServer((conn, msg) => {
      if (msg.type === "listProcesses") {
        const reply = { from: "root", processes: [{ actor: `process${++listed}`, isParent: true }] };
        zotero.reply(() => conn.send(reply));
      } else if (msg.type === "evaluateJSAsync") {
        conn.send({ from: msg.to, resultID: "k" });
        conn.send({ from: msg.to, type: "evaluationResult", resultID: "k", result: "kept alive" });
      }
    });
    const client = clientFor(server.port, 300);
    await client.connect();

    const first = client.sendMessage({ to: "root", type: "listProcesses" });
    // Traffic on another actor keeps the socket's idle timer from firing.
    await delay(200);
    await client.sendMessage({ to: "console1", type: "evaluateJSAsync", text: "keepalive" });
    await expect(first).rejects.toThrow(/Request timeout for listProcesses to root/);

    const second = client.sendMessage({ to: "root", type: "listProcesses" });
    zotero.release();
    expect((await second).processes).toEqual([{ actor: "process2", isParent: true }]);
  });
});
