/**
 * Opt-in session lock (#28): two MCP sessions driving one Zotero take turns.
 *
 * Without it, session B's zotero_plugin_install can replace session A's build
 * between A's install and A's checks, and A then tests B's code with nothing
 * failing. With ZOTERO_MCP_LOCK=1, a session takes the lock with
 * zotero_acquire for a whole test pass and gives it back with zotero_release;
 * meanwhile every gated tool called from another lock-enabled session fails
 * fast, naming the holder, since when it holds the lock and when it expires.
 *
 * Where the lock lives: in Zotero, as a JSON string on the `Zotero` object
 * (LOCK_PROPERTY). `Zotero` is the export of chrome://zotero/content/zotero.mjs,
 * one module instance that every window imports (include.js), so the record is
 * the same from the RDP target and from Tools -> Developer -> Run JavaScript. A
 * Zotero restart clears it; an MCP server restart or a bridge plugin reload
 * does not, since the Zotero process keeps running. A string rather than an
 * object, so the record holds no reference into the window global the
 * evaluation ran in.
 *
 * Why it is a real compare-and-set: every read-check-write is one synchronous
 * snippet (lockSnippet). Firefox's console actor runs an evaluateJSAsync
 * request in a single main-thread task: evaluateJSAsync() -> evaluateJS() ->
 * evalWithDebugger() -> executeInGlobalWithBindings(), with no await before
 * the evaluation itself (devtools/server/actors/webconsole.js and
 * webconsole/eval-with-debugger.js, read in ESR 140 and ESR 153). Another
 * client's evaluation is another task, so it cannot run between this
 * snippet's read and its write.
 *
 * Whose clock: the expiry is decided inside the snippet with Zotero's
 * `Date.now()`, never the server's. The server only uses its own clock to
 * bound how long zotero_acquire waits, which is its own timeout.
 *
 * The lock is advisory: a server without ZOTERO_MCP_LOCK=1 never looks at it.
 * Nothing in this module imports index.ts (#33), so the tests load it directly.
 */
import { randomBytes } from "node:crypto";
import type { EvaluateJSResponse, GripValue } from "../rdp/index.js";

/** Property on the `Zotero` object that holds the lock record (a JSON string). */
export const LOCK_PROPERTY = "_mcpServerLock";

/** What a person runs in Tools -> Developer -> Run JavaScript to clear the lock. */
export const CLEAR_LOCK_CODE = `delete Zotero.${LOCK_PROPERTY}`;

/**
 * Tools that never take part in the lock: the scaffold tools work on the
 * project directory, not on Zotero (and the build is the long part of a test
 * pass, which should overlap), ping is how a session finds out what it talks
 * to, and acquire/release ARE the lock. Every other tool is gated, including
 * tools added later: the gate is an allowlist of exemptions, not a list of
 * gated tools someone has to remember to extend.
 */
export const LOCK_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "zotero_ping",
  "zotero_acquire",
  "zotero_release",
  "zotero_scaffold_build",
  "zotero_scaffold_serve",
  "zotero_scaffold_lint",
  "zotero_scaffold_typecheck",
]);

export function isGatedTool(name: string): boolean {
  return !LOCK_EXEMPT_TOOLS.has(name);
}

export const DEFAULT_LEASE_SECONDS = 300;
export const MAX_LEASE_SECONDS = 3600;
export const DEFAULT_WAIT_SECONDS = 30;
/** Many MCP clients time a tool call out at about 60 s. */
export const MAX_WAIT_SECONDS = 50;
/** How often a waiting zotero_acquire asks again. */
export const POLL_INTERVAL_MS = 1000;

export interface LockHolder {
  /** Unique per server process: pid + random. */
  id: string;
  pid: number;
  /** ZOTERO_MCP_LOCK_LABEL, for the person reading "held by ...". */
  label?: string;
}

export interface LockConfig {
  enabled: boolean;
  holder: LockHolder;
}

