/**
 * A minimal RDP server for client tests. It speaks the shapes the client
 * meets in Zotero (traced against Zotero 11.0-beta.3): the intro packet,
 * listProcesses -> getTarget -> a console actor, getRoot, and evaluateJSAsync
 * answered twice (an acknowledgment carrying a resultID, then an
 * evaluationResult). A mock is sufficient for what these tests cover: the
 * client's own bookkeeping of replies, timeouts and actors, which does not
 * depend on what Zotero evaluates.
 *
 * Evaluated "code" is a JSON command: {"value": ..., "delay": ms}.
 */
import { createServer, type Server, type Socket } from "node:net";

export interface FakeOptions {
  /** Packets sent unsolicited just before the next listProcesses reply. */
  beforeListProcesses?: Record<string, unknown>[];
  /** The next N getTarget requests are answered with an error. */
  failGetTarget?: number;
  /** Packets sent by the new target right after each getTarget reply. */
  afterGetTarget?: (target: string) => Record<string, unknown>[];
}

export class FakeRdp {
  private server: Server;
  private sockets: Socket[] = [];
  port = 0;
  /** How many targets the client asked for (one per getTarget). */
  getTargets = 0;
  /** Every request received, in order. */
  requests: Record<string, unknown>[] = [];
  private evalCounter = 0;

  constructor(public options: FakeOptions = {}) {
    this.server = createServer((s) => this.accept(s));
  }

  /** How many connections the client has opened. */
  get connections(): number {
    return this.sockets.length;
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const a = this.server.address();
        this.port = typeof a === "object" && a ? a.port : 0;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Send a packet to every connected client. */
  broadcast(packet: Record<string, unknown>): void {
    for (const s of this.sockets) this.send(s, packet);
  }

  private send(s: Socket, packet: Record<string, unknown>): void {
    const json = JSON.stringify(packet);
    if (!s.destroyed) s.write(`${Buffer.byteLength(json, "utf8")}:${json}`);
  }

  private accept(s: Socket): void {
    this.sockets.push(s);
    let buf = Buffer.alloc(0);
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const colon = buf.indexOf(0x3a);
        if (colon < 0) break;
        const len = parseInt(buf.subarray(0, colon).toString("ascii"), 10);
        if (buf.length < colon + 1 + len) break;
        const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString("utf8"));
        buf = buf.subarray(colon + 1 + len);
        this.handle(s, msg);
      }
    });
    s.on("error", () => { /* client went away */ });
    this.send(s, { from: "root", applicationType: "browser", traits: {} });
  }

  private handle(s: Socket, msg: Record<string, unknown>): void {
    this.requests.push(msg);
    const { to, type } = msg as { to: string; type: string };
    if (to === "root" && type === "getRoot") {
      this.send(s, { from: "root", applicationType: "browser", traits: {} });
    } else if (to === "root" && type === "listProcesses") {
      for (const p of this.options.beforeListProcesses ?? []) this.send(s, p);
      this.options.beforeListProcesses = [];
      this.send(s, { from: "root", processes: [{ actor: "processDescriptor1", isParent: true }] });
    } else if (to === "processDescriptor1" && type === "getTarget") {
      if ((this.options.failGetTarget ?? 0) > 0) {
        this.options.failGetTarget = (this.options.failGetTarget ?? 0) - 1;
        this.send(s, { from: to, error: "unknownError", message: "target not ready" });
        return;
      }
      this.getTargets++;
      const target = `parentProcessTarget${this.getTargets}`;
      const console = `consoleActor${this.getTargets}`;
      this.send(s, { from: to, process: { actor: target, consoleActor: console, title: "Zotero", url: "chrome://zotero/content/zoteroPane.xhtml", outerWindowID: 3 } });
      // A few ms later, as in Zotero: after the client has stored the actor.
      const after = this.options.afterGetTarget?.(target) ?? [];
      if (after.length) setTimeout(() => { for (const p of after) this.send(s, p); }, 5);
    } else if (type === "evaluateJSAsync") {
      const resultID = `r${++this.evalCounter}`;
      this.send(s, { from: to, resultID });
      let cmd: { value?: unknown; delay?: number } = {};
      try { cmd = JSON.parse(String(msg.text)); } catch { cmd = { value: String(msg.text) }; }
      setTimeout(() => {
        this.send(s, { from: to, type: "evaluationResult", resultID, hasException: false, input: msg.text, result: cmd.value ?? null, timestamp: Date.now() });
      }, cmd.delay ?? 0);
    } else {
      this.send(s, { from: to, error: "unrecognizedPacketType", message: `fake: ${type}` });
    }
  }
}

/** The code the fake evaluates: a value, optionally after a delay. */
export const fakeCode = (value: unknown, delay = 0): string => JSON.stringify({ value, delay });
