/**
 * Regression tests for zotero_ping (#24).
 *
 * The defect was host-side: handlePing never inspected `.exception` on its
 * evals, so an RDP reply carrying `exceptionMessage: "ReferenceError: Zotero
 * is not defined"` still produced a "✓ Connected" banner (with every field
 * rendered as "[object Object]"). The three unit cases below therefore use a
 * fake client that returns the reply SHAPES a real Zotero produces - the bug
 * lived entirely in how those shapes were handled, so a mock is sufficient
 * and lets the "Zotero unreachable" state be exercised without closing the
 * developer's Zotero window.
 *
 * The last case is the live round trip: it skips (does not fail) unless a
 * Zotero with the bridge answers on ZOTERO_RDP_PORT (default 6100) AND
 * `typeof Zotero` resolves there - a port that accepts TCP while Zotero sits
 * windowless is exactly the state this tool now reports, so probing the port
 * alone would be the wrong readiness check.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pingWithClient, PING_PROBE, type PingClient } from "../src/tools/ping.js";
import { createClient, type RDPClient } from "../src/rdp/index.js";
import type { EvaluateJSResponse, GripValue } from "../src/rdp/index.js";

const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");

function fakeClient(reply: EvaluateJSResponse): PingClient {
  return {
    async evaluateJS(code: string) {
      expect(code).toBe(PING_PROBE);
      return reply;
    },
    async gripToValueAsync(grip: GripValue) {
      // A primitive grip IS the value; an object grip is what the old code
      // interpolated as "[object Object]".
      return grip;
    },
  };
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe("text");
  return content[0].text ?? "";
}

describe("zotero_ping (unit, fake RDP replies)", () => {
  it("prints the banner from the JSON probe when Zotero is reachable", async () => {
    const reply: EvaluateJSResponse = {
      from: "server1.conn0.consoleActor4",
      result: JSON.stringify({
        reachable: true,
        version: "10.0.3-beta.2+80bc5565e",
        appName: "Zotero",
        platformVersion: 140,
        dataDir: "D:\\Users\\example\\Zotero",
      }) as unknown as GripValue,
    };
    const text = textOf(await pingWithClient(fakeClient(reply), 6100));
    expect(text).toMatch(/^✓ Connected to Zotero 10\.0\.3-beta\.2\+80bc5565e\n/);
    expect(text).toContain("Platform: Firefox 140");
    expect(text).toContain("Data directory: D:\\Users\\example\\Zotero");
    expect(text).toContain("RDP port: 6100");
    expect(text).not.toContain("[object Object]");
  });

  it("reports the bridge as reachable but Zotero as not when the probe says so", async () => {
    // typeof Zotero === "undefined" in the target: the windowless state.
    const reply: EvaluateJSResponse = {
      from: "server1.conn0.consoleActor4",
      result: JSON.stringify({ reachable: false }) as unknown as GripValue,
    };
    const text = textOf(await pingWithClient(fakeClient(reply), 6100));
    expect(text).toMatch(/^✗ Bridge reachable on port 6100, but Zotero is not/);
    expect(text).toContain("NO window open");
    expect(text).not.toContain("✓");
  });

  it("treats a null grip as unreachable instead of printing it", async () => {
    // gripToValue() has no branch for the {type: "null"} grip and hands it
    // through as an object - the shape behind the old "[object Object]".
    const reply: EvaluateJSResponse = {
      from: "server1.conn0.consoleActor4",
      result: { type: "null" } as unknown as GripValue,
    };
    const text = textOf(await pingWithClient(fakeClient(reply), 6100));
    expect(text).toMatch(/^✗ Bridge reachable on port 6100, but Zotero is not/);
    expect(text).not.toContain("[object Object]");
  });

  it("throws (so the caller prints the ✗ branch) when the eval raised", async () => {
    // The pre-fix reply shape from a windowless Zotero: exception set, result
    // an unresolvable object grip.
    const reply: EvaluateJSResponse = {
      from: "server1.conn0.consoleActor4",
      exception: {
        type: "object",
        class: "ReferenceError",
        preview: { message: "Zotero is not defined" },
      } as unknown as GripValue,
      exceptionMessage: "ReferenceError: Zotero is not defined",
      result: { type: "undefined" } as unknown as GripValue,
    };
    await expect(pingWithClient(fakeClient(reply), 6100)).rejects.toThrow(
      /Probe evaluation failed: ReferenceError: Zotero is not defined/
    );
  });
});

/** Readiness: the port must answer AND `Zotero` must resolve in the target. */
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
  console.warn(`[ping.test] skipping live case - ${ready.reason}`);
}

describe.skipIf(!ready.client)("zotero_ping (live Zotero)", () => {
  let client: RDPClient;
  beforeAll(() => {
    client = ready.client as RDPClient;
  });
  afterAll(() => {
    client.disconnect();
  });

  it("round-trips the probe against the running Zotero", async () => {
    const text = textOf(await pingWithClient(client, RDP_PORT));
    expect(text).toMatch(/^✓ Connected to Zotero \d+\.\d+/);
    expect(text).toContain(`RDP port: ${RDP_PORT}`);
    expect(text).not.toContain("[object Object]");
  });
});