/** ZOTERO_MCP_LOCK=1 (or "true") turns the lock on; anything else leaves it off. */
export function lockConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
  random: () => string = () => randomBytes(4).toString("hex")
): LockConfig {
  const flag = (env.ZOTERO_MCP_LOCK ?? "").trim().toLowerCase();
  const label = (env.ZOTERO_MCP_LOCK_LABEL ?? "").trim();
  return {
    enabled: flag === "1" || flag === "true",
    holder: { id: `${pid}-${random()}`, pid, ...(label ? { label } : {}) },
  };
}

/** The record stored in Zotero. All times are Zotero's Date.now(). */
export interface LockRecord {
  v: 1;
  holder: string;
  pid: number;
  label?: string;
  since: number;
  refreshed: number;
  leaseMs: number;
  expires: number;
}

export type LockOp = "gate" | "acquire" | "release";

/** What one evaluation of lockSnippet() reports. */
export interface LockReply {
  /** False when `Zotero` is not defined in the RDP target (no window open). */
  reachable: boolean;
  /** Zotero's clock when the snippet ran. */
  now: number;
  /** gate: the call may run; acquire: granted; release: nothing is held by us any more. */
  ok: boolean;
  /** The caller held the lock when the snippet started. */
  mine: boolean;
  /** The record after the operation; null when the lock is free. */
  lock: LockRecord | null;
  /** An expired record this evaluation found and removed. */
  lapsed: LockRecord | null;
  /** release: the record it removed. */
  released: LockRecord | null;
}

/**
 * The compare-and-set, as one synchronous expression. It must stay
 * synchronous: an `await` would end the task and let another client's
 * evaluation run between the read and the write. It returns a JSON string,
 * never an object (nested objects do not survive RDP grip resolution).
 *
 * `reclaim` (gate only): the caller believes it holds the lock. If its lease
 * lapsed and nobody took the lock since, the call takes it again instead of
 * running unprotected.
 */
export function lockSnippet(
  op: LockOp,
  holder: LockHolder,
  options: { leaseMs?: number; reclaim?: boolean } = {}
): string {
  const args = {
    op,
    holder: holder.id,
    pid: holder.pid,
    label: holder.label,
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_SECONDS * 1000,
    reclaim: Boolean(options.reclaim),
  };
  return `(function (a) {
  if (typeof Zotero === "undefined") return JSON.stringify({ reachable: false });
  var KEY = ${JSON.stringify(LOCK_PROPERTY)};
  var now = Date.now();
  var lock = null;
  if (typeof Zotero[KEY] === "string") {
    try { lock = JSON.parse(Zotero[KEY]); } catch (e) { lock = null; }
  }
  if (lock !== null && (typeof lock !== "object" || typeof lock.holder !== "string")) lock = null;
  var lapsed = null;
  if (lock !== null && !(lock.expires > now)) { lapsed = lock; lock = null; delete Zotero[KEY]; }
  var mine = lock !== null && lock.holder === a.holder;
  var ok = false;
  var released = null;
  function take(leaseMs) {
    lock = { v: 1, holder: a.holder, pid: a.pid, label: a.label, since: now, refreshed: now, leaseMs: leaseMs, expires: now + leaseMs };
  }
  if (a.op === "acquire") {
    if (lock === null) take(a.leaseMs);
    else if (mine) { lock.refreshed = now; lock.leaseMs = a.leaseMs; lock.expires = now + a.leaseMs; }
    ok = lock !== null && lock.holder === a.holder;
    if (ok) Zotero[KEY] = JSON.stringify(lock);
  } else if (a.op === "gate") {
    if (lock === null) {
      if (a.reclaim) { take(a.leaseMs); Zotero[KEY] = JSON.stringify(lock); }
      ok = true;
    } else if (mine) {
      lock.refreshed = now; lock.expires = now + lock.leaseMs;
      Zotero[KEY] = JSON.stringify(lock);
      ok = true;
    }
  } else if (a.op === "release") {
    if (lock === null) ok = true;
    else if (mine) { released = lock; lock = null; delete Zotero[KEY]; ok = true; }
  }
  return JSON.stringify({ reachable: true, now: now, ok: ok, mine: mine, lock: lock, lapsed: lapsed, released: released });
})(${JSON.stringify(args)})`;
}

