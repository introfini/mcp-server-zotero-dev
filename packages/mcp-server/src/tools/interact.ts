/**
 * UI Interaction Tools
 *
 * Drive Zotero's chrome UI: click elements and type text. These complement the
 * read-only inspection tools (zotero_inspect_element / zotero_get_dom_tree /
 * zotero_screenshot) so an agent can act on what it sees — e.g. click a
 * toolbar/menu button, fill a preference field, or submit a search.
 *
 * Like every other UI tool, these route through the RDP console actor's
 * evaluateJS channel (no extra actor needed): the generated snippet resolves
 * the target window, finds the element, and dispatches the action in-context.
 *
 * Caveat: events we synthesize (mouseEvents / pressEnter) are dispatched from
 * page script, so they carry isTrusted === false. The default paths (el.click()
 * and input/change) cover the common cases; the synthesized variants are a
 * best-effort fallback and some native/XUL handlers deliberately ignore
 * untrusted events, so they may not trigger native behaviour.
 *
 * Keys can be trusted: zotero_press_keys goes through nsITextInputProcessor,
 * the interface Firefox's own test harness types with, and its events carry
 * isTrusted === true, so XUL <key> shortcuts (Ctrl+Shift+F, ...) fire and
 * fields react as to real typing (verified on Zotero 11.0-beta.3 / Firefox 153,
 * window in the background included). Mouse events cannot be: Firefox 153 has
 * no windowUtils.sendMouseEvent any more, and sendNativeMouseEvent drives the
 * real OS cursor, which a tool must not take over.
 *
 * Caveat: a NATIVE modal dialog (Services.prompt.confirmEx and friends) spins a
 * nested modal event loop that blocks the main thread evaluateJS runs on, so
 * these tools cannot reliably dismiss a *blocking* modal. They target in-window
 * elements and non-modal windows. Dismissing blocking native dialogs needs a
 * different mechanism and is intentionally out of scope here.
 */

import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { parseKeyCombo, type KeyCombo } from "./keys.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: resolve the target window inside the evaluated snippet.
// Mirrors the window-resolution used by the inspection tools.
// ─────────────────────────────────────────────────────────────────────────────
function windowResolver(windowId: number | undefined): string {
  return windowId !== undefined
    ? `
      const windows = Services.wm.getEnumerator(null);
      while (windows.hasMoreElements()) {
        const w = windows.getNext();
        if (w.docShell?.outerWindowID === ${windowId}) { win = w; break; }
      }
      if (!win) return JSON.stringify({ error: "Window not found: ${windowId}" });
    `
    : `
      win = Zotero.getMainWindow();
      if (!win) return JSON.stringify({ error: "Could not get main window" });
    `;
}

