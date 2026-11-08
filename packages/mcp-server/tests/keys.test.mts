/**
 * zotero_press_keys: key-combination parsing, and that the keys it sends are
 * trusted.
 *
 * The parsing is pure. Trust only exists in a real Zotero (a mock cannot say
 * whether Gecko marks an event trusted), so the live case adds a temporary
 * input and a temporary <key> shortcut to the main window, sends the tool's
 * code, records what the listeners saw in the SAME evaluation (functions
 * defined by one evaluation do not outlive it), and removes both. It skips
 * without a Zotero on ZOTERO_RDP_PORT (default 6100).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keySpec, parseKeyCombo } from "../src/tools/keys.js";
import { pressKeysCode } from "../src/tools/interact.js";
import { createClient, type RDPClient } from "../src/rdp/index.js";
import type { GripValue } from "../src/rdp/index.js";

const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");

describe("parseKeyCombo", () => {
  it("reads modifiers in any case and the key, a letter upper case with Shift", () => {
    expect(parseKeyCombo("ctrl+Shift+f")).toEqual({ modifiers: ["Control", "Shift"], key: { key: "F", code: "KeyF", keyCode: 70 } });
    expect(parseKeyCombo("Accel+w")).toEqual({ modifiers: ["Accel"], key: { key: "w", code: "KeyW", keyCode: 87 } });
    expect(parseKeyCombo("Cmd+Option+Escape").modifiers).toEqual(["Meta", "Alt"]);
  });

  it("knows named keys, function keys, digits and punctuation", () => {
    expect(keySpec("Enter")).toEqual({ key: "Enter", code: "Enter", keyCode: 13 });
    expect(keySpec("esc").key).toBe("Escape");
    expect(keySpec("F5")).toEqual({ key: "F5", code: "F5", keyCode: 116 });
    expect(keySpec("7")).toEqual({ key: "7", code: "Digit7", keyCode: 55 });
    expect(keySpec(",")).toEqual({ key: ",", code: "Comma", keyCode: 188 });
    expect(parseKeyCombo("Ctrl+Plus")).toEqual({ modifiers: ["Control", "Shift"], key: { key: "+", code: "Equal", keyCode: 61 } });
  });

  it("refuses what it does not know, saying what it accepts", () => {
    expect(() => parseKeyCombo("Hyper+X")).toThrow(/Unknown modifier "Hyper".*Ctrl, Shift, Alt, Meta\/Cmd or Accel/);
    expect(() => keySpec("Banana")).toThrow(/Unknown key "Banana"/);
    expect(() => parseKeyCombo("")).toThrow(/Empty key combination/);
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
  console.warn(`[keys.test] skipping live case - ${ready.reason}`);
}

describe.skipIf(!ready.client)("zotero_press_keys (live Zotero)", () => {
  let client: RDPClient;
  beforeAll(() => {
    client = ready.client as RDPClient;
  });
  afterAll(() => {
    client.disconnect();
  });

  it("types into a field and fires a <key> shortcut, with trusted events", async () => {
    const press = pressKeysCode([parseKeyCombo("Accel+Shift+Y")], "aB", "#mcp-keys-test-input", undefined);
    const code = `(() => {
      const w = Zotero.getMainWindow(), doc = w.document, seen = [];
      const input = doc.createElementNS("http://www.w3.org/1999/xhtml", "input");
      input.id = "mcp-keys-test-input";
      input.style.cssText = "position: fixed; left: 0; top: 0; width: 60px; z-index: 100000;";
      doc.documentElement.appendChild(input);
      const keyset = doc.createXULElement("keyset");
      const key = doc.createXULElement("key");
      key.setAttribute("key", "Y");
      key.setAttribute("modifiers", "accel,shift");
      key.addEventListener("command", (e) => seen.push("command:" + e.isTrusted));
      keyset.appendChild(key);
      doc.documentElement.appendChild(keyset);
      input.addEventListener("keydown", (e) => seen.push("keydown:" + e.isTrusted + ":" + e.key));
      let reply;
      try { reply = JSON.parse(${press}); }
      finally { input.remove(); keyset.remove(); }
      return JSON.stringify({ reply, seen, value: input.value });
    })()`;
    const r = await client.evaluateJS(code);
    expect(r.exceptionMessage).toBeUndefined();
    const out = JSON.parse(String(await client.gripToValueAsync(r.result as GripValue)));
    expect(out.reply.ok).toBe(true);
    expect(out.value).toBe("aB");
    expect(out.seen).toContain("keydown:true:a");
    expect(out.seen).toContain("keydown:true:B");
    expect(out.seen).toContain("command:true");
  });
});