/** The subset of RDPClient the lock needs - injectable for tests. */
export interface LockClient {
  evaluateJS(code: string): Promise<EvaluateJSResponse>;
  gripToValueAsync(grip: GripValue): Promise<unknown>;
}

/** Evaluate one lock operation in Zotero. Throws when the evaluation fails. */
export async function runLockOp(
  client: LockClient,
  op: LockOp,
  holder: LockHolder,
  options: { leaseMs?: number; reclaim?: boolean } = {}
): Promise<LockReply> {
  const response = await client.evaluateJS(lockSnippet(op, holder, options));
  if (response.exception || response.exceptionMessage) {
    throw new Error(
      `the lock check threw in Zotero: ${response.exceptionMessage ?? "unknown exception"}`
    );
  }
  const raw =
    response.result === undefined ? undefined : await client.gripToValueAsync(response.result);
  if (typeof raw !== "string") {
    throw new Error(`unexpected reply to the lock check (${typeof raw}); expected a JSON string`);
  }
  const reply = JSON.parse(raw) as Partial<LockReply>;
  return {
    reachable: reply.reachable === true,
    now: Number(reply.now),
    ok: reply.ok === true,
    mine: reply.mine === true,
    lock: reply.lock ?? null,
    lapsed: reply.lapsed ?? null,
    released: reply.released ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wording
// ─────────────────────────────────────────────────────────────────────────────

/** `"session A" (server pid 4242, lock id 4242-1a2b3c4d)` */
export function describeHolder(h: { holder?: string; id?: string; pid: number; label?: string }): string {
  const id = h.holder ?? h.id ?? "?";
  return h.label
    ? `"${h.label}" (server pid ${h.pid}, lock id ${id})`
    : `server pid ${h.pid} (lock id ${id}, no ZOTERO_MCP_LOCK_LABEL)`;
}

function seconds(ms: number): string {
  const s = Math.abs(ms) / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

function at(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms);
}

/** Holder, since and expiry, measured against Zotero's clock (`now`). */
export function describeLock(lock: LockRecord, now: number): string {
  return (
    `  Holder:  ${describeHolder(lock)}\n` +
    `  Since:   ${at(lock.since)} (${seconds(now - lock.since)} ago)\n` +
    `  Expires: ${at(lock.expires)} (in ${seconds(lock.expires - now)}), ` +
    `pushed back by each Zotero tool call the holder makes (lease ${seconds(lock.leaseMs)})`
  );
}

const CLEAR_HINT =
  `If the holder is gone, the lock lapses by itself at its expiry; a person can clear it ` +
  `sooner in Zotero with Tools -> Developer -> Run JavaScript: ${CLEAR_LOCK_CODE}`;

// ─────────────────────────────────────────────────────────────────────────────
// One server process's view of the lock
// ─────────────────────────────────────────────────────────────────────────────

export interface GateResult {
  allowed: boolean;
  /** Refusal text when not allowed; a note to append to the tool's output otherwise. */
  text?: string;
}

export interface LockResult {
  ok: boolean;
  text: string;
}

export interface WaitDeps {
  sleep(ms: number): Promise<void>;
  /** Monotonic milliseconds on the server, used only to bound the wait. */
  elapsed(): number;
}

function realWaitDeps(): WaitDeps {
  const start = performance.now();
  return {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    elapsed: () => performance.now() - start,
  };
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The lock as one server process sees it. The only state kept here is
 * whether this process believes it holds the lock (and with which lease); the
 * truth is the record in Zotero, re-read by every operation.
 */
export class SessionLock {
  private held: { since: number; leaseMs: number } | null = null;

  constructor(
    readonly holder: LockHolder,
    private readonly makeWaitDeps: () => WaitDeps = realWaitDeps
  ) {}

  /** Whether this process believes it holds the lock (for tests and logs). */
  get believesHeld(): boolean {
    return this.held !== null;
  }

  /**
   * Run before every gated tool. Allowed when the lock is free or ours (ours:
   * the lease is pushed back); refused, naming the holder, when another
   * session holds it.
   */
  async gate(client: LockClient, tool: string): Promise<GateResult> {
    let reply: LockReply;
    try {
      reply = await runLockOp(client, "gate", this.holder, {
        leaseMs: this.held?.leaseMs,
        reclaim: this.held !== null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        allowed: false,
        text: `✗ ${tool} was not run: could not check the Zotero lock (ZOTERO_MCP_LOCK=1): ${message}`,
      };
    }
    if (!reply.reachable) {
      return {
        allowed: false,
        text:
          `✗ ${tool} was not run: could not check the Zotero lock (ZOTERO_MCP_LOCK=1), because ` +
          `\`Zotero\` is not defined in the bridge's target - usually no Zotero window is open. ` +
          `Run zotero_ping for details.`,
      };
    }

    if (reply.ok) {
      if (this.held !== null && !reply.mine && reply.lock) {
        // We believed we held the lock, but the record was no longer ours:
        // the snippet took it again (reclaim). Our own lapsed record still
        // being there means no lock-enabled session touched the lock in the
        // gap; another session's call would have found it lapsed and removed it.
        const before = this.held;
        this.held = { since: reply.lock.since, leaseMs: reply.lock.leaseMs };
        const untouched = reply.lapsed !== null && reply.lapsed.holder === this.holder.id;
        return {
          allowed: true,
          text: untouched
            ? `Note (Zotero lock): this session's lease lapsed at ${at((reply.lapsed as LockRecord).expires)} ` +
              `(no Zotero tool call for more than ${seconds(before.leaseMs)}). No other lock-enabled ` +
              `session used Zotero meanwhile, and this call took the lock again.`
            : `Note (Zotero lock): this session's lock had lapsed (no Zotero tool call for more than ` +
              `${seconds(before.leaseMs)}) and was cleared by another session or by hand, so another ` +
              `session may have used Zotero in between. This call took the lock again; redo what ` +
              `depends on the state you set up before.`,
        };
      }
      return { allowed: true };
    }

    const lock = reply.lock as LockRecord;
    let text =
      `✗ ${tool} was not run: another session holds the Zotero lock (ZOTERO_MCP_LOCK=1).\n\n` +
      `${describeLock(lock, reply.now)}\n\n`;
    if (this.held !== null) {
      text +=
        `This session held the lock since ${at(this.held.since)}, but its lease ran out ` +
        `(no Zotero tool call for more than ${seconds(this.held.leaseMs)}) and the session above ` +
        `took it at ${at(lock.since)}. Anything this session set up in Zotero before may have ` +
        `been changed since; redo it after getting the lock back.\n\n`;
      this.held = null;
    }
    text +=
      `Next: call zotero_acquire to wait for your turn (up to ${MAX_WAIT_SECONDS} s per call), ` +
      `then retry. The zotero_scaffold_* tools are not gated and can run meanwhile.\n` +
      CLEAR_HINT;
    return { allowed: false, text };
  }

  /**
   * Take the lock, waiting up to `waitSeconds` (at most MAX_WAIT_SECONDS) for
   * the holder to release it or for its lease to lapse. Taking it again while
   * holding it renews the lease.
   */
  async acquire(
    client: LockClient,
    options: { waitSeconds?: unknown; leaseSeconds?: unknown; signal?: AbortSignal } = {}
  ): Promise<LockResult> {
    const waitMs = clamp(options.waitSeconds, DEFAULT_WAIT_SECONDS, 0, MAX_WAIT_SECONDS) * 1000;
    const leaseMs = Math.round(
      clamp(options.leaseSeconds, DEFAULT_LEASE_SECONDS, 1, MAX_LEASE_SECONDS) * 1000
    );
    const { signal } = options;
    const cancelled: LockResult = {
      ok: false,
      text: "✗ zotero_acquire was cancelled by the client while waiting; the lock was not taken.",
    };
    const deps = this.makeWaitDeps();
    let lapsedSeen: LockRecord | null = null;
    let polls = 0;

    for (;;) {
      if (signal?.aborted) return cancelled;
      const reply = await runLockOp(client, "acquire", this.holder, { leaseMs });
      polls++;
      if (!reply.reachable) {
        return {
          ok: false,
          text:
            "✗ Could not take the Zotero lock: `Zotero` is not defined in the bridge's target - " +
            "usually no Zotero window is open. Run zotero_ping for details.",
        };
      }
      if (reply.lapsed && reply.lapsed.holder !== this.holder.id) lapsedSeen = reply.lapsed;

      if (reply.ok && signal?.aborted && !reply.mine) {
        // Granted after the client gave up (its tool-call timeout): nobody
        // would know this session holds the lock, so give it back.
        await runLockOp(client, "release", this.holder);
        return cancelled;
      }
      if (reply.ok) {
        const lock = reply.lock as LockRecord;
        this.held = { since: lock.since, leaseMs: lock.leaseMs };
        const waited = deps.elapsed();
        let text = reply.mine
          ? `✓ This session already held the Zotero lock; lease renewed.\n\n`
          : `✓ Zotero lock acquired` +
            (polls > 1 ? ` after waiting ${seconds(waited)}` : "") +
            `.\n\n`;
        text += `${describeLock(lock, reply.now)}\n\n`;
        if (lapsedSeen) {
          text +=
            `The previous holder, ${describeHolder(lapsedSeen)}, did not release it: its lease ` +
            `lapsed at ${at(lapsedSeen.expires)}.\n\n`;
        }
        text +=
          `Other lock-enabled sessions now get an error from every Zotero tool until you call ` +
          `zotero_release. Each Zotero tool call from this session pushes the expiry back; ` +
          `the zotero_scaffold_* tools do not, so for a build longer than the lease, acquire ` +
          `with a longer leaseSeconds.`;
        return { ok: true, text };
      }

      const lock = reply.lock as LockRecord;
      const elapsed = deps.elapsed();
      if (elapsed >= waitMs) {
        return {
          ok: false,
          text:
            `✗ Zotero lock not acquired` +
            (waitMs > 0 ? ` after waiting ${seconds(elapsed)}` : "") +
            `: another session holds it.\n\n` +
            `${describeLock(lock, reply.now)}\n\n` +
            `Next: call zotero_acquire again to keep waiting, or do work that does not need ` +
            `Zotero meanwhile (the zotero_scaffold_* tools are not gated).\n` +
            CLEAR_HINT,
        };
      }
      // Ask again in a second, or right after the holder's lease runs out if
      // that comes sooner (a duration on Zotero's clock, so no clock skew).
      const untilExpiry = lock.expires - reply.now + 20;
      await deps.sleep(Math.max(20, Math.min(POLL_INTERVAL_MS, untilExpiry, waitMs - elapsed)));
    }
  }

  /** Give the lock back. Refused when another session holds it. */
  async release(client: LockClient): Promise<LockResult> {
    const reply = await runLockOp(client, "release", this.holder);
    if (!reply.reachable) {
      return {
        ok: false,
        text:
          "✗ Could not release the Zotero lock: `Zotero` is not defined in the bridge's target - " +
          "usually no Zotero window is open. Run zotero_ping for details.",
      };
    }
    if (reply.ok) {
      const believedHeld = this.held !== null;
      this.held = null;
      if (reply.released) {
        return {
          ok: true,
          text:
            `✓ Zotero lock released (held since ${at(reply.released.since)}, ` +
            `${seconds(reply.now - reply.released.since)}).`,
        };
      }
      if (reply.lapsed && reply.lapsed.holder === this.holder.id) {
        return {
          ok: true,
          text:
            `Nothing to release: this session's lease had already lapsed at ` +
            `${at(reply.lapsed.expires)}, and no other session took the lock since.`,
        };
      }
      return {
        ok: true,
        text: believedHeld
          ? "Nothing to release: this session's lease had lapsed and the lock is free now " +
            "(another session may have used Zotero in between)."
          : "Nothing to release: the Zotero lock is free.",
      };
    }
    const lock = reply.lock as LockRecord;
    const lost = this.held !== null;
    this.held = null;
    return {
      ok: false,
      text:
        `✗ Not released: the Zotero lock is held by another session, and only the holder can ` +
        `release it.\n\n${describeLock(lock, reply.now)}` +
        (lost
          ? `\n\nThis session had acquired the lock, but its lease ran out and the session ` +
            `above took it at ${at(lock.since)}.`
          : ""),
    };
  }
}
