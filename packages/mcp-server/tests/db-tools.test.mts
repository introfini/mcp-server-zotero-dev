/**
 * Regression tests for the database tools (zotero_db_query / zotero_db_schema).
 *
 * They guard the two defects fixed in #21 (reported in #20):
 *   1. Column names: Zotero.DB.queryAsync rows are Proxies with only get/has
 *      traps, so Object.keys() could never recover column names. The fix reads
 *      rows via the onRow callback and parses names from the SELECT list.
 *   2. Serialization: raw nested objects returned from the eval degrade to
 *      placeholder strings ("[Array]") during RDP grip resolution, which
 *      surfaced as `result.columns.join is not a function` on every query.
 *
 * The tests spawn the built server (beforeAll rebuilds dist/index.js) and
 * drive both tools over MCP stdio against a live Zotero, so they run the full
 * RDP round trip that made both defects reachable. A mocked RDP layer would
 * miss them, because the Proxy shape and the grip degradation only exist in a
 * real Zotero.
 *
 * Covered here: real column names from an explicit SELECT list, a FROM-less
 * SELECT, aggregate aliases, the positional colN fallback for SELECT *, and
 * the JSON round-trip of single-table schema output.
 *
 * Requirements: Zotero running with the MCP Bridge plugin (RDP on
 * ZOTERO_RDP_PORT, default 6100). The suite probes the port first and skips
 * with a warning when no Zotero is reachable, so `npm test` stays green
 * without one.
 */
import { execSync } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(PKG_ROOT, "dist", "index.js");
const RDP_HOST = process.env.ZOTERO_RDP_HOST ?? "localhost";
const RDP_PORT = process.env.ZOTERO_RDP_PORT ?? "6100";

function canReachZotero(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: RDP_HOST, port: Number(RDP_PORT) });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function textOf(result: ToolResult): string {
  const first = result.content?.[0];
  expect(
    result.isError,
    `tool call failed: ${first?.text ?? "(no content)"}`
  ).toBeFalsy();
  expect(first?.type).toBe("text");
  return first?.text ?? "";
}

/** Parse the db_query output format: header, columns line, blank, JSON rows. */
function parseQueryOutput(text: string): {
  rowCount: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
} {
  const match = text.match(/^Query returned (\d+) row\(s\)\nColumns: (.*)\n\n/);
  expect(match, `unexpected db_query output:\n${text}`).toBeTruthy();
  const header = match as RegExpMatchArray;
  return {
    rowCount: Number(header[1]),
    columns: header[2].split(", "),
    rows: JSON.parse(text.slice(header[0].length)) as Array<
      Record<string, unknown>
    >,
  };
}

const zoteroReachable = await canReachZotero();
if (!zoteroReachable) {
  console.warn(
    `[db-tools.test] No Zotero RDP endpoint at ${RDP_HOST}:${RDP_PORT} - ` +
      "skipping integration tests. Start Zotero with the MCP Bridge plugin to run them."
  );
}

describe.skipIf(!zoteroReachable)("db tools against live Zotero", () => {
  let client: Client;

  beforeAll(async () => {
    // Always rebuild so the tests exercise current sources, not a stale dist.
    execSync("npm run build", { cwd: PKG_ROOT, stdio: "pipe" });

    client = new Client({ name: "db-tools-regression", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_ENTRY],
        env: {
          PATH: process.env.PATH ?? "",
          ZOTERO_RDP_HOST: RDP_HOST,
          ZOTERO_RDP_PORT: RDP_PORT,
        },
      })
    );
  }, 120_000);

  afterAll(async () => {
    await client?.close();
  });

  async function dbQuery(query: string): Promise<ToolResult> {
    return (await client.callTool({
      name: "zotero_db_query",
      arguments: { query },
    })) as ToolResult;
  }

  // The headline regression: on 1.1.2 every query died with
  // "result.columns.join is not a function" before returning a single row.
  it("returns real column names for an explicit SELECT list", async () => {
    const text = textOf(
      await dbQuery("SELECT itemTypeID, typeName FROM itemTypes LIMIT 3")
    );
    expect(text).not.toContain("columns.join");
    expect(text).not.toContain("[Array]");

    const result = parseQueryOutput(text);
    expect(result.columns).toEqual(["itemTypeID", "typeName"]);
    expect(result.rowCount).toBe(3);
    expect(result.rows).toHaveLength(3);
    expect(typeof result.rows[0].itemTypeID).toBe("number");
    expect(typeof result.rows[0].typeName).toBe("string");
  }, 30_000);

  it("handles a FROM-less SELECT", async () => {
    const result = parseQueryOutput(textOf(await dbQuery("SELECT 1 AS n")));
    expect(result.columns).toEqual(["n"]);
    expect(result.rows).toEqual([{ n: 1 }]);
  }, 30_000);

  it("recovers aliases for aggregate expressions", async () => {
    const result = parseQueryOutput(
      textOf(await dbQuery("SELECT COUNT(*) AS n FROM items"))
    );
    expect(result.columns).toEqual(["n"]);
    expect(result.rows).toHaveLength(1);
    expect(typeof result.rows[0].n).toBe("number");
  }, 30_000);

  it("falls back to positional colN names for SELECT *", async () => {
    const result = parseQueryOutput(
      textOf(await dbQuery("SELECT * FROM itemTypes LIMIT 2"))
    );
    expect(result.columns.length).toBeGreaterThan(0);
    for (const [i, name] of result.columns.entries()) {
      expect(name).toBe(`col${i + 1}`);
    }
    expect(result.rows).toHaveLength(2);
    // itemTypes(itemTypeID INTEGER, typeName TEXT, ...), positions preserved.
    expect(typeof result.rows[0].col1).toBe("number");
    expect(typeof result.rows[0].col2).toBe("string");
  }, 30_000);

  // db_schema shared defect 2 (grip degradation of nested returns).
  it("db_schema returns parsed column info for one table", async () => {
    const text = textOf(
      (await client.callTool({
        name: "zotero_db_schema",
        arguments: { table: "items" },
      })) as ToolResult
    );
    expect(text).toContain('Schema for table "items":');
    expect(text).toMatch(/itemID: INTEGER/);
    expect(text).not.toContain("[Array]");
    expect(text).not.toContain("[Object]");
  }, 30_000);
});
