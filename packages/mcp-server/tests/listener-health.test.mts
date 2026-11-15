/**
 * Regression test for #32: the bridge's health check closed a live listener
 * whenever Zotero's main thread was busy.
 *
 * The bridge probes its own port every 10 s and waited 1500 ms of wall-clock
 * time for the RDP intro packet. The intro is written on Zotero's main
 * thread, so a main thread blocked for longer than that made a live listener
 * look dead. The health check then closed it, dropping every connected
 * client, and the reopen's verification probe timed out the same way, so the
 * fresh listener was closed too and the port refused connections until the
 * next check. The lifecycle log (<profile>/mcp-rdp-events.log) showed it as
 * "listener FLAPPING" or "listener DOWN ... does not answer (held by another
 * process?)".
 *
 * This blocks the main thread in back-to-back 3 s chunks for 16 s, which
 * covers at least one health-check tick whatever its phase, while holding one
 * RDP connection open. A healthy bridge leaves both the listener and that
 * connection alone, and logs nothing.
 *
 * It needs the bridge plugin itself (the code under test), so it runs against
 * a live Zotero. OPT-IN, because it freezes that Zotero's UI for about 16 s:
 * set ZOTERO_STALL_TEST=1, and ZOTERO_RDP_PORT if the instance is not on 6100.
 * Run it on its own, since vitest runs test files in parallel and the other
 * live tests would time out against the frozen Zotero:
 *
 *   ZOTERO_STALL_TEST=1 npx vitest run tests/listener-health.test.mts
 */
import { describe, expect, it } from "vitest";
import { createClient, type RDPClient } from "../src/rdp/index.js";
import type { GripValue } from "../src/rdp/index.js";

const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");
const OPT_IN = process.env.ZOTERO_STALL_TEST === "1";
const BLOCK_MS = 3000;
const STALL_MS = 16000;
// After the stall, one more health-check interval (10 s) plus slack: long
// enough for a listener closed during the stall to have been reopened and
// logged, so the old behaviour shows up in the log rather than as a timeout.
const SETTLE_MS = 12000;

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

const notReady = OPT_IN ? await zoteroReady() : "opt-in: set ZOTERO_STALL_TEST=1 (freezes the target Zotero for ~16 s)";
if (notReady) {
  console.warn(`[listener-health.test] skipping - ${notReady}`);
}

async function evalString(client: RDPClient, code: string): Promise<string> {
  const r = await client.evaluateJS(code);
  if (r.exception) {
    throw new Error(`evaluation threw: ${r.exceptionMessage ?? JSON.stringify(r.exception)}`);
  }
  return String(await client.gripToValueAsync(r.result as GripValue));
}

const READ_LIFECYCLE_LOG = `(async () => {
  try {
    return await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "mcp-rdp-events.log"));
  } catch (e) {
    return "";
  }
})()`;

// Back to back: each chunk queues the next one only when it ends, so between
// two chunks Zotero runs just the events that arrived during the previous one.
// The probe needs several such events in turn (accept, intro write, intro
// read), so no probe can complete while this runs.
const BLOCK_MAIN_THREAD = `(() => {
  const end = Date.now() + ${STALL_MS};
  const chunk = () => {
    if (Date.now() >= end) return;
    const t = Date.now();
    while (Date.now() - t < ${BLOCK_MS}) { /* busy */ }
    Services.tm.dispatchToMainThread(chunk);
  };
  Services.tm.dispatchToMainThread(chunk);
  return "scheduled";
})()`;

describe.skipIf(Boolean(notReady))("bridge health check vs a blocked main thread (live Zotero, #32)", () => {
  it("leaves the listener and its connections alone while Zotero's main thread is blocked", async () => {
    // Longer than the stall: a quiet socket must not time out on our side.
    const client = createClient({ port: RDP_PORT, timeout: 120000 });
    client.setKeepaliveEnabled(false);
    let drops = 0;
    client.on("disconnected", () => { drops++; });
    try {
      await client.connect();
      const logBefore = (await evalString(client, READ_LIFECYCLE_LOG)).split("\n").length;

      expect(await evalString(client, BLOCK_MAIN_THREAD)).toBe("scheduled");
      await new Promise((r) => setTimeout(r, STALL_MS + SETTLE_MS));

      // `drops`: the connection held across the stall must still be the same
      // one, since a health check that closes the listener closes every
      // connection it accepted. Read the log even after a drop (evaluateJS
      // reconnects), so a failure shows both pieces of evidence.
      const newLines = (await evalString(client, READ_LIFECYCLE_LOG)).split("\n").slice(logBefore - 1);
      expect({ drops, outages: newLines.filter((l) => /FLAPPING|DOWN/.test(l)) })
        .toEqual({ drops: 0, outages: [] });
    } finally {
      client.disconnect();
    }
  }, 90000);
});
