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

let evaluations = 0;

/**
 * Answers what evaluateJS() sends, in the shapes Zotero uses (actor names
 * shortened): getRoot, listProcesses, getTarget, and evaluateJSAsync answered
 * twice, an acknowledgment then an evaluationResult. The result is the code.
 */
function zoteroLike(conn: Conn, msg: Packet): void {
  if (msg.type === "getRoot") {
    conn.send(INTRO);
  } else if (msg.type === "listProcesses") {
    conn.send({ from: "root", processes: [{ actor: "process1", isParent: true }] });
  } else if (msg.type === "getTarget") {
    conn.send({ from: msg.to, process: { actor: "target1", consoleActor: "console1" } });
  } else if (msg.type === "evaluateJSAsync") {
    const resultID = `e${++evaluations}`;
    conn.send({ from: msg.to, resultID });
    conn.send({ from: msg.to, type: "evaluationResult", resultID, result: msg.text });
  }
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

describe("a packet from an actor with no request pending", () => {
  it("is emitted as an event, not taken as the reply to a request sent to another actor", async () => {
    // A notification of a type missing from EVENT_TYPES used to fall back to
    // the oldest pending request. Arriving while listProcesses waited, it
    // resolved listProcesses with no `processes`, so no parent process was
    // found and the console-actor lookup could end in "Could not find Zotero
    // console actor".
    const notification = { from: "server1.conn0.watcher2", type: "someUnlistedNotification", items: [] };
    const server = await rdpServer((conn, msg) => {
      if (msg.type === "listProcesses") {
        conn.send(notification);
        conn.send({ from: "root", processes: [{ actor: "process1", isParent: true }] });
      }
    });
    const client = clientFor(server.port);
    await client.connect();
    const events: Packet[] = [];
    client.on("message", (m: Packet) => events.push(m));

    const reply = await client.sendMessage({ to: "root", type: "listProcesses" });
    expect(reply.processes).toEqual([{ actor: "process1", isParent: true }]);
    expect(events).toEqual([notification]);
  });

  it("does not take the root actor's own notification as the reply to a request to root", async () => {
    // The root actor sends processListChanged, tabListChanged, ... `from`
    // root, so matching by actor alone gives one to a pending listProcesses.
    const server = await rdpServer((conn, msg) => {
      if (msg.type === "listProcesses") {
        conn.send({ from: "root", type: "processListChanged" });
        conn.send({ from: "root", processes: [{ actor: "process1", isParent: true }] });
      }
    });
    const client = clientFor(server.port);
    await client.connect();
    const reply = await client.sendMessage({ to: "root", type: "listProcesses" });
    expect(reply.processes).toEqual([{ actor: "process1", isParent: true }]);
  });
});

describe("overlapping reconnects (#35 item 2)", () => {
  it("share one attempt instead of tearing down each other's", async () => {
    // Every connection after the first waits 300 ms for its intro (a busy
    // Zotero). Two evaluations find the connection down 150 ms apart, so the
    // second arrives after reconnect()'s 100 ms pause, while the first one's
    // attempt is still waiting for the intro. Before the fix the second
    // reconnect() began with disconnect(), which destroyed that attempt: the
    // first evaluation failed with "closed before Zotero answered" while
    // Zotero was up.
    const server = await rdpServer(zoteroLike, { introDelayMs: (i) => (i === 0 ? 0 : 300) });
    const client = clientFor(server.port);
    await client.connect();
    client.disconnect();

    const first = client.evaluateJS("first");
    await delay(150);
    const second = client.evaluateJS("second");
    const [a, b] = await Promise.all([first, second]);
    expect(a.result).toBe("first");
    expect(b.result).toBe("second");
    expect(server.conns).toHaveLength(2); // the first connection and one reconnect
  });
});

describe("events from a socket that has been replaced (#35 item 3)", () => {
  /**
   * The state the issue describes: isConnected() finds the socket no longer
   * writable and counts the connection as down without destroying it, and
   * the next connect() opens a new socket while the old one is still open.
   * end() on the client's socket stands in for whatever stopped it being
   * writable. The server keeps its side open (allowHalfOpen), so the old
   * socket can still deliver data, and closes only when the test says so.
   * listProcesses is held until release() and names the connection it came
   * in on.
   */
  async function withReplacedSocket() {
    const zotero = mainThread();
    const server = await rdpServer(
      (conn, msg) => {
        if (msg.type !== "listProcesses") return;
        zotero.reply(() => conn.send({ from: "root", processes: [{ actor: `process-on-conn${conn.index}`, isParent: true }] }));
      },
      { allowHalfOpen: true }
    );
    const client = clientFor(server.port);
    await client.connect();
    (client as unknown as { socket: net.Socket }).socket.end();
    // What getRdpClient() does for every tool call:
    if (!client.isConnected()) await client.connect();
    expect(server.conns).toHaveLength(2);
    return { client, old: server.conns[0], zotero };
  }

  it("does not let the old socket's close fail the new connection's requests or drop it", async () => {
    const { client, old, zotero } = await withReplacedSocket();
    const reply = client.sendMessage({ to: "root", type: "listProcesses" });
    reply.catch(() => { /* asserted below; avoids an unhandled rejection while waiting */ });
    old.sock.end(); // the old socket closes now, while the request waits on the new one
    await delay(50);
    zotero.release();
    expect((await reply).processes).toEqual([{ actor: "process-on-conn1", isParent: true }]);
    expect(client.isConnected()).toBe(true);
  });

  it("does not take a late packet on the old socket as a reply on the new connection", async () => {
    const { client, old, zotero } = await withReplacedSocket();
    const reply = client.sendMessage({ to: "root", type: "listProcesses" });
    reply.catch(() => { /* asserted below; avoids an unhandled rejection while waiting */ });
    old.send({ from: "root", processes: [{ actor: "stale", isParent: true }] });
    await delay(50);
    zotero.release();
    expect((await reply).processes).toEqual([{ actor: "process-on-conn1", isParent: true }]);
  });
});
