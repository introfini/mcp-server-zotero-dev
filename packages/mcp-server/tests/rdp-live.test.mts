/**
 * RDPClient against a real Zotero: a timed-out evaluation.
 *
 * Skips (does not fail) unless a Zotero with the bridge answers on
 * ZOTERO_RDP_PORT (default 6100) and `typeof Zotero` resolves there.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type RDPClient } from "../src/rdp/index.js";
import type { GripValue } from "../src/rdp/index.js";

const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");

async function zoteroReady(): Promise<{ client: RDPClient | null; reason: string }> {
  const client = createClient({ port: RDP_PORT });
  try {
    await client.connect();
    const r = await client.evaluateJS("typeof Zotero");
    const t = r.exception ? "exception" : await client.gripToValueAsync(r.result as GripValue);
    if (t === "function" || t === "object") return { client, reason: "" };
    client.disconnect();
    return { client: null, reason: `typeof Zotero is ${String(t)} on port ${RDP_PORT}` };
  } catch (e) {
    try { client.disconnect(); } catch { /* not connected */ }
    return { client: null, reason: `no bridge on port ${RDP_PORT}: ${(e as Error).message}` };
  }
}

const ready = await zoteroReady();
if (!ready.client) {
  console.warn(`[rdp-live.test] skipping - ${ready.reason}`);
}

describe.skipIf(!ready.client)("RDPClient timeouts (live Zotero)", () => {
  let client: RDPClient;
  const value = async (code: string): Promise<unknown> => {
    const r = await client.evaluateJS(code);
    expect(r.exceptionMessage).toBeUndefined();
    return client.gripToValueAsync(r.result as GripValue);
  };

  beforeAll(() => {
    client = ready.client as RDPClient;
  });
  afterAll(async () => {
    try { await client.evaluateJS("delete Zotero._mcpLiveLate; 0"); } catch { /* best effort */ }
    client.disconnect();
  });

  it("a timed-out evaluation keeps running once, and the next calls get their own results", async () => {
    await value("Zotero._mcpLiveLate = 0; 0");
    const slow = "(async () => { await Zotero.Promise.delay(1500); Zotero._mcpLiveLate++; return 'late'; })()";
    await expect(client.evaluateJS(slow, { timeoutMs: 400 })).rejects.toThrow(/still running in Zotero/);
    expect(await value("'next'")).toBe("next");
    await new Promise((r) => setTimeout(r, 1600));
    expect(await value("'after'")).toBe("after");
    expect(await value("Zotero._mcpLiveLate")).toBe(1);
  });
});
