/**
 * Tests for zotero_handle_dialog (#13).
 *
 * The unit cases cover the parts that do not need Zotero: argument checks,
 * that every evaluated snippet compiles, the report text, and which
 * evaluation the handler sends for each action (fake client: what is checked
 * is what the host sends and how it reads the reply, not Zotero).
 *
 * The live cases open REAL blocking dialogs (Services.prompt, window.alert/
 * confirm, a modal window.openDialog) through evaluateJS and check that the
 * armed handler answered each with the expected button. A dialog left open
 * blocks Zotero's main thread for every later test, so afterEach answers
 * anything still open; see safetyNet(). They skip when no Zotero with the
 * bridge answers on ZOTERO_RDP_PORT (default 6100), or when `Zotero` does
 * not resolve there (a windowless Zotero keeps the port open).
 *
 * The stdio cases drive the built server the way an MCP client does: the
 * trigger is zotero_click_element on a button whose click handler calls
 * Services.prompt.confirmEx, and closing the client disarms the handler.
 */
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  armCode,
  disarmCode,
  formatArmed,
  formatEntry,
  formatHandleOpen,
  formatSummary,
  handleDialogWithClient,
  handleOpenCode,
  parseDialogArgs,
  releaseDialogHandler,
  statusCode,
  STATE_KEY,
  type DialogClient,
  type HandlerSummary,
} from "../src/tools/dialog.js";
import { createClient, type EvaluateJSResponse, type GripValue, type RDPClient } from "../src/rdp/index.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Unit
// ─────────────────────────────────────────────────────────────────────────────
describe("zotero_handle_dialog arguments", () => {
  it("defaults to arming a one-shot accept for 60 s", () => {
    expect(parseDialogArgs({})).toEqual({
      action: "arm",
      options: { button: "accept", count: 1, timeoutMs: 60_000 },
    });
  });

  it("keeps text, checkbox and match", () => {
    expect(
      parseDialogArgs({ action: "arm", button: "extra1", text: "x", checkbox: false, match: "Delete", count: 2, timeoutMs: 5000 })
    ).toEqual({
      action: "arm",
      options: { button: "extra1", text: "x", checkbox: false, match: "Delete", count: 2, timeoutMs: 5000 },
    });
  });

  it.each([
    [{ action: "click" }, /Unknown action "click"/],
    [{ button: "ok" }, /Unknown button "ok"/],
    [{ count: 0 }, /count must be an integer from 1 to 20/],
    [{ count: 1.5 }, /count must be an integer/],
    [{ count: 21 }, /count must be an integer/],
    [{ timeoutMs: 10 }, /timeoutMs must be a number from 1000 to 600000/],
    [{ timeoutMs: 600_001 }, /timeoutMs must be/],
    [{ timeoutMs: "60000" }, /timeoutMs must be/],
    [{ text: 3 }, /text must be a string/],
    [{ checkbox: "yes" }, /checkbox must be true or false/],
    [{ match: "  " }, /match must be a non-empty string/],
  ])("rejects %j", (args, message) => {
    expect(() => parseDialogArgs(args as Record<string, unknown>)).toThrow(message);
  });
});

describe("zotero_handle_dialog snippets", () => {
  const options = { button: "cancel" as const, text: 'quote " and \\ and </script>', match: "a", count: 3, timeoutMs: 2000 };

  it("compiles every evaluated snippet", () => {
    for (const code of [armCode(options), statusCode(), disarmCode(), disarmCode(7), handleOpenCode(options)]) {
      expect(() => new Function(`return ${code};`)).not.toThrow();
    }
  });

  it("embeds the options as JSON and keeps state under one key", () => {
    expect(armCode(options)).toContain(`const opts = ${JSON.stringify(options)};`);
    expect(statusCode()).toContain(JSON.stringify(STATE_KEY));
    expect(disarmCode(7)).toContain("const id = 7;");
    expect(disarmCode()).toContain("const id = null;");
  });
});

