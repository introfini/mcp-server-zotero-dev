/**
 * The session lock's compare-and-set against a live Zotero (#28).
 *
 * session-lock.test.mts runs the same snippet in a Node vm, which shows the
 * logic but not the two properties the design rests on: that Zotero runs each
 * evaluation of the snippet to completion before another connection's
 * evaluation starts (so the read-check-write is atomic), and that the expiry
 * is decided by Zotero's clock. These cases use two RDP connections to one
 * Zotero, each with its own SessionLock, as two server processes would.
 *
 * Skips (does not fail) when no Zotero with the bridge answers on
 * ZOTERO_RDP_PORT (default 6100) or `Zotero` does not resolve there. What it
 * writes in Zotero is the lock property, LOCK_PROPERTY, deleted after each
 * case.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type GripValue, type RDPClient } from "../src/rdp/index.js";
import {
  CLEAR_LOCK_CODE,
  LOCK_PROPERTY,
  SessionLock,
  runLockOp,
  type LockHolder,
  type LockRecord,
} from "../src/utils/session-lock.js";

const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");

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
