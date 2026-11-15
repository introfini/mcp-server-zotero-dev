/**
 * zotero_handle_dialog - answer a BLOCKING native modal dialog (#13).
 *
 * Services.prompt.alert/confirm/confirmEx/prompt, window.alert/confirm/prompt
 * and window.openDialog(..., "modal") all spin a nested event loop on the
 * main thread and only return once the dialog is closed. The tool call that
 * triggered one (zotero_click_element, zotero_execute_js, ...) therefore does
 * not return while the dialog is up, so it cannot be followed by a call that
 * clicks the dialog's button. The answer has to be in place BEFORE the
 * trigger: "arm" registers a one-shot handler inside Zotero, the trigger
 * opens the dialog, the handler presses the button as the dialog loads, and
 * the trigger call returns normally. "status" then reports what the dialog
 * said and what was pressed.
 *
 * No bridge-plugin change is needed. The handler is installed by an ordinary
 * evaluateJS snippet: it registers an nsIObserver for "common-dialog-loaded"
 * (notified by CommonDialog.sys.mjs at the end of onLoad, subject = the
 * commonDialog.xhtml window, whose `Dialog` global holds args and buttons)
 * and for "domwindowopened" (nsWindowWatcher; subject = the new window,
 * still about:blank, used for modal windows that are not prompts). Zotero
 * registers neither `gDialogBox` nor the "Prompt" JSWindowActor, so every
 * prompt falls back to Prompter's openWindowPrompt(): a separate window-modal
 * commonDialog.xhtml window opened with Services.ww.openWindow(..., "modal").
 *
 * What runs inside the nested modal loop decides how the handler is written.
 * Measured on Zotero 11.0-beta.4 (Firefox 153) and 10.0.8 (Firefox 140):
 * - observer notifications, Services.tm.dispatchToMainThread runnables and
 *   nsITimer callbacks (Timer.sys.mjs) run;
 * - the opener window's own setTimeout does NOT (a modal suspends its
 *   opener), and promise reactions (microtasks) do NOT run until the dialog
 *   closes. So the handler uses runnables and Timer.sys.mjs, never promises
 *   or the main window's timers.
 * - An evaluateJS sent while a dialog is up DOES run its synchronous part;
 *   only its result is held, because the console actor emits every result
 *   from a promise continuation. That is what "handle_open" relies on: it
 *   answers a dialog that is already open, and its result arrives once that
 *   dialog has closed.
 *
 * The pure parts (argument parsing, the evaluated snippets, the report text)
 * are exported for unit tests; getRdpClient is imported lazily so loading
 * this module does not start the MCP server (index.ts runs main() on import,
 * see #33).
 */
import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { EvaluateJSResponse, GripValue } from "../rdp/index.js";

export const DIALOG_ACTIONS = ["arm", "status", "disarm", "handle_open"] as const;
export type DialogAction = (typeof DIALOG_ACTIONS)[number];

/** The four buttons of a XUL <dialog>; CommonDialog maps them to button0..3. */
export const DIALOG_BUTTONS = ["accept", "cancel", "extra1", "extra2"] as const;
export type DialogButton = (typeof DIALOG_BUTTONS)[number];

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_COUNT = 20;

/** Where the armed handler lives: a property of the evaluation global (the main window). */
export const STATE_KEY = "__zoteroDevDialogHandler";

