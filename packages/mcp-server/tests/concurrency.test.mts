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
 */
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

describe("connect() when nothing answers (no Zotero needed)", () => {
  it("rejects every concurrent caller and lets a later attempt start fresh", async () => {
    // Port 1 on loopback: nothing listens, so the socket errors immediately.
    const client = createClient({ port: 1, timeout: 2000 });
    const attempts = await Promise.allSettled([client.connect(), client.connect(), client.connect()]);
    expect(attempts.every((a) => a.status === "rejected")).toBe(true);
    // The shared attempt must be cleared, so a new call tries again rather
    // than returning the old rejection forever.
    await expect(client.connect()).rejects.toThrow(/Cannot connect to Zotero RDP/);
    client.disconnect();
  });
});
