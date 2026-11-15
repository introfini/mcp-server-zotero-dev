/**
 * Deciding whether zotero_execute_js code needs an IIFE, and running it.
 *
 * Kept free of any import from index.ts so tests can load it without starting
 * the MCP server (see ping.ts for the same reason).
 *
 * The old detector stripped quoted strings with regexes BEFORE stripping
 * comments, so an apostrophe inside a `//` comment ("// Zotero's pane")
 * opened a fake string that swallowed the code after it, top-level `return`
 * included. The code was then sent unwrapped and failed with "SyntaxError:
 * await is only valid in async functions" (or "return not in function"),
 * and the fallback retry only knew the second message.
 *
 * Two layers now:
 * 1. codeSkeleton() masks comments, string and template literals and regex
 *    literals in ONE left-to-right pass, the way the parser sees them, so a
 *    quote inside a comment (or a slash inside a string) cannot fake a token.
 * 2. Both SyntaxErrors that mean "this needed a function body" trigger a
 *    wrapped retry. A SyntaxError is raised while PARSING, before any of the
 *    code runs, so the retry can never run side effects twice.
 */

import type { EvaluateJSResponse } from "../rdp/index.js";

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PREFIX_CHARS = new Set("(,=:[!&|?{};~+-*%<>^".split(""));
/** Keywords after which a `/` starts a regex literal. */
const REGEX_PREFIX_WORDS = new Set([
  "return", "typeof", "instanceof", "case", "do", "else", "in", "of", "new",
  "delete", "void", "throw", "yield", "await",
]);

/**
 * The code with every comment, string literal, template literal and regex
 * literal replaced by spaces (newlines kept), so keywords and braces can be
 * found by simple scanning. Template literals are masked whole, `${...}`
 * included: a `return` or `await` inside one is not top-level code anyway.
 */
export function codeSkeleton(code: string): string {
  const out: string[] = [];
  const n = code.length;
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  // The last significant token, for telling a regex `/` from a division:
  // its last character and, when it is a word, the word. A masked literal is
  // an operand ("x"); a comment leaves both unchanged.
  let prevCh = "";
  let prevWord = "";

  /** Index just past the template literal starting at `start` (a backtick). */
  const skipTemplate = (start: number): number => {
    let j = start + 1;
    while (j < n) {
      const c = code[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "`") return j + 1;
      if (c === "$" && code[j + 1] === "{") {
        // An expression: scan to its matching brace, skipping nested literals.
        j += 2;
        let depth = 1;
        while (j < n && depth > 0) {
          const d = code[j];
          if (d === "\\") { j += 2; continue; }
          if (d === "'" || d === '"') { j = skipQuoted(j); continue; }
          if (d === "`") { j = skipTemplate(j); continue; }
          if (d === "{") depth++;
          else if (d === "}") depth--;
          j++;
        }
        continue;
      }
      j++;
    }
    return n;
  };

  /** Index just past the quoted string starting at `start`. */
  const skipQuoted = (start: number): number => {
    const q = code[start];
    let j = start + 1;
    while (j < n) {
      const c = code[j];
      if (c === "\\") { j += 2; continue; }
      if (c === q || c === "\n") return j + 1;   // an unterminated line ends it
      j++;
    }
    return n;
  };

  /** Index just past the regex literal starting at `start` (a slash). */
  const skipRegex = (start: number): number => {
    let j = start + 1;
    let inClass = false;
    while (j < n) {
      const c = code[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "\n") return j;   // not a regex after all; stop at the line end
      if (inClass) { if (c === "]") inClass = false; }
      else if (c === "[") inClass = true;
      else if (c === "/") {
        j++;
        while (j < n && /[a-z]/i.test(code[j])) j++;   // flags
        return j;
      }
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    let end = -1;
    let literal = false;
    if (c === "/" && next === "/") {
      end = code.indexOf("\n", i);
      if (end < 0) end = n;
    } else if (c === "/" && next === "*") {
      end = code.indexOf("*/", i + 2);
      end = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      end = skipQuoted(i);
      literal = true;
    } else if (c === "`") {
      end = skipTemplate(i);
      literal = true;
    } else if (c === "/" && (prevCh === "" || REGEX_PREFIX_CHARS.has(prevCh) || REGEX_PREFIX_WORDS.has(prevWord))) {
      end = skipRegex(i);
      literal = true;
    }
    if (end > i) {
      out.push(blank(code.slice(i, end)));
      if (literal) { prevCh = "x"; prevWord = ""; }
      i = end;
      continue;
    }
    out.push(c);
    if (/[A-Za-z0-9_$]/.test(c)) {
      prevWord = /[A-Za-z0-9_$]/.test(prevCh) && !/\s/.test(code[i - 1] ?? "") ? prevWord + c : c;
      prevCh = c;
    } else if (!/\s/.test(c)) {
      prevCh = c;
      prevWord = "";
    }
    i++;
  }
  return out.join("");
}

/** Whether `keyword` occurs outside any `{}` block in the skeleton. */
function hasTopLevel(skeleton: string, keyword: string): boolean {
  const re = new RegExp(`\\b${keyword}\\b`, "g");
  let depth = 0;
  let scanned = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(skeleton)) !== null) {
    for (; scanned < match.index; scanned++) {
      const ch = skeleton[scanned];
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
    if (depth === 0) return true;
  }
  return false;
}