export const handleDialogTool: Tool = {
  name: "zotero_handle_dialog",
  description:
    "Answer a BLOCKING native modal dialog: Services.prompt alert/confirm/confirmEx/prompt/select, " +
    "window.alert/confirm/prompt, or a modal window.openDialog. Such a dialog blocks Zotero's main " +
    "thread, so the call that opens it only returns once it is closed. ARM FIRST: call with action " +
    '"arm" (default) and the button to press, THEN run the action that opens the dialog ' +
    "(zotero_click_element, zotero_execute_js, ...); the handler presses the button as the dialog " +
    'loads and that call returns normally. Then call with action "status" to see what the dialog ' +
    "said and what was pressed. The handler disarms itself after `count` dialogs or `timeoutMs`; " +
    'until then it answers ANY dialog that matches, so keep it short and use `match`. "disarm" ' +
    'stops it. "handle_open" answers a dialog that is already open (recovery when nothing was ' +
    "armed; it only gets through once the call that opened the dialog has returned or timed out). " +
    "Return values: confirmEx gives the button number (accept 0, cancel 1, extra1 2), " +
    "confirm/prompt give true for accept.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...DIALOG_ACTIONS],
        description:
          '"arm" (default): handle the next dialog(s); "status": report the armed handler; ' +
          '"disarm": stop it; "handle_open": answer a dialog that is open right now',
        default: "arm",
      },
      button: {
        type: "string",
        enum: [...DIALOG_BUTTONS],
        description:
          'Button to press (default "accept"): accept = OK / button 0, cancel = button 1, ' +
          "extra1 = button 2, extra2 = button 3. A dialog without that button is closed, which " +
          "counts as cancel.",
        default: "accept",
      },
      text: {
        type: "string",
        description: "Prompt dialogs only: typed into the text field before the button is pressed",
      },
      checkbox: {
        type: "boolean",
        description: 'Prompt dialogs only: state of the dialog\'s checkbox (e.g. "Don\'t ask again")',
      },
      match: {
        type: "string",
        description:
          "Only answer dialogs whose title, message or URL contains this text (case-insensitive); " +
          "other dialogs are left alone. Default: any dialog.",
      },
      count: {
        type: "number",
        description: `How many dialogs to answer before disarming (default 1, max ${MAX_COUNT}). For "handle_open": how many open dialogs to answer, newest first.`,
        default: 1,
      },
      timeoutMs: {
        type: "number",
        description: `"arm" only: disarm after this many ms even if no dialog came (default ${DEFAULT_TIMEOUT_MS}, ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS})`,
        default: DEFAULT_TIMEOUT_MS,
      },
    },
    required: [],
  },
};

export interface DialogOptions {
  button: DialogButton;
  text?: string;
  checkbox?: boolean;
  match?: string;
  count: number;
  timeoutMs: number;
}

export interface DialogRequest {
  action: DialogAction;
  options: DialogOptions;
}

