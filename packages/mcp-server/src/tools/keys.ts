/**
 * Key combinations for zotero_press_keys: "Ctrl+Shift+F" -> modifiers and a
 * key description for nsITextInputProcessor. Pure, no import from index.ts,
 * so tests can load it.
 */

export interface KeySpec {
  /** KeyboardEvent.key */
  key: string;
  /** KeyboardEvent.code */
  code: string;
  /** KeyboardEvent.keyCode (0 when there is none) */
  keyCode: number;
}

export interface KeyCombo {
  /** Modifier keys, in the order they are pressed. "Accel" is resolved in Zotero. */
  modifiers: Array<"Control" | "Shift" | "Alt" | "Meta" | "Accel">;
  key: KeySpec;
}

const MODIFIERS: Record<string, KeyCombo["modifiers"][number]> = {
  ctrl: "Control", control: "Control",
  shift: "Shift",
  alt: "Alt", option: "Alt", opt: "Alt",
  meta: "Meta", cmd: "Meta", command: "Meta", win: "Meta",
  accel: "Accel", cmdorctrl: "Accel", commandorcontrol: "Accel",
};

/** Named keys, by lower-case name: [key, code, keyCode]. */
const NAMED: Record<string, [string, string, number]> = {
  enter: ["Enter", "Enter", 13], return: ["Enter", "Enter", 13],
  escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  tab: ["Tab", "Tab", 9],
  backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46], del: ["Delete", "Delete", 46],
  space: [" ", "Space", 32],
  arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37], left: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
  insert: ["Insert", "Insert", 45],
  contextmenu: ["ContextMenu", "ContextMenu", 93],
};

/** Punctuation on a US layout: [code, keyCode]. */
const PUNCT: Record<string, [string, number]> = {
  "-": ["Minus", 173], "=": ["Equal", 61], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  ";": ["Semicolon", 59], "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190],
  "/": ["Slash", 191], "\\": ["Backslash", 220], "`": ["Backquote", 192],
};

/** The KeySpec for one key name ("F", "f", "5", "F5", "Enter", ","). */
export function keySpec(name: string): KeySpec {
  const lower = name.toLowerCase();
  if (NAMED[lower]) {
    const [key, code, keyCode] = NAMED[lower];
    return { key, code, keyCode };
  }
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(name)) {
    const n = Number(name.slice(1));
    return { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };
  }
  if (/^[a-z]$/i.test(name)) {
    const upper = name.toUpperCase();
    return { key: name, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0) };
  }
  if (PUNCT[name]) {
    const [code, keyCode] = PUNCT[name];
    return { key: name, code, keyCode };
  }
  if ([...name].length === 1) {
    return { key: name, code: "", keyCode: 0 };
  }
  throw new Error(
    `Unknown key "${name}". Use a letter, a digit, F1-F24, punctuation, or one of: ` +
      Object.keys(NAMED).join(", ")
  );
}

/**
 * "Ctrl+Shift+F" -> {modifiers: ["Control", "Shift"], key: F}. Modifier names
 * are case-insensitive (Ctrl/Control, Shift, Alt/Option, Meta/Cmd/Command,
 * Accel = Cmd on macOS, Ctrl elsewhere). A letter with Shift is sent upper
 * case, as a keyboard would. "+" itself is written "Plus".
 */
export function parseKeyCombo(combo: string): KeyCombo {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`Empty key combination: "${combo}"`);
  const last = parts.pop() as string;
  const modifiers: KeyCombo["modifiers"] = [];
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}" in "${combo}". Use Ctrl, Shift, Alt, Meta/Cmd or Accel.`);
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  const key = keySpec(last.toLowerCase() === "plus" ? "=" : last);
  if (last.toLowerCase() === "plus") {
    key.key = "+";
    if (!modifiers.includes("Shift")) modifiers.push("Shift");
  } else if (/^[a-z]$/i.test(key.key)) {
    key.key = modifiers.includes("Shift") ? key.key.toUpperCase() : key.key.toLowerCase();
  }
  return { modifiers, key };
}
