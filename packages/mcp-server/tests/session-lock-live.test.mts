/**
 * The session lock against a live Zotero (#28), in two parts.
 *
 * 1. The compare-and-set. session-lock.test.mts runs the same snippet in a
 *    Node vm, which shows the logic but not the two properties the design
 *    rests on: that Zotero runs each evaluation of the snippet to completion
 *    before another connection's evaluation starts (so the read-check-write is
 *    atomic), and that the expiry is decided by Zotero's clock. These cases
 *    use two RDP connections to one Zotero, each with its own SessionLock, as
 *    two server processes would.
 *
 * 2. End to end over MCP stdio: real server processes, the way two coding
 *    sessions run. Servers A and B have ZOTERO_MCP_LOCK=1 and their own
 *    ZOTERO_MCP_LOCK_LABEL; server C runs without the variable. This checks
 *    what a test of the lock logic cannot: that the gate sits in the dispatch,
 *    before every tool (each tool C lists, minus the exempt ones, is refused
 *    for B while A holds the lock, and a refused call does not run), and that
 *    the tool list is unchanged without the variable.
 *
 * Both parts share one file because they share one Zotero-wide lock: vitest
 * runs test files in parallel, and two files would release each other's lock.
 * The servers are compiled into tmp/session-lock-test/ (gitignored), not
 * dist/: db-stats.test.mts rebuilds dist/ in parallel with this file, and a
 * server starting while tsc rewrites its files would fail at random.
 *
 * Skips (does not fail) when no Zotero with the bridge answers on
 * ZOTERO_RDP_PORT (default 6100) or `Zotero` does not resolve there. What it
 * writes in Zotero is the lock property, LOCK_PROPERTY, deleted after each
 * case of part 1 and at the end of part 2 (plus a marker property that a
 * refused call would have set, also deleted).
 */
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient, type GripValue, type RDPClient } from "../src/rdp/index.js";
import {
  CLEAR_LOCK_CODE,
  LOCK_EXEMPT_TOOLS,
  LOCK_PROPERTY,
  SessionLock,
  runLockOp,
  type LockHolder,
  type LockRecord,
} from "../src/utils/session-lock.js";

const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = join(PKG_ROOT, "tmp", "session-lock-test");
const NO_SUCH_PROJECT = join(OUT_ROOT, "no-such-project");

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
  console.warn(`[session-lock-live.test] skipping - ${notReady}`);
}