/** Validate the tool arguments. Throws with a message saying what to change. */
export function parseDialogArgs(args: Record<string, unknown>): DialogRequest {
  const action = (args.action ?? "arm") as DialogAction;
  if (!DIALOG_ACTIONS.includes(action)) {
    throw new Error(`Unknown action "${String(args.action)}". Use one of: ${DIALOG_ACTIONS.join(", ")}`);
  }
  const button = (args.button ?? "accept") as DialogButton;
  if (!DIALOG_BUTTONS.includes(button)) {
    throw new Error(`Unknown button "${String(args.button)}". Use one of: ${DIALOG_BUTTONS.join(", ")}`);
  }
  const count = args.count ?? 1;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new Error(`count must be an integer from 1 to ${MAX_COUNT} (got ${String(args.count)})`);
  }
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be a number from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} (got ${String(args.timeoutMs)})`
    );
  }
  const options: DialogOptions = { button, count, timeoutMs: Math.round(timeoutMs) };
  if (args.text !== undefined) {
    if (typeof args.text !== "string") throw new Error("text must be a string");
    options.text = args.text;
  }
  if (args.checkbox !== undefined) {
    if (typeof args.checkbox !== "boolean") throw new Error("checkbox must be true or false");
    options.checkbox = args.checkbox;
  }
  if (args.match !== undefined) {
    if (typeof args.match !== "string" || args.match.trim() === "") {
      throw new Error("match must be a non-empty string");
    }
    options.match = args.match;
  }
  return { action, options };
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluated in Zotero (the console actor's target, i.e. the main window).
// Inside a nested modal loop promise reactions do not run and the opener's
// timers are suspended: everything below is synchronous, deferred only with
// Services.tm.dispatchToMainThread or Timer.sys.mjs (nsITimer).
// ─────────────────────────────────────────────────────────────────────────────
const RUNTIME = `
  const KEY = ${JSON.stringify(STATE_KEY)};
  const COMMON_DIALOG = "chrome://global/content/commonDialog.xhtml";
  const BUTTONS = ["accept", "cancel", "extra1", "extra2"];
  const TOPICS = ["common-dialog-loaded", "domwindowopened"];
  const Timer = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const clip = (s, n) => {
    s = String(s == null ? "" : s).replace(/\\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "\\u2026" : s;
  };
  // chromeFlags is already set at "domwindowopened", before the document loads.
  const isModal = (win) => {
    try {
      const appWin = win.docShell.treeOwner
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIAppWindow);
      return (appWin.chromeFlags & Ci.nsIWebBrowserChrome.CHROME_MODAL) !== 0;
    } catch (e) {
      return false;
    }
  };
  // kind "prompt": a CommonDialog (alert/confirm/confirmEx/prompt...);
  // kind "window": any other modal window, answered through its <dialog>.
  const describe = (win) => {
    const doc = win.document;
    if (doc.documentURI === COMMON_DIALOG && win.Dialog) {
      const args = win.Dialog.args, ui = win.Dialog.ui;
      const buttons = {};
      [ui.button0, ui.button1, ui.button2, ui.button3].forEach((b, i) => {
        if (b && !b.hidden) buttons[BUTTONS[i]] = b.label;
      });
      const info = { kind: "prompt", promptType: args.promptType, title: clip(args.title, 200), text: clip(args.text, 2000), buttons };
      if (args.checkLabel) info.checkbox = clip(args.checkLabel, 200);
      return info;
    }
    const dlg = doc.querySelector("dialog");
    const buttons = {};
    if (dlg && dlg.getButton) {
      for (const name of BUTTONS) {
        const b = dlg.getButton(name);
        if (b && !b.hidden) buttons[name] = b.label || name;
      }
    }
    return { kind: "window", url: doc.documentURI, title: clip(doc.title, 200), text: clip(dlg ? dlg.textContent : "", 500), buttons };
  };
  const matches = (info, needle) => {
    if (!needle) return true;
    needle = needle.toLowerCase();
    return [info.title, info.text, info.url].some((s) => typeof s === "string" && s.toLowerCase().includes(needle));
  };
  // Press the button. Fills entry.pressed / entry.result / entry.notes.
  const act = (win, info, opts, entry) => {
    const want = opts.button;
    if (info.kind === "prompt") {
      const D = win.Dialog, ui = D.ui;
      if (opts.text != null) {
        if (!ui.loginContainer.hidden) { ui.loginTextbox.value = opts.text; entry.textSet = true; }
        else entry.notes.push("no text field, text not used");
      }
      if (opts.checkbox != null) {
        if (!ui.checkboxContainer.hidden) { ui.checkbox.checked = opts.checkbox; D.onCheckbox(); entry.checkboxSet = true; }
        else entry.notes.push("no checkbox, checkbox not used");
      }
      const btn = { accept: ui.button0, cancel: ui.button1, extra1: ui.button2, extra2: ui.button3 }[want];
      if (btn && !btn.hidden) {
        // BUTTON_DELAY_ENABLE keeps accept/extra disabled until the dialog has
        // been the active window for security.dialog_enable_delay ms, which
        // may never happen while Zotero is in the background.
        if (btn.disabled && D.delayHelper) {
          D.setButtonsEnabledState(true);
          entry.notes.push("skipped the button-enable delay");
        }
        btn.click();
        entry.pressed = want;
      } else {
        win.close();
        entry.pressed = "close";
        entry.notes.push("no \\"" + want + "\\" button, closed the dialog (counts as cancel)");
      }
      entry.result = { button: D.args.buttonNumClicked, ok: D.args.ok };
      if (D.args.promptType === "prompt") entry.result.value = D.args.value;
      if (D.args.checkLabel) entry.result.checked = D.args.checked;
    } else {
      if (opts.text != null || opts.checkbox != null) entry.notes.push("text/checkbox apply to prompt dialogs only, not used");
      const dlg = win.document.querySelector("dialog");
      const btn = dlg && dlg.getButton ? dlg.getButton(want) : null;
      if (dlg && want === "accept" && dlg.acceptDialog) { dlg.acceptDialog(); entry.pressed = want; }
      else if (dlg && want === "cancel" && dlg.cancelDialog) { dlg.cancelDialog(); entry.pressed = want; }
      else if (btn && !btn.hidden) { btn.click(); entry.pressed = want; }
      else {
        win.close();
        entry.pressed = "close";
        entry.notes.push(dlg ? "no \\"" + want + "\\" button, closed the window" : "no <dialog> element, closed the window");
      }
    }
    // A dialog we answered must not stay open (a validation handler may have
    // vetoed the button): it would block the main thread, and the caller's
    // tool call with it.
    Timer.setTimeout(() => {
      if (!win.closed) {
        entry.forcedClose = true;
        entry.notes.push("still open 2 s after the button was pressed, closed it");
        win.close();
      }
    }, 2000);
  };
