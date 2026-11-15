/**
 * Regression test for zotero_db_stats (#23).
 *
 * The handler returned its stats object raw from the eval. RDP object previews
 * are one level deep, so the nested `libraries` array reached the host as the
 * placeholder string "[Array]": the tool reported "Libraries (7)", the length
 * of that string, and printed one "undefined" line per character. The
 * degradation happens in Zotero's grip encoding, so only a live round trip
 * shows it; a mocked RDP layer would hand back whatever the mock was given.
 *
 * The test drives the built server over MCP stdio, the path a client takes,
 * and checks its output against the library IDs Zotero reports directly. It
 * skips when no Zotero with the bridge answers on ZOTERO_RDP_PORT (default
 * 6100), or when `Zotero` does not resolve there: a windowless Zotero keeps
 * the port open while every tool fails.
 */
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient, type GripValue } from "../src/rdp/index.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");

/** Zotero's library IDs, read straight over RDP, or the reason to skip. */
async function zoteroLibraryIds(): Promise<number[] | string> {
  const client = createClient({ port: RDP_PORT });
  try {
    await client.connect();
    const r = await client.evaluateJS(
      `typeof Zotero === "undefined" ? "" : JSON.stringify(Zotero.Libraries.getAll().map((l) => l.libraryID))`
    );
    if (r.exception) return `probe threw: ${r.exceptionMessage}`;
    const json = await client.gripToValueAsync(r.result as GripValue);
    if (typeof json !== "string" || json === "") return `Zotero does not resolve on port ${RDP_PORT}`;
    return JSON.parse(json) as number[];
  } catch (e) {
    return `no bridge on port ${RDP_PORT}: ${(e as Error).message}`;
  } finally {
    try { client.disconnect(); } catch { /* not connected */ }
  }
}

const probe = await zoteroLibraryIds();
const skipReason = typeof probe === "string" ? probe : "";
if (skipReason) {
  console.warn(`[db-stats.test] skipping - ${skipReason}`);
}
const libraryIds = typeof probe === "string" ? [] : probe;

describe.skipIf(Boolean(skipReason))("zotero_db_stats (live Zotero, over MCP stdio)", () => {
  let mcp: Client;

  beforeAll(async () => {
    // The stdio server runs dist/, so rebuild it first: a stale dist/ would
    // test old code. This writes to dist/ and can race a `npm run dev` watcher.
    try {
      execSync("npm run build", { cwd: PKG_ROOT, stdio: "pipe" });
    } catch (e) {
      const { stdout, stderr } = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`npm run build failed:\n${stdout ?? ""}${stderr ?? ""}`);
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    mcp = new Client({ name: "db-stats-test", version: "0" });
    await mcp.connect(
      new StdioClientTransport({ command: process.execPath, args: [join(PKG_ROOT, "dist", "index.js")], env, stderr: "ignore" })
    );
  }, 120_000);

  afterAll(async () => {
    await mcp?.close();
  });

  it("lists every library with its name, type and ID (#23)", async () => {
    const result = (await mcp.callTool({ name: "zotero_db_stats", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = result.content.map((c) => c.text ?? "").join("\n");
    expect(result.isError, text).toBeFalsy();

    const header = text.match(/^Libraries \((\d+)\):$/m);
    expect(header, `no "Libraries (N):" line in:\n${text}`).toBeTruthy();
    expect(Number(header![1])).toBe(libraryIds.length);

    const lines = text.slice(header!.index! + header![0].length).split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(libraryIds.length);
    for (const id of libraryIds) {
      const line = new RegExp(`^  - .+ \\((user|group|feed), ID: ${id}\\)$`);
      expect(lines.some((l) => line.test(l)), `no line for library ${id} in:\n${lines.join("\n")}`).toBe(true);
    }
    expect(text).not.toContain("undefined");
  });
});