async function evalString(client: RDPClient, code: string): Promise<string> {
  const r = await client.evaluateJS(code);
  if (r.exception || r.exceptionMessage) throw new Error(`eval threw: ${r.exceptionMessage}`);
  return String(await client.gripToValueAsync(r.result as GripValue));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The compare-and-set, over two RDP connections
// ─────────────────────────────────────────────────────────────────────────────

const A: LockHolder = { id: `${process.pid}-live-a`, pid: process.pid, label: "live A" };
const B: LockHolder = { id: `${process.pid}-live-b`, pid: process.pid, label: "live B" };

describe.skipIf(Boolean(notReady))("session lock (live Zotero, two connections)", () => {
  let one: RDPClient;
  let two: RDPClient;

  const record = async (): Promise<LockRecord | null> => {
    const raw = await evalString(one, `typeof Zotero.${LOCK_PROPERTY} === "string" ? Zotero.${LOCK_PROPERTY} : "null"`);
    return JSON.parse(raw) as LockRecord | null;
  };
  const zoteroNow = async (): Promise<number> => Number(await evalString(one, "String(Date.now())"));

  beforeAll(async () => {
    one = createClient({ port: RDP_PORT });
    two = createClient({ port: RDP_PORT });
    await one.connect();
    await two.connect();
    await evalString(one, `String(delete Zotero.${LOCK_PROPERTY})`);
  });
  afterEach(async () => {
    await evalString(one, `String(delete Zotero.${LOCK_PROPERTY})`);
  });
  afterAll(() => {
    one.disconnect();
    two.disconnect();
  });

  it("fails B's gated call fast while A holds the lock, naming A, since and expiry", async () => {
    const a = new SessionLock(A);
    const b = new SessionLock(B);
    const got = await a.acquire(one, { waitSeconds: 0, leaseSeconds: 60 });
    expect(got.ok, got.text).toBe(true);
    const lock = (await record()) as LockRecord;
    expect(lock).toMatchObject({ v: 1, holder: A.id, label: "live A", leaseMs: 60_000 });

    const started = performance.now();
    const gate = await b.gate(two, "zotero_plugin_install");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(gate.allowed).toBe(false);
    expect(gate.text).toContain('"live A"');
    expect(gate.text).toContain(`Since:   ${new Date(lock.since).toISOString()}`);
    expect(gate.text).toContain(`Expires: ${new Date(lock.expires).toISOString()}`);
    expect(await a.gate(one, "zotero_execute_js")).toEqual({ allowed: true });
  });

  it("pushes the expiry back on the holder's gated call, with Zotero's clock", async () => {
    const a = new SessionLock(A);
    await a.acquire(one, { waitSeconds: 0, leaseSeconds: 60 });
    const before = (await record()) as LockRecord;
    await new Promise((r) => setTimeout(r, 300));
    const t0 = await zoteroNow();
    await a.gate(two, "zotero_execute_js");
    const t1 = await zoteroNow();
    const after = (await record()) as LockRecord;
    expect(after.since).toBe(before.since);
    expect(after.refreshed).toBeGreaterThanOrEqual(t0);
    expect(after.refreshed).toBeLessThanOrEqual(t1);
    expect(after.expires).toBe(after.refreshed + 60_000);
    expect(after.expires).toBeGreaterThan(before.expires);
  });

  it("refuses a release by the session that does not hold the lock", async () => {
    const a = new SessionLock(A);
    await a.acquire(one, { waitSeconds: 0 });
    const r = await new SessionLock(B).release(two);
    expect(r.ok).toBe(false);
    expect((await record())?.holder).toBe(A.id);
    expect((await a.release(one)).ok).toBe(true);
    expect(await record()).toBeNull();
  });

  it("lets B's waiting acquire in when A releases", async () => {
    const a = new SessionLock(A);
    await a.acquire(one, { waitSeconds: 0 });
    const waiting = new SessionLock(B).acquire(two, { waitSeconds: 10 });
    await new Promise((r) => setTimeout(r, 1200));
    expect((await a.release(one)).ok).toBe(true);
    const got = await waiting;
    expect(got.ok, got.text).toBe(true);
    expect(got.text).toMatch(/^✓ Zotero lock acquired after waiting \d+\.\d s\./);
    expect((await record())?.holder).toBe(B.id);
  });

  it("lets B's waiting acquire in when A's lease lapses on Zotero's clock", async () => {
    await new SessionLock(A).acquire(one, { waitSeconds: 0, leaseSeconds: 1.5 });
    const lapse = ((await record()) as LockRecord).expires;
    const got = await new SessionLock(B).acquire(two, { waitSeconds: 10 });
    expect(got.ok, got.text).toBe(true);
    expect(got.text).toContain(`did not release it: its lease lapsed at ${new Date(lapse).toISOString()}`);
    expect(((await record()) as LockRecord).since).toBeGreaterThanOrEqual(lapse);
  });

  it("is a real compare-and-set: of many concurrent acquires on two connections, exactly one wins", async () => {
    const holders = Array.from({ length: 8 }, (_, i): LockHolder => ({ id: `${process.pid}-race-${i}`, pid: process.pid }));
    for (let round = 0; round < 15; round++) {
      await evalString(one, `String(delete Zotero.${LOCK_PROPERTY})`);
      const replies = await Promise.all(
        holders.map((h, i) => runLockOp(i % 2 ? two : one, "acquire", h, { leaseMs: 60_000 }))
      );
      const winners = replies.filter((r) => r.ok);
      expect(winners, `round ${round}`).toHaveLength(1);
      expect((await record())?.holder).toBe(winners[0].lock?.holder);
    }
  });

  it("lives on the Zotero module object every window shares; the documented one-liner clears it", async () => {
    await new SessionLock(A).acquire(one, { waitSeconds: 0 });
    // include.js gives every window the export of chrome://zotero/content/zotero.mjs.
    expect(
      await evalString(one, `String(ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs").Zotero === Zotero)`)
    ).toBe("true");
    // Tools -> Developer -> Run JavaScript runs Zotero.getMainWindow().eval(code) (runJS.js).
    expect(await evalString(two, `String(Zotero.getMainWindow().eval(${JSON.stringify(CLEAR_LOCK_CODE)}))`)).toBe("true");
    expect(await record()).toBeNull();
    expect((await new SessionLock(B).gate(two, "zotero_execute_js")).allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. End to end: three server processes over MCP stdio
// ─────────────────────────────────────────────────────────────────────────────

interface CallResult {
  text: string;
  isError: boolean;
}

async function startServer(name: string, lockEnv: Record<string, string>): Promise<Client> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("ZOTERO_MCP_LOCK")
    )
  );
  const client = new Client({ name, version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(OUT_ROOT, "dist", "index.js")],
      env: { ...env, ...lockEnv },
      stderr: "ignore",
    })
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  return { text: result.content.map((c) => c.text ?? "").join("\n"), isError: Boolean(result.isError) };
}

describe.skipIf(Boolean(notReady))("session lock over MCP stdio (live Zotero, three server processes)", () => {
  let rdp: RDPClient;
  let a: Client; // ZOTERO_MCP_LOCK=1, "session A"
  let b: Client; // ZOTERO_MCP_LOCK=1, "session B"
  let c: Client; // no ZOTERO_MCP_LOCK
  let baseTools: string[];

  const clearLock = async () => {
    await evalString(rdp, `String(delete Zotero.${LOCK_PROPERTY})`);
  };
  /** The record as Zotero stores it, read through the server without the lock. */
  const record = async () => {
    const r = await call(c, "zotero_execute_js", { code: `return Zotero.${LOCK_PROPERTY} || "null"` });
    const json = r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1);
    return json ? (JSON.parse(json) as { holder: string; label?: string; refreshed: number; expires: number }) : null;
  };

  beforeAll(async () => {
    rmSync(OUT_ROOT, { recursive: true, force: true });
    mkdirSync(OUT_ROOT, { recursive: true });
    // dist/index.js reads ../package.json for its version.
    copyFileSync(join(PKG_ROOT, "package.json"), join(OUT_ROOT, "package.json"));
    try {
      execSync(
        `npx tsc --outDir "${join(OUT_ROOT, "dist")}" --declaration false --declarationMap false --sourceMap false`,
        { cwd: PKG_ROOT, stdio: "pipe" }
      );
    } catch (e) {
      const { stdout, stderr } = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`tsc failed:\n${stdout ?? ""}${stderr ?? ""}`);
    }
    rdp = createClient({ port: RDP_PORT });
    await rdp.connect();
    await clearLock();
    [a, b, c] = await Promise.all([
      startServer("lock-a", { ZOTERO_MCP_LOCK: "1", ZOTERO_MCP_LOCK_LABEL: "session A" }),
      startServer("lock-b", { ZOTERO_MCP_LOCK: "1", ZOTERO_MCP_LOCK_LABEL: "session B" }),
      startServer("lock-c", {}),
    ]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([a?.close(), b?.close(), c?.close()]);
    if (rdp) {
      await clearLock();
      await evalString(rdp, "String(delete Zotero._lockTestSideEffect)");
      rdp.disconnect();
    }
    rmSync(OUT_ROOT, { recursive: true, force: true });
  });

  it("lists zotero_acquire and zotero_release only with ZOTERO_MCP_LOCK=1", async () => {
    baseTools = (await c.listTools()).tools.map((t) => t.name);
    const lockTools = (await a.listTools()).tools.map((t) => t.name);
    expect(baseTools).not.toContain("zotero_acquire");
    expect(baseTools).not.toContain("zotero_release");
    expect(lockTools).toEqual([...baseTools, "zotero_acquire", "zotero_release"]);
    const off = await call(c, "zotero_acquire");
    expect(off).toEqual({ text: "Error: Unknown tool: zotero_acquire", isError: true });
  });

  it("while A holds the lock, every gated tool fails fast for B and does not run", async () => {
    const got = await call(a, "zotero_acquire", { waitSeconds: 0 });
    expect(got.isError, got.text).toBe(false);
    expect(got.text).toMatch(/^✓ Zotero lock acquired\./);
    expect(got.text).toContain('"session A"');

    const gated = baseTools.filter((n) => !LOCK_EXEMPT_TOOLS.has(n));
    expect(gated.length).toBe(baseTools.length - 5);
    for (const name of gated) {
      const started = performance.now();
      const r = await call(b, name, {});
      expect(r.isError, `${name}: ${r.text}`).toBe(true);
      expect(r.text, name).toContain(`✗ ${name} was not run: another session holds the Zotero lock`);
      expect(r.text, name).toMatch(/Holder: {2}"session A" \(server pid \d+, lock id \d+-[0-9a-f]{8}\)/);
      expect(r.text, name).toMatch(/Since: {3}\d{4}-\d\d-\d\dT[\d:.]+Z \(\d+\.\d s ago\)/);
      expect(r.text, name).toMatch(/Expires: \d{4}-\d\d-\d\dT[\d:.]+Z \(in \d+ s\)/);
      expect(performance.now() - started, name).toBeLessThan(3000);
    }

    // A refused call really did not run.
    await evalString(rdp, "String(delete Zotero._lockTestSideEffect)");
    expect((await call(b, "zotero_execute_js", { code: "Zotero._lockTestSideEffect = 1; return 1" })).isError).toBe(true);
    expect(await evalString(rdp, "typeof Zotero._lockTestSideEffect")).toBe("undefined");

    // Exempt tools pass the gate.
    const ping = await call(b, "zotero_ping");
    expect(ping.text).toMatch(/^✓ Connected to Zotero/);
    for (const name of ["zotero_scaffold_build", "zotero_scaffold_serve", "zotero_scaffold_lint", "zotero_scaffold_typecheck"]) {
      const r = await call(b, name, { action: "status", projectPath: NO_SUCH_PROJECT });
      expect(r.text, name).not.toContain("was not run");
      expect(r.text, name).toContain("Project path does not exist");
    }

    // Advisory: a server without ZOTERO_MCP_LOCK never looks at it.
    const free = await call(c, "zotero_execute_js", { code: "return 40 + 2" });
    expect(free.isError, free.text).toBe(false);
    expect(free.text).toContain("42");
  }, 60_000);

  it("lets A's own gated calls through and pushes A's expiry back", async () => {
    const before = await record();
    expect(before?.holder).toMatch(/^\d+-[0-9a-f]{8}$/);
    await new Promise((r) => setTimeout(r, 300));
    const r = await call(a, "zotero_execute_js", { code: "return 1 + 1" });
    expect(r.isError, r.text).toBe(false);
    const after = await record();
    expect(after?.holder).toBe(before?.holder);
    expect(after!.refreshed).toBeGreaterThan(before!.refreshed);
    expect(after!.expires).toBeGreaterThan(before!.expires);
  });

  it("refuses a release by B", async () => {
    const r = await call(b, "zotero_release");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("only the holder can release it");
    expect((await record())?.label).toBe("session A");
  });

  it("lets B's waiting acquire in when A releases", async () => {
    const waiting = call(b, "zotero_acquire", { waitSeconds: 15 });
    await new Promise((r) => setTimeout(r, 1500));
    const released = await call(a, "zotero_release");
    expect(released.text).toMatch(/^✓ Zotero lock released/);
    const got = await waiting;
    expect(got.isError, got.text).toBe(false);
    expect(got.text).toMatch(/^✓ Zotero lock acquired after waiting \d+\.\d s\./);
    expect((await record())?.label).toBe("session B");
  }, 30_000);

  it("lets A's waiting acquire in when B's lease lapses, and gives up after waitSeconds otherwise", async () => {
    const renew = await call(b, "zotero_acquire", { waitSeconds: 0, leaseSeconds: 2 });
    expect(renew.text).toMatch(/^✓ This session already held the Zotero lock; lease renewed/);
    const got = await call(a, "zotero_acquire", { waitSeconds: 15 });
    expect(got.isError, got.text).toBe(false);
    expect(got.text).toContain('The previous holder, "session B"');
    expect(got.text).toContain("did not release it: its lease lapsed at");

    const late = await call(b, "zotero_acquire", { waitSeconds: 1 });
    expect(late.isError).toBe(true);
    expect(late.text).toMatch(/^✗ Zotero lock not acquired after waiting \d\.\d s: another session holds it/);
    expect(late.text).toContain('"session A"');
  }, 30_000);

  it("stops B's waiting acquire when B's client cancels the call", async () => {
    const abort = new AbortController();
    const waiting = b.callTool({ name: "zotero_acquire", arguments: { waitSeconds: 15 } }, undefined, {
      signal: abort.signal,
    });
    await new Promise((r) => setTimeout(r, 1000));
    abort.abort();
    await expect(waiting).rejects.toThrow();
    // Once A lets go, nobody is waiting: B's server stopped polling.
    await new Promise((r) => setTimeout(r, 1500));
    expect((await call(a, "zotero_release")).text).toMatch(/^✓ Zotero lock released/);
    await new Promise((r) => setTimeout(r, 2500));
    expect(await record()).toBeNull();
    expect((await call(a, "zotero_acquire", { waitSeconds: 0 })).isError).toBe(false);
  }, 30_000);

  it("survives a restart of the holder's server: the record lives in Zotero", async () => {
    await a.close();
    a = await startServer("lock-a2", { ZOTERO_MCP_LOCK: "1", ZOTERO_MCP_LOCK_LABEL: "session A" });
    // A new process is a new holder; the old record still holds the lock.
    const r = await call(a, "zotero_execute_js", { code: "return 1" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Holder:  "session A"');
    expect((await record())?.label).toBe("session A");
  }, 30_000);
});