`;

/** "arm": install the handler, replacing (and reporting) an armed one. */
export function armCode(options: DialogOptions): string {
  return `(() => {
  ${RUNTIME}
  const opts = ${JSON.stringify(options)};
  const g = globalThis;
  const prev = g[KEY];
  let replaced = null;
  if (prev && prev.state === "armed") { prev.end("replaced"); replaced = prev.summary(); }
  const h = {
    id: ((prev && prev.id) || 0) + 1, opts, state: "armed", armedAt: Date.now(),
    remaining: opts.count, handled: [], ignored: [], errors: [], endReason: null, endedAt: null,
  };
  h.expiresAt = h.armedAt + opts.timeoutMs;
  h.summary = () => ({
    id: h.id, state: h.state, endReason: h.endReason, armedAt: h.armedAt, expiresAt: h.expiresAt,
    endedAt: h.endedAt, now: Date.now(), options: h.opts, remaining: h.remaining,
    handled: h.handled, ignored: h.ignored, errors: h.errors,
  });
  h.end = (reason) => {
    if (h.state !== "armed") return;
    h.state = "ended"; h.endReason = reason; h.endedAt = Date.now();
    for (const t of TOPICS) { try { Services.obs.removeObserver(h, t); } catch (e) {} }
    Timer.clearTimeout(h.timer);
    try { g.removeEventListener("unload", h.onUnload); } catch (e) {}
  };
  const take = (win) => {
    if (h.state !== "armed") return;
    let info;
    try { info = describe(win); } catch (e) { h.errors.push("describe: " + e); return; }
    if (!matches(info, opts.match)) {
      if (h.ignored.length < 20) h.ignored.push({ at: Date.now() - h.armedAt, kind: info.kind, promptType: info.promptType, title: info.title, url: info.url });
      return;
    }
    h.remaining--;
    if (h.remaining <= 0) h.end("done");
    const entry = Object.assign({ at: Date.now() - h.armedAt }, info, { notes: [] });
    h.handled.push(entry);
    // Next tick: let the dialog finish its own load handlers first.
    Services.tm.dispatchToMainThread(() => {
      try { act(win, info, opts, entry); }
      catch (e) { entry.notes.push("error: " + e); try { win.close(); } catch (e2) {} }
    });
  };
  h.observe = (subject, topic) => {
    try {
      if (topic === "common-dialog-loaded") take(subject);
      else if (topic === "domwindowopened" && isModal(subject)) {
        // Prompts are taken by common-dialog-loaded; other modal windows once loaded.
        subject.addEventListener("load", () => {
          if (subject.document.documentURI !== COMMON_DIALOG) Services.tm.dispatchToMainThread(() => take(subject));
        }, { once: true });
      }
    } catch (e) { h.errors.push(topic + ": " + e); }
  };
  h.onUnload = () => h.end("window-closed");
  h.timer = Timer.setTimeout(() => h.end("expired"), opts.timeoutMs);
  g.addEventListener("unload", h.onUnload);
  for (const t of TOPICS) Services.obs.addObserver(h, t);
  g[KEY] = h;
  return JSON.stringify({ handler: h.summary(), replaced });
})()`;
}

/** "status": the current or last handler, untouched. */
export function statusCode(): string {
  return `(() => {
  const h = globalThis[${JSON.stringify(STATE_KEY)}];
  return JSON.stringify({ handler: h ? h.summary() : null });
})()`;
}

/** "disarm": end the handler; with an id, only if it is still that handler. */
export function disarmCode(id?: number): string {
  return `(() => {
  const h = globalThis[${JSON.stringify(STATE_KEY)}];
  const id = ${id === undefined ? "null" : JSON.stringify(id)};
  if (h && h.state === "armed" && (id === null || h.id === id)) h.end("disarmed");
  return JSON.stringify({ handler: h ? h.summary() : null });
})()`;
}

/** "handle_open": answer up to `count` open modal dialogs, newest first. */
export function handleOpenCode(options: DialogOptions): string {
  return `(() => {
  ${RUNTIME}
  const opts = ${JSON.stringify(options)};
  const open = [];
  for (const w of Services.wm.getEnumerator(null)) if (!w.closed && isModal(w)) open.push(w);
  open.reverse(); // newest first: a dialog opened from a dialog has to close before its parent
  const acted = [], skipped = [];
  for (const w of open) {
    if (acted.length >= opts.count) break;
    let info;
    try { info = describe(w); } catch (e) { skipped.push({ error: String(e) }); continue; }
    if (!matches(info, opts.match)) { skipped.push({ kind: info.kind, promptType: info.promptType, title: info.title, url: info.url }); continue; }
    const entry = Object.assign({}, info, { notes: [] });
    try { act(w, info, opts, entry); } catch (e) { entry.notes.push("error: " + e); }
    acted.push(entry);
  }
  return JSON.stringify({ open: open.length, acted, skipped });
})()`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────────────
export interface DialogEntry {
  at?: number;
  kind: "prompt" | "window";
  promptType?: string;
  title?: string;
  text?: string;
  url?: string;
  buttons?: Partial<Record<DialogButton, string>>;
  checkbox?: string;
  pressed?: DialogButton | "close";
  result?: { button?: number; ok?: boolean; value?: string; checked?: boolean };
  textSet?: boolean;
  checkboxSet?: boolean;
  forcedClose?: boolean;
  notes?: string[];
  error?: string;
}

export interface HandlerSummary {
  id: number;
  state: "armed" | "ended";
  endReason: "done" | "expired" | "disarmed" | "replaced" | "window-closed" | null;
  armedAt: number;
  expiresAt: number;
  endedAt: number | null;
  now: number;
  options: DialogOptions;
  remaining: number;
  handled: DialogEntry[];
  ignored: DialogEntry[];
  errors: string[];
}

function quote(s: string | undefined): string {
  return JSON.stringify(s ?? "");
}

function settings(o: DialogOptions): string {
  const parts = [`press "${o.button}"`, o.match ? `dialogs matching ${quote(o.match)}` : "any dialog"];
  if (o.text !== undefined) parts.push(`text ${quote(o.text)}`);
  if (o.checkbox !== undefined) parts.push(`checkbox ${o.checkbox ? "on" : "off"}`);
  return parts.join(", ");
}

function seconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 100) / 10)} s`;
}

