/**
 * The opt-in `port` argument (src/utils/targets.ts): parsing ZOTERO_RDP_PORTS,
 * which ports a call may name, the tool schemas, and that the port of one
 * call cannot leak into a parallel one. Pure logic, no Zotero needed; the
 * two-instance round trip is checked end to end against two live Zotero
 * instances (see the PR description).
 */
import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { parsePortList, portContext, portPolicy, resolvePort, withPortArgument } from "../src/utils/targets.js";

const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: "object", properties: { code: { type: "string" } } } });

describe("ZOTERO_RDP_PORTS", () => {
  it("keeps valid ports only, once each, in order", () => {
    expect(parsePortList(" 6101, 6105,x, 0, 70000, 6101 ")).toEqual([6101, 6105]);
    expect(parsePortList(undefined)).toEqual([]);
  });

  it("is off when unset, and always allows the default port when on", () => {
    expect(portPolicy(undefined, 6100)).toEqual({ defaultPort: 6100, allowed: [] });
    expect(portPolicy("6101", 6100)).toEqual({ defaultPort: 6100, allowed: [6100, 6101] });
    expect(portPolicy("6101,6100", 6100).allowed).toEqual([6101, 6100]);
  });
});

describe("resolvePort", () => {
  const off = portPolicy(undefined, 6100);
  const on = portPolicy("6101,6105", 6100);

  it("uses the default port when the call names none", () => {
    expect(resolvePort(undefined, off)).toBe(6100);
    expect(resolvePort(undefined, on)).toBe(6100);
  });

  it("refuses another port while the argument is off, saying how to turn it on", () => {
    expect(resolvePort(6100, off)).toBe(6100);
    expect(() => resolvePort(6101, off)).toThrow(/"port" argument is off.*ZOTERO_RDP_PORTS=6100,6101/);
  });

  it("allows the listed ports only", () => {
    expect(resolvePort(6105, on)).toBe(6105);
    expect(resolvePort("6101", on)).toBe(6101);
    expect(() => resolvePort(6200, on)).toThrow(/Port 6200 is not one this server may use\. Allowed \(ZOTERO_RDP_PORTS\): 6100, 6101, 6105/);
  });
});

describe("withPortArgument", () => {
  const tools = [tool("zotero_execute_js"), tool("zotero_scaffold_build")];
  const exempt = new Set(["zotero_scaffold_build"]);

  it("leaves the tool list untouched while the argument is off", () => {
    expect(withPortArgument(tools, portPolicy(undefined, 6100), exempt)).toBe(tools);
  });

  it("adds `port` (the allowed ports) to the tools that talk to Zotero", () => {
    const out = withPortArgument(tools, portPolicy("6101", 6100), exempt);
    const port = (out[0].inputSchema.properties as Record<string, { enum?: number[] }>).port;
    expect(port.enum).toEqual([6100, 6101]);
    expect((out[0].inputSchema.properties as Record<string, unknown>).code).toBeDefined();
    expect(out[1]).toBe(tools[1]);
    expect((tools[0].inputSchema.properties as Record<string, unknown>).port).toBeUndefined();
  });
});

describe("portContext", () => {
  it("keeps the port of each of two parallel calls to itself", async () => {
    const seen: Array<[number, number | undefined]> = [];
    const call = (port: number, delay: number) =>
      portContext.run(port, async () => {
        await new Promise((r) => setTimeout(r, delay));
        seen.push([port, portContext.getStore()]);
      });
    await Promise.all([call(6100, 30), call(6101, 5), call(6105, 15)]);
    expect(seen.every(([want, got]) => want === got)).toBe(true);
    expect(portContext.getStore()).toBeUndefined();
  });
});
