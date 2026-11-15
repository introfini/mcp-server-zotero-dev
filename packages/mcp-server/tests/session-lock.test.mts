/**
 * Unit tests for the opt-in session lock (#28), no Zotero needed.
 *
 * The compare-and-set snippet is the code Zotero runs, so these tests do not
 * mock it: they evaluate lockSnippet()'s output in a Node `vm` context whose
 * `Zotero` is a plain object and whose `Date.now()` is a clock the test sets.
 * Two SessionLock instances with their own holders, sharing that context,
 * stand in for two server processes sharing one Zotero. What a vm cannot show
 * is that Zotero runs the snippet atomically; session-lock-live.test.mts
 * checks that against a real Zotero.
 *
 * The Zotero clock is deliberately set years away from the host's: if any
 * expiry were decided with the server's clock instead of Zotero's, these
 * leases would look long expired (or never expiring).
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  LOCK_EXEMPT_TOOLS,
  LOCK_PROPERTY,
  MAX_WAIT_SECONDS,
  SessionLock,
  isGatedTool,
  lockConfigFromEnv,
  lockSnippet,
  runLockOp,
  type LockClient,
  type LockHolder,
  type LockRecord,
  type WaitDeps,
} from "../src/utils/session-lock.js";
import type { EvaluateJSResponse, GripValue } from "../src/rdp/index.js";

// 2001-09-09T01:46:40Z: far from any host clock this test will run on.
const ZOTERO_EPOCH = 1_000_000_000_000;

/** A fake Zotero: a `Zotero` object, a settable clock, and an RDP-shaped evaluator. */
function fakeZotero() {
  const clock = { now: ZOTERO_EPOCH };
  const zotero: Record<string, unknown> = {};
  const context = vm.createContext({ Zotero: zotero, Date: { now: () => clock.now } });
  const client: LockClient = {
    async evaluateJS(code: string): Promise<EvaluateJSResponse> {
      try {
        const result = vm.runInContext(code, context) as GripValue;
        return { from: "fake-console", result };
      } catch (e) {
        return {
          from: "fake-console",
          exception: { type: "object", class: "Error" } as unknown as GripValue,
          exceptionMessage: String(e),
        };
      }
    },
    async gripToValueAsync(grip: GripValue) {
      return grip;
    },
  };
  const record = (): LockRecord | undefined =>
    typeof zotero[LOCK_PROPERTY] === "string" ? JSON.parse(zotero[LOCK_PROPERTY] as string) : undefined;
  return { clock, zotero, client, record };
}

const A: LockHolder = { id: "1111-aaaaaaaa", pid: 1111, label: "session A" };
const B: LockHolder = { id: "2222-bbbbbbbb", pid: 2222, label: "session B" };

/** Wait deps on a fake clock: sleeping advances Zotero's clock and the server's. */
function fakeWait(z: ReturnType<typeof fakeZotero>, onSleep?: (sleptMs: number) => Promise<void> | void) {
  let elapsed = 0;
  const sleeps: number[] = [];
  const make = (): WaitDeps => {
    elapsed = 0;
    return {
      async sleep(ms: number) {
        sleeps.push(ms);
        elapsed += ms;
        z.clock.now += ms;
        await onSleep?.(elapsed);
      },
      elapsed: () => elapsed,
    };
  };
  return { make, sleeps, elapsed: () => elapsed };
}