/** One dialog, several lines, numbered. */
export function formatEntry(e: DialogEntry, n: number): string {
  const what = e.kind === "prompt" ? `${e.promptType ?? "prompt"} dialog` : `modal window ${e.url ?? ""}`.trim();
  const lines = [
    `${n}. ${what}${e.title ? ` ${quote(e.title)}` : ""}${e.at !== undefined ? ` (opened ${seconds(e.at)} after arming)` : ""}`,
  ];
  if (e.text) lines.push(`   Message: ${e.text}`);
  const buttons = Object.entries(e.buttons ?? {}).map(([k, v]) => `${k} ${quote(v)}`);
  if (buttons.length) lines.push(`   Buttons: ${buttons.join(", ")}`);
  if (e.checkbox) lines.push(`   Checkbox: ${quote(e.checkbox)}`);
  if (e.pressed) {
    const r = e.result;
    const res: string[] = [];
    if (r?.button !== undefined) res.push(`button ${r.button}`);
    if (r?.ok !== undefined) res.push(`ok ${r.ok}`);
    if (r?.value !== undefined) res.push(`value ${quote(r.value)}`);
    if (r?.checked !== undefined) res.push(`checkbox ${r.checked ? "on" : "off"}`);
    lines.push(`   Pressed: ${e.pressed === "close" ? "closed the dialog" : e.pressed}${res.length ? ` -> ${res.join(", ")}` : ""}`);
  } else {
    lines.push("   Pressed: nothing yet");
  }
  if (e.forcedClose) lines.push("   The dialog did not close after the button; it was closed.");
  if (e.notes?.length) lines.push(`   Notes: ${e.notes.join("; ")}`);
  if (e.error) lines.push(`   Error: ${e.error}`);
  return lines.join("\n");
}

