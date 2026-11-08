/**
 * zotero_plugin_install: the result names the profile, and the `profile`
 * guard refuses to install into any other.
 *
 * The unit cases use a fake client returning the JSON the install code
 * produces: the texts and the refusal are host-side, so a mock is sufficient
 * for them. The live case checks the guard inside a real Zotero: a
 * mismatching guard refuses before AddonManager is touched, so it installs
 * nothing (it skips without a Zotero on ZOTERO_RDP_PORT, default 6100).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installCode, installWithClient, type InstallClient } from "../src/tools/plugin-install.js";
import { createClient, type RDPClient } from "../src/rdp/index.js";
import type { EvaluateJSResponse, GripValue } from "../src/rdp/index.js";

const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");
const PROFILE = "C:\\Users\\example\\AppData\\Roaming\\Zotero\\Zotero\\Profiles\\abcd1234.dev";

function fakeClient(json: unknown): InstallClient {
  return {
    async evaluateJS(): Promise<EvaluateJSResponse> {
      return { from: "c", result: JSON.stringify(json) as unknown as GripValue };
    },
    async gripToValueAsync(grip: GripValue) {
      return grip;
    },
  };
}

describe("zotero_plugin_install (unit, fake replies)", () => {
  it("names the profile the plugin went into", async () => {
    const [c] = await installWithClient(
      fakeClient({ success: true, profileDir: PROFILE, plugin: { id: "a@b", name: "A", version: "1.0", requiresRestart: false } }),
      "file:///x.xpi"
    );
    expect(c.text).toContain("✓ Plugin installed successfully");
    expect(c.text).toContain(`Profile: ${PROFILE}`);
  });

  it("refuses, saying which profile is running, when the guard does not match", async () => {
    await expect(
      installWithClient(fakeClient({ refused: true, profileDir: PROFILE }), "file:///x.xpi", "weavero-dev")
    ).rejects.toThrow(/Refused: the running Zotero's profile is ".*abcd1234\.dev", which does not contain "weavero-dev"\. Nothing was installed/);
  });

  it("checks the guard in Zotero before creating the install, case-insensitively", () => {
    const code = installCode("file:///x.xpi", "Weavero-Dev");
    expect(code).toContain('const guard = "Weavero-Dev";');
    expect(code.indexOf("guard.toLowerCase()")).toBeLessThan(code.indexOf("getInstallForURL"));
    expect(installCode("file:///x.xpi")).toContain("const guard = null;");
  });
});

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
  console.warn(`[plugin-install.test] skipping live case - ${ready.reason}`);
}

describe.skipIf(!ready.client)("zotero_plugin_install guard (live Zotero)", () => {
  let client: RDPClient;
  beforeAll(() => {
    client = ready.client as RDPClient;
  });
  afterAll(() => {
    client.disconnect();
  });

  it("refuses a mismatching guard and reports the real profile directory", async () => {
    // A file URL that is never read: the guard refuses first.
    await expect(
      installWithClient(client, "file:///no/such/plugin.xpi", "no-such-profile-name-7f3a")
    ).rejects.toThrow(/Refused: the running Zotero's profile is "[^"]*[\\/][^"]+", which does not contain "no-such-profile-name-7f3a"/);
  });
});