describe("lockConfigFromEnv", () => {
  it("is off unless ZOTERO_MCP_LOCK is 1 or true", () => {
    expect(lockConfigFromEnv({}).enabled).toBe(false);
    expect(lockConfigFromEnv({ ZOTERO_MCP_LOCK: "0" }).enabled).toBe(false);
    expect(lockConfigFromEnv({ ZOTERO_MCP_LOCK: "" }).enabled).toBe(false);
    expect(lockConfigFromEnv({ ZOTERO_MCP_LOCK: "1" }).enabled).toBe(true);
    expect(lockConfigFromEnv({ ZOTERO_MCP_LOCK: "true" }).enabled).toBe(true);
  });

  it("makes the holder id from the pid and a random part, plus the optional label", () => {
    const c = lockConfigFromEnv({ ZOTERO_MCP_LOCK: "1", ZOTERO_MCP_LOCK_LABEL: " session A " }, 4242, () => "1a2b3c4d");
    expect(c.holder).toEqual({ id: "4242-1a2b3c4d", pid: 4242, label: "session A" });
    expect(lockConfigFromEnv({ ZOTERO_MCP_LOCK: "1" }, 4242, () => "x").holder).toEqual({ id: "4242-x", pid: 4242 });
    // Two servers with the same pid (another machine, a reused pid) still differ.
    expect(lockConfigFromEnv({}).holder.id).not.toBe(lockConfigFromEnv({}).holder.id);
  });
});

describe("which tools the lock gates", () => {
  // The 28 tools on main, plus zotero_press_keys from the open #41.
  const gated = [
    "zotero_execute_js", "zotero_get_pref", "zotero_set_pref", "zotero_search_prefs",
    "zotero_inspect_object", "zotero_open_preferences", "zotero_screenshot",
    "zotero_inspect_element", "zotero_get_dom_tree", "zotero_get_styles", "zotero_list_windows",
    "zotero_click_element", "zotero_send_keys", "zotero_read_logs", "zotero_read_errors",
    "zotero_clear_logs", "zotero_watch_logs", "zotero_plugin_reload", "zotero_plugin_list",
    "zotero_plugin_install", "zotero_db_query", "zotero_db_schema", "zotero_db_stats",
    "zotero_press_keys",
  ];

  it("exempts exactly the scaffold tools, ping, acquire and release", () => {
    expect([...LOCK_EXEMPT_TOOLS].sort()).toEqual([
      "zotero_acquire", "zotero_ping", "zotero_release", "zotero_scaffold_build",
      "zotero_scaffold_lint", "zotero_scaffold_serve", "zotero_scaffold_typecheck",
    ]);
    for (const name of LOCK_EXEMPT_TOOLS) expect(isGatedTool(name)).toBe(false);
  });

  it("gates every other tool, including ones it has never heard of", () => {
    for (const name of gated) expect(isGatedTool(name), name).toBe(true);
    expect(isGatedTool("zotero_some_future_tool")).toBe(true);
  });
});

describe("the compare-and-set snippet (run in a vm against a fake Zotero)", () => {
  it("returns a JSON string and reports an unreachable Zotero", async () => {
    const context = vm.createContext({});
    const raw = vm.runInContext(lockSnippet("gate", A), context);
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw)).toEqual({ reachable: false });
  });

  it("lets anyone through while the lock is free, without taking it", async () => {
    const z = fakeZotero();
    const reply = await runLockOp(z.client, "gate", B);
    expect(reply).toMatchObject({ reachable: true, ok: true, mine: false, lock: null, now: ZOTERO_EPOCH });
    expect(z.record()).toBeUndefined();
  });

  it("stores the record with Zotero's clock and hands it to one holder only", async () => {
    const z = fakeZotero();
    const a = await runLockOp(z.client, "acquire", A, { leaseMs: 300_000 });
    expect(a.ok).toBe(true);
    expect(z.record()).toEqual({
      v: 1, holder: A.id, pid: A.pid, label: "session A",
      since: ZOTERO_EPOCH, refreshed: ZOTERO_EPOCH, leaseMs: 300_000, expires: ZOTERO_EPOCH + 300_000,
    });
    const b = await runLockOp(z.client, "acquire", B, { leaseMs: 300_000 });
    expect(b.ok).toBe(false);
    expect(b.lock?.holder).toBe(A.id);
    expect(z.record()?.holder).toBe(A.id);
  });

  it("treats a record it cannot read as no lock", async () => {
    const z = fakeZotero();
    z.zotero[LOCK_PROPERTY] = "{not json";
    expect((await runLockOp(z.client, "acquire", B)).ok).toBe(true);
    z.zotero[LOCK_PROPERTY] = JSON.stringify({ unrelated: true });
    expect((await runLockOp(z.client, "gate", A)).ok).toBe(true);
  });
});