const END_TEXT: Record<string, string> = {
  done: "finished",
  expired: "expired",
  disarmed: "disarmed",
  replaced: "replaced by a newer handler",
  "window-closed": "ended: the window it ran in was closed",
};

/** The status/disarm report for one handler. */
export function formatSummary(s: HandlerSummary | null): string {
  if (!s) return "No dialog handler has been armed in this Zotero window.";
  const handled = s.handled.length;
  const head =
    s.state === "armed"
      ? `Dialog handler #${s.id}: armed, ${handled} of ${s.options.count} handled, expires in ${seconds(s.expiresAt - s.now)}.`
      : `Dialog handler #${s.id}: ${END_TEXT[s.endReason ?? ""] ?? s.endReason}, ${handled} of ${s.options.count} handled` +
        (s.endedAt ? ` (${seconds(s.endedAt - s.armedAt)} after arming).` : ".");
  const lines = [head, `Settings: ${settings(s.options)}.`];
  if (handled) {
    lines.push("Handled:");
    s.handled.forEach((e, i) => lines.push(formatEntry(e, i + 1)));
  } else if (s.state === "ended") {
    lines.push("No dialog was handled.");
  }
  if (s.ignored.length) {
    lines.push("Left alone (did not match):");
    s.ignored.forEach((e, i) =>
      lines.push(`${i + 1}. ${e.kind === "prompt" ? `${e.promptType ?? "prompt"} dialog` : `modal window ${e.url ?? ""}`} ${quote(e.title)}`)
    );
  }
  if (s.errors.length) lines.push(`Errors: ${s.errors.join("; ")}`);
  return lines.join("\n");
}

export function formatArmed(s: HandlerSummary, replaced: HandlerSummary | null): string {
  const o = s.options;
  const target = o.count === 1 ? "the next dialog" : `each of the next ${o.count} dialogs`;
  const scope = o.match ? ` whose title, message or URL contains ${quote(o.match)}` : "";
  const extras: string[] = [];
  if (o.text !== undefined) extras.push(`typing ${quote(o.text)} into a prompt`);
  if (o.checkbox !== undefined) extras.push(`checkbox ${o.checkbox ? "on" : "off"}`);
  const lines = [
    `Armed dialog handler #${s.id} for ${seconds(o.timeoutMs)}: it presses "${o.button}" on ${target}${scope}` +
      `${extras.length ? ` (${extras.join(", ")})` : ""}.`,
  ];
  if (replaced) {
    lines.push(`It replaces handler #${replaced.id}, which had handled ${replaced.handled.length} of ${replaced.options.count}.`);
  }
  lines.push(
    "Next: run the action that opens the dialog (zotero_click_element, zotero_execute_js, ...); " +
      'it returns once the dialog is answered. Then call zotero_handle_dialog with action "status".'
  );
  return lines.join("\n");
}

