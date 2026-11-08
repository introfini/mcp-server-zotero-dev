/**
 * Regression tests for zotero_execute_js's IIFE wrapping.
 *
 * The defect: the detector stripped quoted strings with regexes before
 * stripping comments, so an apostrophe in a `//` comment ("Zotero's") opened a
 * fake string that hid the top-level `return`. The code went out unwrapped and
 * Zotero rejected it with "SyntaxError: await is only valid in async
 * functions", which the fallback retry did not know (it only matched "return
 * not in function").
 *
 * The unit cases cover the scanner and the retry with a fake client: the
 * decision is pure string work, so a mock is sufficient for it. The live case
 * sends the original three-line reproduction to a real Zotero; it skips (does
 * not fail) unless a Zotero with the bridge answers on ZOTERO_RDP_PORT
 * (default 6100) and `typeof Zotero` resolves there.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  codeSkeleton,
  evaluateUserCode,
  isWrapRetryError,
  decodeWrappedError,
  needsIIFEWrapper,
  nullishGripToValue,
  WRAPPED_ERROR_PREFIX,
  wrapInIIFE,
  type EvalClient,
} from "../src/tools/js-wrap.js";
import { createClient, type RDPClient } from "../src/rdp/index.js";
import type { EvaluateJSResponse, GripValue } from "../src/rdp/index.js";

const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");

/** The reproduction: an apostrophe in a comment, a top-level await, a return. */
const REPRO = "// Zotero's probe\nconst x = await Promise.resolve(41);\nreturn x + 1; // it's the answer";