/**
 * Whether the code must run inside a function: a top-level `return`, or a
 * top-level `await` (the console only accepts `await` at the top level when
 * the client has rewritten the expression itself, which this server does not).
 * A heuristic: braces of blocks and functions are not told apart, so a
 * `return` inside a top-level `if {}` is missed - the wrapped retry on the
 * resulting SyntaxError covers that case.
 */
export function needsIIFEWrapper(code: string): boolean {
  if (!/\b(return|await)\b/.test(code)) return false;
  const skeleton = codeSkeleton(code);
  return hasTopLevel(skeleton, "return") || hasTopLevel(skeleton, "await");
}

/**
 * What the async wrapper returns in place of a thrown error: this prefix
 * (a NUL character no real result starts with) and the error as JSON.
 */
export const WRAPPED_ERROR_PREFIX = "\u0000mcp-error:";

/**
 * Wraps code in an IIFE: an async one when the code awaits anything.
 *
 * The async one catches what the code throws and returns it marked
 * (WRAPPED_ERROR_PREFIX). A rejected promise reaches the client with no
 * reason at all: the reply only says `topLevelAwaitRejected`, and nothing
 * lands in the error console either, so `throw` inside async code read as
 * "Result: undefined" - a failure that looked like success.
 */
export function wrapInIIFE(code: string): string {
  if (/\bawait\b/.test(codeSkeleton(code))) {
    return (
      `(async () => {\n` +
      `try {\n` +
      `return await (async () => {\n${code}\n})();\n` +
      `} catch (__mcpError) {\n` +
      `const e = __mcpError;\n` +
      `return "\\u0000mcp-error:" + JSON.stringify({\n` +
      `name: (e && e.name) || "Error",\n` +
      `message: e && e.message !== undefined ? String(e.message) : String(e),\n` +
      `stack: (e && e.stack) ? String(e.stack) : ""\n` +
      `});\n` +
      `}\n` +
      `})()`
    );
  }
  return `(() => {\n${code}\n})()`;
}

/** The error a wrapped evaluation returned (see wrapInIIFE), or null. */
export function decodeWrappedError(value: unknown): { name: string; message: string; stack: string } | null {
  if (typeof value !== "string" || !value.startsWith(WRAPPED_ERROR_PREFIX)) return null;
  try {
    const e = JSON.parse(value.slice(WRAPPED_ERROR_PREFIX.length)) as { name?: string; message?: string; stack?: string };
    return { name: e.name || "Error", message: e.message ?? "", stack: e.stack ?? "" };
  } catch {
    return { name: "Error", message: value.slice(WRAPPED_ERROR_PREFIX.length), stack: "" };
  }
}

/**
 * The parse errors that mean the code needed a function body. Raised before
 * anything ran, so retrying the wrapped code is always safe.
 */
export function isWrapRetryError(message: string | undefined): boolean {
  if (!message) return false;
  return (
    message.includes("return not in function") ||
    message.includes("await is only valid in async functions")
  );
}

/**
 * A RAW reply grip's undefined and null as the values they stand for.
 * gripToValue() maps primitives, long strings and objects but hands
 * `{type: "undefined"}` and `{type: "null"}` through unchanged, so a
 * statement's undefined result printed as that JSON. Apply it to the raw
 * `response.result`, where a user's object is always `{type: "object", ...}`;
 * anything else is returned as is (the same reference).
 */
export function nullishGripToValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "type" in value) {
    const type = (value as { type?: unknown }).type;
    if (type === "undefined" && Object.keys(value).length === 1) return undefined;
    if (type === "null" && Object.keys(value).length === 1) return null;
  }
  return value;
}

/** The subset of RDPClient this needs - injectable for tests. */
export interface EvalClient {
  evaluateJS(code: string): Promise<EvaluateJSResponse>;
}

/**
 * Evaluate user code the way zotero_execute_js does: wrapped up front when
 * the detector says so, and wrapped on retry when Zotero rejects the unwrapped
 * code with one of the parse errors above. Returns the reply and the code
 * that produced it.
 */
export async function evaluateUserCode(
  client: EvalClient,
  code: string
): Promise<{ response: EvaluateJSResponse; code: string }> {
  const wrapped = needsIIFEWrapper(code);
  const first = wrapped ? wrapInIIFE(code) : code;
  const response = await client.evaluateJS(first);
  if (!wrapped && isWrapRetryError(response.exceptionMessage)) {
    const retry = wrapInIIFE(code);
    return { response: await client.evaluateJS(retry), code: retry };
  }
  return { response, code: first };
}