export function formatHandleOpen(r: { open: number; acted: DialogEntry[]; skipped: DialogEntry[] }): string {
  if (r.open === 0) return "No blocking dialog is open.";
  const lines = [`${r.open} blocking dialog(s) open; answered ${r.acted.length}.`];
  r.acted.forEach((e, i) => lines.push(formatEntry(e, i + 1)));
  if (r.skipped.length) {
    lines.push("Left open (did not match, or over count):");
    r.skipped.forEach((e, i) =>
      lines.push(`${i + 1}. ${e.error ? `error: ${e.error}` : `${e.kind === "prompt" ? `${e.promptType ?? "prompt"} dialog` : `modal window ${e.url ?? ""}`} ${quote(e.title)}`}`)
    );
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of RDPClient the tool needs - injectable for tests. */
export interface DialogClient {
  evaluateJS(code: string): Promise<EvaluateJSResponse>;
  gripToValueAsync(grip: GripValue): Promise<unknown>;
}

/**
 * The handler this server process armed and has not seen end, so a clean
 * shutdown can disarm it instead of leaving it to its timeout.
 */
let lease: { id: number; expiresAt: number } | null = null;

async function evalJson<T>(client: DialogClient, code: string): Promise<T> {
  const response = await client.evaluateJS(code);
  if (response.exception || response.exceptionMessage) {
    throw new Error(`Dialog handler evaluation failed: ${response.exceptionMessage ?? "unknown exception"}`);
  }
  const raw = response.result === undefined ? undefined : await client.gripToValueAsync(response.result);
  if (typeof raw !== "string") {
    throw new Error(`Unexpected result from Zotero (${typeof raw}); expected a JSON string`);
  }
  return JSON.parse(raw) as T;
}

function track(s: HandlerSummary | null): void {
  if (!s) {
    lease = null;
  } else if (s.state === "armed") {
    lease = { id: s.id, expiresAt: s.expiresAt };
  } else if (lease && lease.id === s.id) {
    lease = null;
  }
}

export async function handleDialogWithClient(
  client: DialogClient,
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const { action, options } = parseDialogArgs(args);

  if (action === "arm") {
    const r = await evalJson<{ handler: HandlerSummary; replaced: HandlerSummary | null }>(client, armCode(options));
    track(r.handler);
    return [{ type: "text", text: formatArmed(r.handler, r.replaced) }];
  }
  if (action === "status" || action === "disarm") {
    const r = await evalJson<{ handler: HandlerSummary | null }>(client, action === "status" ? statusCode() : disarmCode());
    track(r.handler);
    return [{ type: "text", text: formatSummary(r.handler) }];
  }
  const r = await evalJson<{ open: number; acted: DialogEntry[]; skipped: DialogEntry[] }>(client, handleOpenCode(options));
  return [{ type: "text", text: formatHandleOpen(r) }];
}

export async function handleDialog(args: Record<string, unknown>): Promise<TextContent[]> {
  const { getRdpClient } = await import("../index.js");
  return handleDialogWithClient(await getRdpClient(), args);
}

/**
 * Best effort, for server shutdown: disarm the handler this process armed if
 * its timeout has not passed yet. Bounded by `waitMs`; never throws.
 */
export async function releaseDialogHandler(client: DialogClient, waitMs = 1000): Promise<void> {
  const held = lease;
  if (!held || Date.now() >= held.expiresAt) return;
  lease = null;
  try {
    await Promise.race([
      client.evaluateJS(disarmCode(held.id)),
      new Promise((resolve) => setTimeout(resolve, waitMs).unref()),
    ]);
  } catch {
    // Zotero gone or unreachable: the handler's own timeout still ends it.
  }
}
