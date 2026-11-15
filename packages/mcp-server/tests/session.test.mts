/**
 * Importing a tool module must not start the MCP server (#33).
 *
 * index.ts runs main() when it is imported, and main() puts a stdio server on
 * the process's stdin/stdout. A tool module that imports getRdpClient() from
 * there therefore cannot be loaded by a test without that server coming up.
 * The RDP session lives in src/rdp/session.ts, which has no side effects on
 * import; this checks every tool module, each loaded fresh.
 *
 * main() writes "MCP Server Zotero Dev starting..." with console.error before
 * its first await, so a spy installed before the import sees it if it runs.
 * No Zotero is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOOL_MODULES: Record<string, () => Promise<unknown>> = {
  database: () => import("../src/tools/database.js"),
  execute: () => import("../src/tools/execute.js"),
  inspect: () => import("../src/tools/inspect.js"),
  interact: () => import("../src/tools/interact.js"),
  logs: () => import("../src/tools/logs.js"),
  ping: () => import("../src/tools/ping.js"),
  plugins: () => import("../src/tools/plugins.js"),
  scaffold: () => import("../src/tools/scaffold.js"),
  screenshot: () => import("../src/tools/screenshot.js"),
};

describe("importing a tool module does not start the MCP server (#33)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const [name, load] of Object.entries(TOOL_MODULES)) {
    it(`tools/${name}`, async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await load();
      const started = errors.mock.calls.some((args) => String(args[0]).includes("MCP Server Zotero Dev starting"));
      expect(started).toBe(false);
    });
  }
});

describe("rdp/session", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads the configuration from the environment once, on first use", async () => {
    const saved = process.env.ZOTERO_RDP_PORT;
    process.env.ZOTERO_RDP_PORT = "6198";
    try {
      const { getConfig } = await import("../src/rdp/session.js");
      const first = getConfig();
      expect(first.rdp.port).toBe(6198);
      process.env.ZOTERO_RDP_PORT = "6199";
      expect(getConfig()).toBe(first);
    } finally {
      if (saved === undefined) delete process.env.ZOTERO_RDP_PORT;
      else process.env.ZOTERO_RDP_PORT = saved;
    }
  });

  it("disconnectRdpClient() is safe before any connection was made", async () => {
    const { disconnectRdpClient } = await import("../src/rdp/session.js");
    expect(() => disconnectRdpClient()).not.toThrow();
  });
});