const ENTRY = {
  at: 120,
  kind: "prompt" as const,
  promptType: "confirmEx",
  title: "Delete Item",
  text: "Are you sure?",
  buttons: { accept: "Delete", cancel: "Cancel", extra1: "Later" },
  checkbox: "Don't ask again",
  pressed: "extra1" as const,
  result: { button: 2, ok: false, checked: true },
  notes: [],
};

function summary(over: Partial<HandlerSummary> = {}): HandlerSummary {
  return {
    id: 4,
    state: "ended",
    endReason: "done",
    armedAt: 1_000,
    expiresAt: 61_000,
    endedAt: 1_300,
    now: 2_000,
    options: { button: "extra1", count: 1, timeoutMs: 60_000 },
    remaining: 0,
    handled: [ENTRY],
    ignored: [],
    errors: [],
    ...over,
  };
}

describe("zotero_handle_dialog report text", () => {
  it("describes a handled dialog: what it said and what was pressed", () => {
    expect(formatEntry(ENTRY, 1)).toBe(
      [
        '1. confirmEx dialog "Delete Item" (opened 0.1 s after arming)',
        "   Message: Are you sure?",
        '   Buttons: accept "Delete", cancel "Cancel", extra1 "Later"',
        '   Checkbox: "Don\'t ask again"',
        "   Pressed: extra1 -> button 2, ok false, checkbox on",
      ].join("\n")
    );
  });

  it("reports a finished handler", () => {
    const text = formatSummary(summary());
    expect(text).toMatch(/^Dialog handler #4: finished, 1 of 1 handled \(0\.3 s after arming\)\.\n/);
    expect(text).toContain('Settings: press "extra1", any dialog.');
    expect(text).toContain('1. confirmEx dialog "Delete Item"');
  });

  it("reports an armed handler with the time left", () => {
    const text = formatSummary(summary({ state: "armed", endReason: null, endedAt: null, handled: [], remaining: 1 }));
    expect(text).toBe(
      'Dialog handler #4: armed, 0 of 1 handled, expires in 59 s.\nSettings: press "extra1", any dialog.'
    );
  });

  it("says when a handler expired unused, and lists what it left alone", () => {
    const text = formatSummary(
      summary({
        endReason: "expired",
        endedAt: 61_000,
        handled: [],
        options: { button: "accept", match: "beta", count: 1, timeoutMs: 60_000 },
        ignored: [{ kind: "prompt", promptType: "confirm", title: "alpha" }],
      })
    );
    expect(text).toContain("Dialog handler #4: expired, 0 of 1 handled (60 s after arming).");
    expect(text).toContain('Settings: press "accept", dialogs matching "beta".');
    expect(text).toContain("No dialog was handled.");
    expect(text).toContain('Left alone (did not match):\n1. confirm dialog "alpha"');
  });

  it("handles 'never armed' and the arm and handle_open replies", () => {
    expect(formatSummary(null)).toBe("No dialog handler has been armed in this Zotero window.");
    const armed = summary({ state: "armed", endReason: null, endedAt: null, handled: [] });
    expect(formatArmed(armed, summary({ id: 3 }))).toMatch(
      /^Armed dialog handler #4 for 60 s: it presses "extra1" on the next dialog\.\nIt replaces handler #3, which had handled 1 of 1\.\nNext: /
    );
    const options = { button: "accept" as const, text: "x", checkbox: true, match: "Delete", count: 2, timeoutMs: 5000 };
    expect(formatArmed(summary({ options }), null).split("\n")[0]).toBe(
      'Armed dialog handler #4 for 5 s: it presses "accept" on each of the next 2 dialogs whose title, message or URL contains "Delete" (typing "x" into a prompt, checkbox on).'
    );
    expect(formatHandleOpen({ open: 0, acted: [], skipped: [] })).toBe("No blocking dialog is open.");
    expect(formatHandleOpen({ open: 2, acted: [ENTRY], skipped: [{ kind: "window", url: "chrome://x/y.xhtml", title: "Y" }] })).toMatch(
      /^2 blocking dialog\(s\) open; answered 1\.\n1\. confirmEx dialog[\s\S]*Left open \(did not match, or over count\):\n1\. modal window chrome:\/\/x\/y\.xhtml "Y"$/
    );
  });
});

/** A client that records the code it is sent and answers with a JSON payload. */
function fakeClient(reply: (code: string) => EvaluateJSResponse): DialogClient & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async evaluateJS(code: string) {
      sent.push(code);
      return reply(code);
    },
    async gripToValueAsync(grip: GripValue) {
      return grip;
    },
  };
}
const json = (o: unknown): EvaluateJSResponse => ({ from: "console", result: JSON.stringify(o) as unknown as GripValue });