describe("SessionLock: two servers sharing one (fake) Zotero", () => {
  it("fails B's gated call fast, naming A, since and expiry, while A holds the lock", async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    const b = new SessionLock(B);
    expect((await a.acquire(z.client, { waitSeconds: 0 })).ok).toBe(true);
    z.clock.now += 95_000;

    const gate = await b.gate(z.client, "zotero_plugin_install");
    expect(gate.allowed).toBe(false);
    expect(gate.text).toContain("zotero_plugin_install was not run");
    expect(gate.text).toContain('"session A" (server pid 1111, lock id 1111-aaaaaaaa)');
    expect(gate.text).toContain(`Since:   ${new Date(ZOTERO_EPOCH).toISOString()} (95 s ago)`);
    expect(gate.text).toContain(`Expires: ${new Date(ZOTERO_EPOCH + 300_000).toISOString()} (in 205 s)`);
    expect(gate.text).toContain("zotero_acquire");
    expect(gate.text).toContain(`delete Zotero.${LOCK_PROPERTY}`);
  });

  it("lets the holder's own gated calls through and pushes the expiry back", async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    await a.acquire(z.client, { waitSeconds: 0, leaseSeconds: 60 });
    z.clock.now += 50_000;
    expect(await a.gate(z.client, "zotero_execute_js")).toEqual({ allowed: true });
    expect(z.record()).toMatchObject({ since: ZOTERO_EPOCH, refreshed: ZOTERO_EPOCH + 50_000, expires: ZOTERO_EPOCH + 110_000 });
    // 100 s after acquiring, past the original 60 s lease, it still holds.
    z.clock.now += 50_000;
    expect((await new SessionLock(B).gate(z.client, "zotero_execute_js")).allowed).toBe(false);
  });

  it("refuses a release by a session that does not hold the lock", async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    await a.acquire(z.client, { waitSeconds: 0 });
    const r = await new SessionLock(B).release(z.client);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("only the holder can release it");
    expect(r.text).toContain('"session A"');
    expect(z.record()?.holder).toBe(A.id);

    const mine = await a.release(z.client);
    expect(mine).toMatchObject({ ok: true });
    expect(mine.text).toMatch(/^✓ Zotero lock released/);
    expect(z.record()).toBeUndefined();
    expect((await new SessionLock(B).gate(z.client, "zotero_execute_js")).allowed).toBe(true);
  });

  it("expires on Zotero's clock, not the server's", async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    const b = new SessionLock(B);
    await a.acquire(z.client, { waitSeconds: 0, leaseSeconds: 300 });
    // Server time passes, Zotero's does not: still held.
    await new Promise((r) => setTimeout(r, 30));
    expect((await b.gate(z.client, "zotero_execute_js")).allowed).toBe(false);
    // Zotero's clock passes the expiry: B gets in and A's lapsed record is gone.
    z.clock.now += 300_000;
    const got = await b.acquire(z.client, { waitSeconds: 0 });
    expect(got.ok).toBe(true);
    expect(got.text).toContain('The previous holder, "session A"');
    expect(got.text).toContain(`lapsed at ${new Date(ZOTERO_EPOCH + 300_000).toISOString()}`);
    expect(z.record()?.holder).toBe(B.id);
  });

  it("renews the lease when the holder acquires again", async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    await a.acquire(z.client, { waitSeconds: 0, leaseSeconds: 60 });
    z.clock.now += 30_000;
    const again = await a.acquire(z.client, { waitSeconds: 0, leaseSeconds: 600 });
    expect(again.text).toMatch(/^✓ This session already held the Zotero lock; lease renewed/);
    expect(z.record()).toMatchObject({ since: ZOTERO_EPOCH, leaseMs: 600_000, expires: ZOTERO_EPOCH + 630_000 });
  });

  it("waits for the holder's release, polling about once a second", async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    await a.acquire(z.client, { waitSeconds: 0 });
    const wait = fakeWait(z, async (elapsed) => {
      if (elapsed >= 3000) await a.release(z.client);
    });
    const b = new SessionLock(B, wait.make);
    const got = await b.acquire(z.client, { waitSeconds: 30 });
    expect(got.ok).toBe(true);
    expect(got.text).toMatch(/^✓ Zotero lock acquired after waiting 3\.0 s\./);
    expect(wait.sleeps).toEqual([1000, 1000, 1000]);
    expect(z.record()?.holder).toBe(B.id);
  });

  it("waits for the holder's lease to lapse, and asks right after it does", async () => {
    const z = fakeZotero();
    await new SessionLock(A).acquire(z.client, { waitSeconds: 0, leaseSeconds: 2.5 });
    const wait = fakeWait(z);
    const got = await new SessionLock(B, wait.make).acquire(z.client, { waitSeconds: 30 });
    expect(got.ok).toBe(true);
    // 1 s, 1 s, then 0.5 s + 20 ms to land just past the expiry.
    expect(wait.sleeps).toEqual([1000, 1000, 520]);
    expect(got.text).toContain("did not release it: its lease lapsed");
  });

  it("gives up after the wait, saying who holds the lock since when", async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    await a.acquire(z.client, { waitSeconds: 0 });
    // A keeps working, so its lease keeps moving.
    const wait = fakeWait(z, async () => {
      await a.gate(z.client, "zotero_execute_js");
    });
    const got = await new SessionLock(B, wait.make).acquire(z.client, { waitSeconds: 5 });
    expect(got.ok).toBe(false);
    expect(got.text).toMatch(/^✗ Zotero lock not acquired after waiting 5\.0 s: another session holds it/);
    expect(got.text).toContain('"session A"');
    expect(got.text).toContain(`Since:   ${new Date(ZOTERO_EPOCH).toISOString()} (5.0 s ago)`);
    expect(wait.elapsed()).toBe(5000);
  });

  it(`never waits longer than ${MAX_WAIT_SECONDS} s, whatever it is asked`, async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    await a.acquire(z.client, { waitSeconds: 0, leaseSeconds: 3600 });
    const wait = fakeWait(z);
    const got = await new SessionLock(B, wait.make).acquire(z.client, { waitSeconds: 600 });
    expect(got.ok).toBe(false);
    expect(wait.elapsed()).toBe(MAX_WAIT_SECONDS * 1000);
  });

  it("stops waiting when the client cancels the call", async () => {
    const z = fakeZotero();
    await new SessionLock(A).acquire(z.client, { waitSeconds: 0 });
    const abort = new AbortController();
    const wait = fakeWait(z, (elapsed) => {
      if (elapsed >= 2000) abort.abort();
    });
    const got = await new SessionLock(B, wait.make).acquire(z.client, { waitSeconds: 30, signal: abort.signal });
    expect(got).toEqual({ ok: false, text: expect.stringContaining("cancelled by the client") });
    expect(wait.elapsed()).toBe(2000);
    expect(z.record()?.holder).toBe(A.id);
  });

  it("gives the lock back when it was granted after the client cancelled", async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    await a.acquire(z.client, { waitSeconds: 0 });
    const abort = new AbortController();
    // A releases and the client gives up in the same second: the next poll
    // is granted, but nobody is waiting for the answer any more.
    const evaluate = z.client.evaluateJS.bind(z.client);
    const racing: LockClient = {
      ...z.client,
      async evaluateJS(code: string) {
        const reply = await evaluate(code);
        if (z.clock.now >= ZOTERO_EPOCH + 1000) abort.abort();
        return reply;
      },
    };
    const wait = fakeWait(z, async () => {
      await a.release(z.client);
    });
    const b = new SessionLock(B, wait.make);
    const got = await b.acquire(racing, { waitSeconds: 30, signal: abort.signal });
    expect(got.text).toContain("cancelled by the client");
    expect(z.record()).toBeUndefined();
    expect(b.believesHeld).toBe(false);
  });

  it("with waitSeconds 0, tries once", async () => {
    const z = fakeZotero();
    await new SessionLock(A).acquire(z.client, { waitSeconds: 0 });
    const wait = fakeWait(z);
    const got = await new SessionLock(B, wait.make).acquire(z.client, { waitSeconds: 0 });
    expect(got.text).toMatch(/^✗ Zotero lock not acquired: another session holds it/);
    expect(wait.sleeps).toEqual([]);
  });

  it("takes a lapsed lease back on the holder's next call when nobody else used Zotero", async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    await a.acquire(z.client, { waitSeconds: 0, leaseSeconds: 60 });
    z.clock.now += 120_000; // a long build, scaffold tools only
    const gate = await a.gate(z.client, "zotero_plugin_install");
    expect(gate.allowed).toBe(true);
    expect(gate.text).toContain("No other lock-enabled session used Zotero meanwhile");
    expect(z.record()).toMatchObject({ holder: A.id, since: ZOTERO_EPOCH + 120_000, leaseMs: 60_000 });
    expect(a.believesHeld).toBe(true);
  });

  it("says so when a lapsed lease was cleared by another session before the holder came back", async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    await a.acquire(z.client, { waitSeconds: 0, leaseSeconds: 60 });
    z.clock.now += 120_000;
    // B passes through (free lock) and so removes A's lapsed record.
    expect((await new SessionLock(B).gate(z.client, "zotero_set_pref")).allowed).toBe(true);
    const gate = await a.gate(z.client, "zotero_execute_js");
    expect(gate.allowed).toBe(true);
    expect(gate.text).toContain("another session may have used Zotero in between");
    expect(z.record()?.holder).toBe(A.id);
  });

  it("tells the former holder it lost the lock when another session took it", async () => {
    const z = fakeZotero();
    const a = new SessionLock(A);
    await a.acquire(z.client, { waitSeconds: 0, leaseSeconds: 60 });
    z.clock.now += 120_000;
    expect((await new SessionLock(B).acquire(z.client, { waitSeconds: 0 })).ok).toBe(true);
    const gate = await a.gate(z.client, "zotero_execute_js");
    expect(gate.allowed).toBe(false);
    expect(gate.text).toContain(`This session held the lock since ${new Date(ZOTERO_EPOCH).toISOString()}, but its lease ran out`);
    expect(a.believesHeld).toBe(false);
  });

  it("refuses the call, with the reason, when the lock cannot be checked", async () => {
    const lock = new SessionLock(B);
    const unreachable: LockClient = {
      async evaluateJS() {
        return { from: "c", result: JSON.stringify({ reachable: false }) as unknown as GripValue };
      },
      async gripToValueAsync(g: GripValue) { return g; },
    };
    const threw: LockClient = {
      async evaluateJS() {
        return { from: "c", exception: {} as GripValue, exceptionMessage: "TypeError: boom" };
      },
      async gripToValueAsync(g: GripValue) { return g; },
    };
    const g1 = await lock.gate(unreachable, "zotero_screenshot");
    expect(g1.allowed).toBe(false);
    expect(g1.text).toContain("`Zotero` is not defined in the bridge's target");
    const g2 = await lock.gate(threw, "zotero_screenshot");
    expect(g2.allowed).toBe(false);
    expect(g2.text).toContain("the lock check threw in Zotero: TypeError: boom");
  });
});