describe("codeSkeleton", () => {
  it("masks comments, strings, templates and regex literals, keeping newlines", () => {
    const code = "a = 'x{'; // it's {\nb = `t ${ {c: 1}.c } }`; /* } */ r = /['{]/g;\nreturn a";
    const s = codeSkeleton(code);
    expect(s).toHaveLength(code.length);
    expect(s.split("\n")).toHaveLength(3);
    expect(s).not.toMatch(/[{}'`]/);
    expect(s).toContain("return a");
  });

  it("reads a slash after an operand as a division, not a regex", () => {
    const s = codeSkeleton("const a = x / 2; const b = (y) / 3; return a / b");
    expect(s).toBe("const a = x / 2; const b = (y) / 3; return a / b");
  });

  it("reads a slash after a keyword or an operator as a regex", () => {
    expect(codeSkeleton("return /'/.test(s)")).toBe("return    .test(s)");
    expect(codeSkeleton("x = /}/")).toBe("x =    ");
  });
});

describe("needsIIFEWrapper", () => {
  it("wraps the reproduction: an apostrophe in a comment no longer hides the return", () => {
    expect(needsIIFEWrapper(REPRO)).toBe(true);
    expect(wrapInIIFE(REPRO).startsWith("(async () => {")).toBe(true);
  });

  it("wraps a top-level await even with no return", () => {
    expect(needsIIFEWrapper("// it's\nawait Zotero.Promise.delay(1);")).toBe(true);
  });

  it("does not wrap returns and awaits that are only text or inside functions", () => {
    expect(needsIIFEWrapper('const s = "return 1; await x"; s')).toBe(false);
    expect(needsIIFEWrapper("// return\n/* await */ 1 + 1")).toBe(false);
    expect(needsIIFEWrapper("function f() { return 1 }\nf()")).toBe(false);
    expect(needsIIFEWrapper("(async () => { await f(); return 2 })()")).toBe(false);
  });

  it("uses a plain IIFE when nothing is awaited", () => {
    expect(wrapInIIFE("// don't await\nreturn 1")).toBe("(() => {\n// don't await\nreturn 1\n})()");
  });
});

describe("isWrapRetryError", () => {
  it("knows both parse errors that mean the code needed a function body", () => {
    expect(isWrapRetryError("SyntaxError: return not in function")).toBe(true);
    expect(isWrapRetryError("SyntaxError: await is only valid in async functions, async generators and modules")).toBe(true);
    expect(isWrapRetryError("ReferenceError: x is not defined")).toBe(false);
    expect(isWrapRetryError(undefined)).toBe(false);
  });
});

describe("errors thrown inside the async wrapper", () => {
  it("are caught and returned marked, and decoded back", () => {
    const wrapped = wrapInIIFE("await x();\nreturn 1");
    expect(wrapped).toContain("catch (__mcpError)");
    const marked = WRAPPED_ERROR_PREFIX + JSON.stringify({ name: "TypeError", message: "x is not a function", stack: "@debugger eval code:3:7" });
    expect(decodeWrappedError(marked)).toEqual({ name: "TypeError", message: "x is not a function", stack: "@debugger eval code:3:7" });
  });

  it("leave every other value alone", () => {
    expect(decodeWrappedError("Error: just a string")).toBeNull();
    expect(decodeWrappedError(42)).toBeNull();
    expect(decodeWrappedError(undefined)).toBeNull();
  });
});

describe("nullishGripToValue", () => {
  it("reads the raw undefined and null grips as undefined and null, and leaves the rest", () => {
    expect(nullishGripToValue({ type: "undefined" })).toBeUndefined();
    expect(nullishGripToValue({ type: "null" })).toBeNull();
    const obj = { type: "object", class: "Object", actor: "a1" };
    expect(nullishGripToValue(obj)).toBe(obj);
    expect(nullishGripToValue(42)).toBe(42);
    expect(nullishGripToValue("undefined")).toBe("undefined");
  });
});

describe("evaluateUserCode (unit, fake RDP replies)", () => {
  /** Accepts only code that is wrapped; records what it was sent. */
  function fakeClient(sent: string[]): EvalClient {
    return {
      async evaluateJS(code: string): Promise<EvaluateJSResponse> {
        sent.push(code);
        if (code.startsWith("(")) return { from: "c", result: 7 as unknown as GripValue };
        return { from: "c", exceptionMessage: "SyntaxError: return not in function", result: { type: "undefined" } as unknown as GripValue };
      },
    };
  }

  it("retries wrapped when the detector missed a return inside a top-level block", async () => {
    const sent: string[] = [];
    const { response, code } = await evaluateUserCode(fakeClient(sent), "if (true) { return 7 }");
    expect(sent).toHaveLength(2);
    expect(code).toBe("(() => {\nif (true) { return 7 }\n})()");
    expect(response.exceptionMessage).toBeUndefined();
  });

  it("sends detected code wrapped, once", async () => {
    const sent: string[] = [];
    await evaluateUserCode(fakeClient(sent), REPRO);
    expect(sent).toHaveLength(1);
    expect(sent[0].startsWith("(async () => {")).toBe(true);
  });

  it("does not retry a runtime error: the code may have run", async () => {
    const sent: string[] = [];
    const client: EvalClient = {
      async evaluateJS(code: string) {
        sent.push(code);
        return { from: "c", exceptionMessage: "ReferenceError: nope is not defined", result: { type: "undefined" } as unknown as GripValue };
      },
    };
    const { response } = await evaluateUserCode(client, "nope()");
    expect(sent).toHaveLength(1);
    expect(response.exceptionMessage).toContain("ReferenceError");
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
  console.warn(`[js-wrap.test] skipping live case - ${ready.reason}`);
}

describe.skipIf(!ready.client)("zotero_execute_js wrapping (live Zotero)", () => {
  let client: RDPClient;
  beforeAll(() => {
    client = ready.client as RDPClient;
  });
  afterAll(() => {
    client.disconnect();
  });

  it("runs the reproduction: 42, no SyntaxError", async () => {
    const { response } = await evaluateUserCode(client, REPRO);
    expect(response.exceptionMessage).toBeUndefined();
    expect(await client.gripToValueAsync(response.result as GripValue)).toBe(42);
  });

  it("reports what wrapped async code threw instead of an undefined result", async () => {
    const { response } = await evaluateUserCode(client, "await null;\nthrow new TypeError('thrown after an await')");
    const value = await client.gripToValueAsync(response.result as GripValue);
    expect(decodeWrappedError(value)).toMatchObject({ name: "TypeError", message: "thrown after an await" });
  });

  it("documents the reply for code it does not wrap: a rejection without its reason", async () => {
    const { response } = await evaluateUserCode(client, "(async () => { throw new Error('own IIFE') })()");
    expect(response.topLevelAwaitRejected).toBe(true);
    expect(response.exceptionMessage).toBeUndefined();
    expect(response.result).toBeUndefined();
  });

  it("runs a return inside a top-level block through the wrapped retry", async () => {
    const { response } = await evaluateUserCode(client, "// Zotero's block\nif (Zotero) { return 'ok' }");
    expect(response.exceptionMessage).toBeUndefined();
    expect(await client.gripToValueAsync(response.result as GripValue)).toBe("ok");
  });
});