describe("zotero_handle_dialog handler (fake client)", () => {
  it("sends the snippet for each action", async () => {
    const client = fakeClient(() => json({ handler: summary(), replaced: null, open: 0, acted: [], skipped: [] }));
    await handleDialogWithClient(client, { action: "status" });
    await handleDialogWithClient(client, { action: "disarm" });
    await handleDialogWithClient(client, { action: "handle_open", button: "cancel" });
    expect(client.sent).toEqual([
      statusCode(),
      disarmCode(),
      handleOpenCode({ button: "cancel", count: 1, timeoutMs: 60_000 }),
    ]);
  });

  it("surfaces an exception from Zotero instead of reading the result", async () => {
    const client = fakeClient(() => ({
      from: "console",
      exception: { type: "object", class: "Error" } as unknown as GripValue,
      exceptionMessage: "ReferenceError: Zotero is not defined",
      result: { type: "undefined" } as unknown as GripValue,
    }));
    await expect(handleDialogWithClient(client, { action: "status" })).rejects.toThrow(
      /Dialog handler evaluation failed: ReferenceError: Zotero is not defined/
    );
  });

  it("disarms its own armed handler on release, and nothing once it ended", async () => {
    const now = Date.now();
    const armed = summary({ id: 9, state: "armed", endReason: null, endedAt: null, handled: [], expiresAt: now + 60_000 });
    const client = fakeClient((code) => json(code === statusCode() ? { handler: summary({ id: 9 }) } : { handler: armed, replaced: null }));
    await handleDialogWithClient(client, { action: "arm" });
    await releaseDialogHandler(client);
    expect(client.sent.at(-1)).toBe(disarmCode(9));

    // Once a status shows it ended, there is nothing left to release.
    await handleDialogWithClient(client, { action: "arm" });
    await handleDialogWithClient(client, { action: "status" });
    const before = client.sent.length;
    await releaseDialogHandler(client);
    expect(client.sent.length).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Live
// ─────────────────────────────────────────────────────────────────────────────
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
  console.warn(`[dialog.test] skipping live cases - ${ready.reason}`);
}
afterAll(() => {
  ready.client?.disconnect();
});

/** Evaluate a trigger and parse its JSON result. */
async function trigger(client: RDPClient, code: string): Promise<unknown> {
  const r = await client.evaluateJS(code);
  if (r.exception) throw new Error(`trigger threw: ${r.exceptionMessage}`);
  return JSON.parse(String(await client.gripToValueAsync(r.result as GripValue)));
}

const tool = async (client: DialogClient, args: Record<string, unknown>) =>
  (await handleDialogWithClient(client, args))[0].text;

/**
 * Leave no dialog behind. Both evaluations are sent before either is awaited:
 * while a dialog is up an evaluation's synchronous part runs but its result
 * is held until the dialog closes, so awaiting the first would wait forever.
 * The first arms a catch-all for dialogs a pending trigger still opens, the
 * second cancels the ones already open.
 */
async function safetyNet(client: RDPClient): Promise<void> {
  await Promise.all([
    handleDialogWithClient(client, { action: "arm", button: "cancel", count: 20, timeoutMs: 3000 }),
    handleDialogWithClient(client, { action: "handle_open", button: "cancel", count: 20 }),
  ]);
  await handleDialogWithClient(client, { action: "disarm" });
}

const W = "Zotero.getMainWindow()";
const PS = "Services.prompt";
/** confirmEx with three string buttons "Delete" / "Keep" / "Later" and an optional checkbox. */
const confirmEx = (title: string, extraFlags = "0", checkLabel = "null") => `(() => {
  const ps = ${PS};
  const flags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING + ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING
    + ps.BUTTON_POS_2 * ps.BUTTON_TITLE_IS_STRING + ${extraFlags};
  const check = { value: false };
  const r = ps.confirmEx(${W}, ${JSON.stringify(title)}, "Delete the thing?", flags, "Delete", "Keep", "Later", ${checkLabel}, check);
  return JSON.stringify({ r, checked: check.value });
})()`;

describe.skipIf(!ready.client)("zotero_handle_dialog (live Zotero, real blocking dialogs)", () => {
  let client: RDPClient;
  beforeAll(() => {
    client = ready.client as RDPClient;
  });
  afterEach(async () => {
    await safetyNet(client);
  }, 15_000);

  it("presses the armed confirmEx button and reports what the dialog said", async () => {
    expect(await tool(client, { button: "extra1" })).toMatch(/^Armed dialog handler #\d+ for 60 s: it presses "extra1" on the next dialog\./);
    expect(await trigger(client, confirmEx("i13 confirmEx", "0", '"Remember"'))).toEqual({ r: 2, checked: false });
    const status = await tool(client, { action: "status" });
    expect(status).toMatch(/^Dialog handler #\d+: finished, 1 of 1 handled/);
    expect(status).toContain('1. confirmEx dialog "i13 confirmEx"');
    expect(status).toContain("Message: Delete the thing?");
    expect(status).toContain('Buttons: accept "Delete", cancel "Keep", extra1 "Later"');
    expect(status).toContain('Checkbox: "Remember"');
    expect(status).toContain("Pressed: extra1 -> button 2, ok false, checkbox off");
  });

  it("maps accept/cancel to confirmEx 0/1 and confirm() true/false", async () => {
    const cases: Array<[string, string, unknown]> = [
      ["accept", confirmEx("i13 accept"), { r: 0, checked: false }],
      ["cancel", confirmEx("i13 cancel"), { r: 1, checked: false }],
      ["accept", `JSON.stringify(${PS}.confirm(${W}, "i13 confirm", "OK?"))`, true],
      ["cancel", `JSON.stringify(${W}.confirm("i13 window.confirm"))`, false],
    ];
    for (const [button, code, expected] of cases) {
      await tool(client, { button });
      expect(await trigger(client, code), `${button}: ${code}`).toEqual(expected);
    }
  });

  it("answers alert(), Services.prompt.alert and window.alert", async () => {
    await tool(client, { count: 2 });
    expect(await trigger(client, `(() => { ${PS}.alert(${W}, "i13 alert", "Hello"); ${W}.alert("i13 window.alert"); return "[]"; })()`)).toEqual([]);
    const status = await tool(client, { action: "status" });
    expect(status).toMatch(/finished, 2 of 2 handled/);
    expect(status).toContain('1. alert dialog "i13 alert"');
    expect(status).toContain("Message: i13 window.alert");
  });

  it("types into prompt() and sets its checkbox", async () => {
    await tool(client, { text: "typed by the handler", checkbox: true });
    expect(
      await trigger(client, `(() => {
        const value = { value: "initial" }, check = { value: false };
        const ok = ${PS}.prompt(${W}, "i13 prompt", "Name?", value, "Remember", check);
        return JSON.stringify({ ok, value: value.value, checked: check.value });
      })()`)
    ).toEqual({ ok: true, value: "typed by the handler", checked: true });
    expect(await tool(client, { action: "status" })).toContain(
      'Pressed: accept -> button 0, ok true, value "typed by the handler", checkbox on'
    );
  });

  it("answers window.prompt() and Services.prompt.select()", async () => {
    await tool(client, { text: "from window.prompt" });
    expect(await trigger(client, `JSON.stringify(${W}.prompt("i13 window.prompt", "default"))`)).toBe("from window.prompt");
    await tool(client, {});
    expect(
      await trigger(client, `(() => {
        const selected = { value: -1 };
        const ok = ${PS}.select(${W}, "i13 select", "Pick one", ["first", "second"], selected);
        return JSON.stringify({ ok, selected: selected.value });
      })()`)
    ).toEqual({ ok: true, selected: 0 });
    expect(await tool(client, { action: "status" })).toMatch(/1\. modal window chrome:\/\/global\/content\/selectDialog\.xhtml[\s\S]*Pressed: accept/);
  });

  it("closes a dialog that lacks the armed button (counts as cancel)", async () => {
    await tool(client, { button: "extra1" });
    expect(await trigger(client, `JSON.stringify(${PS}.confirm(${W}, "i13 two buttons", "OK?"))`)).toBe(false);
    expect(await tool(client, { action: "status" })).toContain('no "extra1" button, closed the dialog (counts as cancel)');
  });

  it("presses accept through BUTTON_DELAY_ENABLE", async () => {
    await tool(client, {});
    expect(await trigger(client, confirmEx("i13 delayed", "Services.prompt.BUTTON_DELAY_ENABLE"))).toEqual({ r: 0, checked: false });
    expect(await tool(client, { action: "status" })).toContain("skipped the button-enable delay");
  });

  it("answers a modal window.openDialog through its <dialog>", async () => {
    const open = `(() => {
      const io = { name: "i13 collection", libraryID: Zotero.Libraries.userLibraryID, parentCollectionID: null };
      ${W}.openDialog("chrome://zotero/content/newCollectionDialog.xhtml", "_blank", "chrome,modal,centerscreen,resizable=no", io);
      return JSON.stringify(io.dataOut || null);
    })()`;
    await tool(client, { button: "accept" });
    expect(await trigger(client, open)).toMatchObject({ name: "i13 collection" });
    expect(await tool(client, { action: "status" })).toMatch(
      /1\. modal window chrome:\/\/zotero\/content\/newCollectionDialog\.xhtml[\s\S]*Pressed: accept/
    );
    await tool(client, { button: "cancel" });
    expect(await trigger(client, open)).toBeNull();
  });

  it("answers only `count` dialogs and leaves the next one alone", async () => {
    await tool(client, { count: 1 });
    const both = trigger(
      client,
      `JSON.stringify([${PS}.confirm(${W}, "i13 first", "1?"), ${PS}.confirm(${W}, "i13 second", "2?")])`
    );
    await sleep(1500);
    // Still open 1.5 s later, untouched by the handler: cancel it from here.
    const rescue = await tool(client, { action: "handle_open", button: "cancel" });
    expect(rescue).toMatch(/^1 blocking dialog\(s\) open; answered 1\.\n1\. confirm dialog "i13 second"/);
    expect(await both).toEqual([true, false]);
    const status = await tool(client, { action: "status" });
    expect(status).toMatch(/finished, 1 of 1 handled/);
    expect(status).toContain('1. confirm dialog "i13 first"');
    expect(status).not.toContain("i13 second");
  });

  it("answers only dialogs that match, and leaves the others alone", async () => {
    await tool(client, { match: "BETA" });
    const both = trigger(
      client,
      `JSON.stringify([${PS}.confirm(${W}, "i13 alpha", "a?"), ${PS}.confirm(${W}, "i13 beta", "b?")])`
    );
    await sleep(1500);
    expect(await tool(client, { action: "handle_open", button: "cancel", match: "alpha" })).toContain(
      '1. confirm dialog "i13 alpha"'
    );
    expect(await both).toEqual([false, true]);
    const status = await tool(client, { action: "status" });
    expect(status).toContain('1. confirm dialog "i13 beta"');
    expect(status).toContain('Left alone (did not match):\n1. confirm dialog "i13 alpha"');
  });

  it("disarms itself after timeoutMs and then touches nothing", async () => {
    await tool(client, { timeoutMs: 1000 });
    await sleep(1300);
    expect(await tool(client, { action: "status" })).toMatch(/^Dialog handler #\d+: expired, 0 of 1 handled[\s\S]*No dialog was handled\.$/);
    const late = trigger(client, `JSON.stringify(${PS}.confirm(${W}, "i13 after expiry", "?"))`);
    await sleep(1000);
    expect(await tool(client, { action: "handle_open", button: "cancel" })).toContain('confirm dialog "i13 after expiry"');
    expect(await late).toBe(false);
  });

  it("replaces an armed handler, and disarms on request", async () => {
    const first = await tool(client, {});
    const id = Number(first.match(/#(\d+)/)?.[1]);
    expect(await tool(client, { button: "cancel" })).toContain(`It replaces handler #${id}, which had handled 0 of 1.`);
    expect(await tool(client, { action: "disarm" })).toMatch(new RegExp(`^Dialog handler #${id + 1}: disarmed, 0 of 1 handled`));
    expect(await tool(client, { action: "handle_open" })).toBe("No blocking dialog is open.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Over MCP stdio, the way a client uses it
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!ready.client)("zotero_handle_dialog over MCP stdio", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const start = async () => {
    const mcp = new Client({ name: "dialog-test", version: "0" });
    await mcp.connect(
      new StdioClientTransport({ command: process.execPath, args: [join(PKG_ROOT, "dist", "index.js")], env, stderr: "ignore" })
    );
    return mcp;
  };
  const call = async (mcp: Client, name: string, args: Record<string, unknown>) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
    const text = r.content.map((c) => c.text ?? "").join("\n");
    expect(r.isError, text).toBeFalsy();
    return text;
  };
  let client: RDPClient;

  beforeAll(async () => {
    client = ready.client as RDPClient;
    // The stdio server runs dist/, so rebuild it first (as db-stats.test does).
    try {
      execSync("npm run build", { cwd: PKG_ROOT, stdio: "pipe" });
    } catch (e) {
      const { stdout, stderr } = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`npm run build failed:\n${stdout ?? ""}${stderr ?? ""}`);
    }
    // A button whose click opens a blocking confirmEx, for zotero_click_element.
    await trigger(
      client,
      `(() => {
        const win = ${W};
        const b = win.document.createElementNS("http://www.w3.org/1999/xhtml", "button");
        b.id = "i13-dialog-trigger";
        b.addEventListener("click", () => {
          win.__i13DialogResult = ${PS}.confirmEx(win, "i13 clicked", "Opened by a click", ${PS}.STD_YES_NO_BUTTONS, null, null, null, null, {});
        });
        win.document.documentElement.append(b);
        return "true";
      })()`
    );
  }, 120_000);

  afterEach(async () => {
    await safetyNet(client);
  }, 15_000);

  afterAll(async () => {
    await client.evaluateJS(`(() => { const win = ${W}; win.document.getElementById("i13-dialog-trigger")?.remove(); delete win.__i13DialogResult; })()`);
  });

  it("arms, lets zotero_click_element open a confirmEx, and reports it", async () => {
    const mcp = await start();
    try {
      const tools = await mcp.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("zotero_handle_dialog");
      expect(await call(mcp, "zotero_handle_dialog", { button: "cancel", match: "i13 clicked" })).toMatch(/^Armed dialog handler/);
      expect(await call(mcp, "zotero_click_element", { selector: "#i13-dialog-trigger" })).toMatch(/^Clicked <button#i13-dialog-trigger>/);
      expect(await trigger(client, `JSON.stringify(${W}.__i13DialogResult)`)).toBe(1);
      const status = await call(mcp, "zotero_handle_dialog", { action: "status" });
      expect(status).toContain('1. confirmEx dialog "i13 clicked"');
      expect(status).toContain('Buttons: accept "Yes", cancel "No"');
      expect(status).toContain("Pressed: cancel -> button 1, ok false");
    } finally {
      await mcp.close();
    }
  }, 20_000);

  it("disarms the handler it armed when the client closes", async () => {
    const mcp = await start();
    const armed = await call(mcp, "zotero_handle_dialog", { timeoutMs: 60_000 });
    const id = Number(armed.match(/#(\d+)/)?.[1]);
    // close() ends stdin, waits up to 2 s, then signals the process. The
    // server releases its handler on stdin end; a Windows kill runs no handler.
    await mcp.close();
    expect(await tool(client, { action: "status" })).toMatch(new RegExp(`^Dialog handler #${id}: disarmed, 0 of 1 handled`));
  }, 20_000);
});