// Injected into the evaluated snippet. Resolves a selector light-DOM first,
// then falls back to piercing OPEN shadow roots — Zotero's XUL custom elements
// (search-textbox, many toolbar/menu widgets) keep their internals in shadow
// DOM, which a document-level querySelector can't reach. A single CSS selector
// can't cross a shadow boundary, so the fallback matches the (simple) selector
// inside every reachable shadow root. Returns an array; callers pick by index.
const DEEP_QUERY_HELPER = `
      function __deepQueryAll(root, sel) {
        const light = Array.from(root.querySelectorAll(sel));
        if (light.length) return light;
        const found = [];
        const visit = (node) => {
          if (node.shadowRoot) {
            found.push(...node.shadowRoot.querySelectorAll(sel));
            node.shadowRoot.querySelectorAll('*').forEach(visit);
          }
        };
        root.querySelectorAll('*').forEach(visit);
        return found;
      }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────
export const clickElementTool: Tool = {
  name: "zotero_click_element",
  description:
    "Click an element in a Zotero window by CSS selector (toolbar/menu button, " +
    "preference control, list row, etc.). Resolves light DOM first, then pierces " +
    "open shadow roots (Zotero's XUL custom elements keep internals in shadow " +
    "DOM). If the selector matches several elements, use index to pick one. By " +
    "default calls element.click() (which fires the XUL command for " +
    "buttons/menuitems); set mouseEvents=true to dispatch a synthesized " +
    "mousedown/mouseup/click sequence for content that needs real mouse events. " +
    "Cannot dismiss a BLOCKING native modal dialog (Services.prompt.confirmEx) — " +
    "see the module note.",
  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for the element to click",
      },
      windowId: {
        type: "number",
        description: "Window outerWindowID (optional, defaults to main window)",
      },
      index: {
        type: "number",
        description:
          "Which match to click when the selector matches several (0-based, default 0)",
        default: 0,
      },
      mouseEvents: {
        type: "boolean",
        description:
          "Dispatch synthesized mousedown/mouseup/click instead of element.click() " +
          "(default false). Use for HTML content that needs real mouse events. Note: " +
          "these events are untrusted (isTrusted=false); some native/XUL handlers " +
          "ignore them, so prefer the default element.click() for buttons/menuitems.",
        default: false,
      },
    },
    required: ["selector"],
  },
};

export const sendKeysTool: Tool = {
  name: "zotero_send_keys",
  description:
    "Type text into an element in a Zotero window (an input/textarea or any " +
    "contenteditable). If a selector is given the element is focused first " +
    "(light DOM, then open shadow roots); otherwise the window's active element " +
    "is used. Fires input/change events so listeners react. Optionally clear " +
    "first and/or press Enter afterwards. Note: a few widgets (e.g. Zotero's " +
    "quick-search) only fully react to their own command handler, not a raw " +
    "input event — prefer a direct field where possible.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Text to type into the element",
      },
      selector: {
        type: "string",
        description:
          "CSS selector for the target field (optional; defaults to the active element)",
      },
      windowId: {
        type: "number",
        description: "Window outerWindowID (optional, defaults to main window)",
      },
      clear: {
        type: "boolean",
        description: "Clear the field before typing (default false)",
        default: false,
      },
      pressEnter: {
        type: "boolean",
        description:
          "Dispatch an Enter keydown/keypress/keyup after typing (default false). " +
          "Note: these events are untrusted (isTrusted=false) and some widgets " +
          "ignore them — a direct input + change is more reliable where it fits.",
        default: false,
      },
    },
    required: ["text"],
  },
};

export const pressKeysTool: Tool = {
  name: "zotero_press_keys",
  description:
    "Type text and press keys in a Zotero window as a user would: the events are " +
    "TRUSTED (isTrusted=true), so keyboard shortcuts defined in Zotero's windows " +
    "fire (e.g. 'Accel+Shift+F'), and fields react as to real typing. Text is typed " +
    "first, then each key combination is pressed in order. If a selector is given, " +
    "that element is focused first (light DOM, then open shadow roots). Like the " +
    "other UI tools it cannot get past a BLOCKING native modal dialog that a key " +
    "may open (see the module note).",
  inputSchema: {
    type: "object",
    properties: {
      keys: {
        description:
          "A key combination or a list of them, pressed in order: 'Enter', 'Escape', " +
          "'Ctrl+Shift+F', 'Accel+W' (Accel = Cmd on macOS, Ctrl elsewhere), 'ArrowDown', " +
          "'F2', 'Shift+Tab'. Modifiers: Ctrl, Shift, Alt, Meta/Cmd, Accel.",
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      },
      text: {
        type: "string",
        description: "Text to type, one key per character, before the keys are pressed",
      },
      selector: {
        type: "string",
        description: "CSS selector of the element to focus first (optional; else the focused element)",
      },
      windowId: {
        type: "number",
        description: "Window outerWindowID (optional, defaults to main window)",
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────────────────────────────────────
export async function handleClickElement(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const selector = args.selector as string;
  const windowId = args.windowId as number | undefined;
  const index = (args.index as number) ?? 0;
  const mouseEvents = Boolean(args.mouseEvents);

  if (!selector) {
    throw new Error("Missing required parameter: selector");
  }

  // Imported lazily so tests can load this module without starting the server (#33).
  const { getRdpClient } = await import("../index.js");
  const client = await getRdpClient();

  const code = `
    (() => {
      let win;
      ${windowResolver(windowId)}
      ${DEEP_QUERY_HELPER}

      const els = __deepQueryAll(win.document, ${JSON.stringify(selector)});
      if (els.length === 0) {
        return JSON.stringify({ error: "Element not found: " + ${JSON.stringify(selector)} });
      }
      const el = els[${index}];
      if (!el) {
        return JSON.stringify({ error: "No element at index ${index} (matched " + els.length + ")" });
      }

      try { el.scrollIntoView({ block: "center" }); } catch (e) {}

      ${
        mouseEvents
          ? `
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        for (const type of ["mousedown", "mouseup", "click"]) {
          el.dispatchEvent(new win.MouseEvent(type, {
            bubbles: true, cancelable: true, view: win,
            clientX: cx, clientY: cy, button: 0
          }));
        }
      `
          : `
        el.click();
      `
      }

      const label = (el.getAttribute && (el.getAttribute("label") || el.getAttribute("aria-label")))
        || (el.textContent || "").slice(0, 60).trim();
      return JSON.stringify({
        ok: true,
        matched: els.length,
        clicked: { tagName: el.tagName.toLowerCase(), id: el.id || null, label: label || null }
      });
    })()
  `;

  const response = await client.evaluateJS(code);
  if (response.exception) {
    throw new Error(`Click failed: ${response.exceptionMessage}`);
  }

  const jsonString = await client.gripToValueAsync(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Click failed: received undefined result from Zotero");
  }

  const result = JSON.parse(String(jsonString)) as {
    ok?: boolean;
    matched?: number;
    clicked?: { tagName: string; id: string | null; label: string | null };
    error?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  const c = result.clicked;
  const desc = c ? `<${c.tagName}${c.id ? `#${c.id}` : ""}>${c.label ? ` "${c.label}"` : ""}` : selector;
  const extra = result.matched && result.matched > 1 ? ` (matched ${result.matched}, clicked index ${index})` : "";
  return [{ type: "text", text: `Clicked ${desc}${extra}` }];
}

export async function handleSendKeys(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const text = args.text as string;
  const selector = args.selector as string | undefined;
  const windowId = args.windowId as number | undefined;
  const clear = Boolean(args.clear);
  const pressEnter = Boolean(args.pressEnter);

  if (typeof text !== "string") {
    throw new Error("Missing required parameter: text");
  }

  // Imported lazily so tests can load this module without starting the server (#33).
  const { getRdpClient } = await import("../index.js");
  const client = await getRdpClient();

  const code = `
    (() => {
      let win;
      ${windowResolver(windowId)}
      ${selector ? DEEP_QUERY_HELPER : ""}

      let el;
      ${
        selector
          ? `
        el = __deepQueryAll(win.document, ${JSON.stringify(selector)})[0];
        if (!el) return JSON.stringify({ error: "Element not found: " + ${JSON.stringify(selector)} });
      `
          : `
        el = win.document.activeElement;
        if (!el) return JSON.stringify({ error: "No active element to type into" });
      `
      }

      try { el.focus(); } catch (e) {}

      const text = ${JSON.stringify(text)};
      const isInput = ("value" in el) && typeof el.value === "string";

      if (isInput) {
        if (${clear ? "true" : "false"}) el.value = "";
        el.value = (el.value || "") + text;
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        if (${clear ? "true" : "false"}) el.textContent = "";
        el.textContent = (el.textContent || "") + text;
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
      } else {
        return JSON.stringify({ error: "Target is not a text input or contenteditable element" });
      }

      ${
        pressEnter
          ? `
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new win.KeyboardEvent(type, {
            bubbles: true, cancelable: true,
            key: "Enter", code: "Enter", keyCode: 13, which: 13
          }));
        }
      `
          : ""
      }

      return JSON.stringify({
        ok: true,
        tagName: el.tagName.toLowerCase(),
        id: el.id || null,
        value: isInput ? String(el.value).slice(0, 120) : undefined
      });
    })()
  `;

  const response = await client.evaluateJS(code);
  if (response.exception) {
    throw new Error(`Send keys failed: ${response.exceptionMessage}`);
  }

  const jsonString = await client.gripToValueAsync(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Send keys failed: received undefined result from Zotero");
  }

  const result = JSON.parse(String(jsonString)) as {
    ok?: boolean;
    tagName?: string;
    id?: string | null;
    value?: string;
    error?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  const where = `<${result.tagName}${result.id ? `#${result.id}` : ""}>`;
  const valuePart = result.value !== undefined ? ` value now: "${result.value}"` : "";
  const enterPart = pressEnter ? " + Enter" : "";
  return [
    { type: "text", text: `Typed into ${where}${enterPart}.${valuePart}` },
  ];
}

/** The in-window code for zotero_press_keys; exported for tests. */
export function pressKeysCode(
  combos: KeyCombo[],
  text: string | undefined,
  selector: string | undefined,
  windowId: number | undefined
): string {
  return `
    (() => {
      let win;
      ${windowResolver(windowId)}
      ${selector ? DEEP_QUERY_HELPER : ""}

      try { win.focus(); } catch (e) {}
      ${
        selector
          ? `
        const target = __deepQueryAll(win.document, ${JSON.stringify(selector)})[0];
        if (!target) return JSON.stringify({ error: "Element not found: " + ${JSON.stringify(selector)} });
        try { target.focus(); } catch (e) {}
      `
          : ""
      }

      const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
      if (!tip.beginInputTransactionForTests(win)) {
        return JSON.stringify({ error: "Could not start keyboard input in this window (another input transaction is active)" });
      }
      const isMac = Services.appinfo.OS === "Darwin";
      const MOD = {
        Control: ["Control", "ControlLeft", 17],
        Shift: ["Shift", "ShiftLeft", 16],
        Alt: ["Alt", "AltLeft", 18],
        Meta: ["Meta", "MetaLeft", 91],
      };
      const ev = (key, code, keyCode) => new win.KeyboardEvent("", { key, code, keyCode });

      const text = ${JSON.stringify(text ?? "")};
      for (const ch of text) {
        tip.keydown(ev(ch, "", 0));
        tip.keyup(ev(ch, "", 0));
      }
      const combos = ${JSON.stringify(combos)};
      for (const c of combos) {
        const mods = c.modifiers.map((m) => (m === "Accel" ? (isMac ? "Meta" : "Control") : m));
        for (const m of mods) tip.keydown(ev(...MOD[m]));
        tip.keydown(ev(c.key.key, c.key.code, c.key.keyCode));
        tip.keyup(ev(c.key.key, c.key.code, c.key.keyCode));
        for (const m of mods.slice().reverse()) tip.keyup(ev(...MOD[m]));
      }

      const active = win.document.activeElement;
      return JSON.stringify({
        ok: true,
        typed: [...text].length,
        pressed: combos.length,
        active: active ? { tagName: active.tagName.toLowerCase(), id: active.id || null } : null
      });
    })()
  `;
}

export async function handlePressKeys(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const rawKeys = args.keys;
  const keyList =
    rawKeys === undefined ? [] : Array.isArray(rawKeys) ? rawKeys.map(String) : [String(rawKeys)];
  const text = typeof args.text === "string" ? args.text : undefined;
  const selector = args.selector as string | undefined;
  const windowId = args.windowId as number | undefined;

  if (!keyList.length && !text) {
    throw new Error("Nothing to press: give keys (e.g. 'Enter', 'Ctrl+Shift+F') and/or text");
  }
  const combos = keyList.map(parseKeyCombo);

  // Imported lazily so tests can load this module without starting the server (#33).
  const { getRdpClient } = await import("../index.js");
  const client = await getRdpClient();
  const response = await client.evaluateJS(pressKeysCode(combos, text, selector, windowId));
  if (response.exception) {
    throw new Error(`Press keys failed: ${response.exceptionMessage}`);
  }

  const jsonString = await client.gripToValueAsync(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Press keys failed: received undefined result from Zotero");
  }

  const result = JSON.parse(String(jsonString)) as {
    ok?: boolean;
    typed?: number;
    pressed?: number;
    active?: { tagName: string; id: string | null } | null;
    error?: string;
  };
  if (result.error) {
    throw new Error(result.error);
  }

  const parts: string[] = [];
  if (result.typed) parts.push(`typed ${result.typed} character(s)`);
  if (result.pressed) parts.push(`pressed ${keyList.join(", ")}`);
  const focus = result.active ? ` Focus now on <${result.active.tagName}${result.active.id ? `#${result.active.id}` : ""}>.` : "";
  return [{ type: "text", text: `Trusted keys: ${parts.join(", then ")}.${focus}` }];
}
