/**
 * Database Access Tools
 *
 * Read-only access to Zotero's SQLite database
 */

import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { getRdpClient } from "../index.js";
import { RDPClient } from "../rdp/index.js";

// Tool definitions
export const dbQueryTool: Tool = {
  name: "zotero_db_query",
  description:
    "Execute a SELECT query on Zotero's database. " +
    "Only SELECT queries are allowed for safety. " +
    "Note: Database may be locked if Zotero is running - a copy may be used.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "SQL SELECT query to execute",
      },
      params: {
        type: "array",
        items: {},
        description: "Query parameters for prepared statements",
      },
      limit: {
        type: "number",
        description: "Maximum rows to return (default: 100, max: 1000)",
        default: 100,
      },
    },
    required: ["query"],
  },
};

export const dbSchemaTool: Tool = {
  name: "zotero_db_schema",
  description:
    "Get database schema information. " +
    "If table is specified, returns columns for that table. " +
    "Otherwise returns list of all tables.",
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table name to get schema for (optional)",
      },
    },
  },
};

export const dbStatsTool: Tool = {
  name: "zotero_db_stats",
  description: "Get database statistics: item counts, file size, etc.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// Validate query is SELECT only
function validateQuery(query: string): void {
  const trimmed = query.trim().toLowerCase();

  // Must start with SELECT or WITH (for CTEs)
  if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
    throw new Error(
      "Only SELECT queries are allowed for safety. " +
        "To modify data, use zotero_execute_js with Zotero APIs."
    );
  }

  // Check for dangerous keywords
  const dangerous = [
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "create",
    "truncate",
    "replace",
    "attach",
    "detach",
  ];

  for (const keyword of dangerous) {
    // Check for keyword as a separate word (not part of column name)
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    if (regex.test(trimmed)) {
      throw new Error(
        `Query contains forbidden keyword: ${keyword.toUpperCase()}. ` +
          "Only SELECT queries are allowed."
      );
    }
  }
}

// Execute query via Zotero's DB API (preferred when Zotero is running)
async function executeViaZotero(
  query: string,
  params: unknown[],
  limit: number
): Promise<{ rows: unknown[]; columns: string[] }> {
  const client = await getRdpClient();

  // Add LIMIT if not present
  let finalQuery = query.trim();
  if (!finalQuery.toLowerCase().includes("limit")) {
    finalQuery = `${finalQuery} LIMIT ${limit}`;
  }

  const code = `
    (async () => {
      try {
        const query = ${JSON.stringify(finalQuery)};
        const params = ${JSON.stringify(params)};

        const rows = await Zotero.DB.queryAsync(query, params);

        // Get column names from first row
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

        return {
          rows: rows.slice(0, ${limit}),
          columns,
          total: rows.length
        };
      } catch (error) {
        return { error: error.message || String(error) };
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Query failed: ${response.exceptionMessage}`);
  }

  const result = RDPClient.gripToValue(response.result) as {
    rows?: unknown[];
    columns?: string[];
    total?: number;
    error?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  return {
    rows: result.rows || [],
    columns: result.columns || [],
  };
}

// Tool handlers
export async function handleDbQuery(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const query = args.query as string;
  const params = (args.params as unknown[]) || [];
  const limit = Math.min((args.limit as number) || 100, 1000);

  if (!query) {
    throw new Error("Missing required parameter: query");
  }

  validateQuery(query);

  const result = await executeViaZotero(query, params, limit);

  if (result.rows.length === 0) {
    return [{ type: "text", text: "Query returned no results" }];
  }

  // Format as table
  const lines: string[] = [];
  lines.push(`Query returned ${result.rows.length} row(s)`);
  lines.push(`Columns: ${result.columns.join(", ")}`);
  lines.push("");

  // JSON output for complex data
  lines.push(JSON.stringify(result.rows, null, 2));

  return [{ type: "text", text: lines.join("\n") }];
}

export async function handleDbSchema(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const table = args.table as string | undefined;

  const client = await getRdpClient();

  if (table) {
    // Get columns for specific table
    const code = `
      (async () => {
        try {
          const tableName = ${JSON.stringify(table)};
          const rows = await Zotero.DB.queryAsync(
            "PRAGMA table_info(" + tableName + ")"
          );

          if (rows.length === 0) {
            return { error: "Table not found: " + tableName };
          }

          return {
            table: tableName,
            columns: rows.map(r => ({
              name: r.name,
              type: r.type,
              nullable: !r.notnull,
              defaultValue: r.dflt_value,
              primaryKey: r.pk === 1
            }))
          };
        } catch (error) {
          return { error: error.message };
        }
      })()
    `;

    const response = await client.evaluateJS(code);

    if (response.exception) {
      throw new Error(`Schema query failed: ${response.exceptionMessage}`);
    }

    const result = RDPClient.gripToValue(response.result) as {
      table?: string;
      columns?: Array<{
        name: string;
        type: string;
        nullable: boolean;
        defaultValue: unknown;
        primaryKey: boolean;
      }>;
      error?: string;
    };

    if (result.error) {
      throw new Error(result.error);
    }

    const lines = [`Schema for table "${result.table}":\n`];

    for (const col of result.columns || []) {
      const flags = [];
      if (col.primaryKey) flags.push("PK");
      if (!col.nullable) flags.push("NOT NULL");
      if (col.defaultValue !== null) flags.push(`DEFAULT ${col.defaultValue}`);

      const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
      lines.push(`  ${col.name}: ${col.type}${flagStr}`);
    }

    return [{ type: "text", text: lines.join("\n") }];
  }

  // List all tables
  const code = `
    (async () => {
      try {
        const tables = await Zotero.DB.queryAsync(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        );

        const result = [];
        for (const t of tables) {
          const count = await Zotero.DB.valueQueryAsync(
            "SELECT COUNT(*) FROM " + t.name
          );
          result.push({ name: t.name, rowCount: count });
        }

        return result;
      } catch (error) {
        return { error: error.message };
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to list tables: ${response.exceptionMessage}`);
  }

  const result = RDPClient.gripToValue(response.result);

  if (typeof result === "object" && result !== null && "error" in result) {
    throw new Error((result as { error: string }).error);
  }

  const tables = result as Array<{ name: string; rowCount: number }>;

  const lines = [`Database tables (${tables.length}):\n`];

  for (const t of tables) {
    lines.push(`  ${t.name}: ${t.rowCount.toLocaleString()} rows`);
  }

  return [{ type: "text", text: lines.join("\n") }];
}

export async function handleDbStats(): Promise<TextContent[]> {
  const client = await getRdpClient();

  const code = `
    (async () => {
      try {
        const stats = {};

        // Item counts
        stats.items = await Zotero.DB.valueQueryAsync(
          "SELECT COUNT(*) FROM items WHERE itemID NOT IN (SELECT itemID FROM deletedItems)"
        );

        stats.attachments = await Zotero.DB.valueQueryAsync(
          "SELECT COUNT(*) FROM itemAttachments WHERE itemID NOT IN (SELECT itemID FROM deletedItems)"
        );

        stats.collections = await Zotero.DB.valueQueryAsync(
          "SELECT COUNT(*) FROM collections"
        );

        stats.tags = await Zotero.DB.valueQueryAsync(
          "SELECT COUNT(DISTINCT tagID) FROM itemTags"
        );

        stats.creators = await Zotero.DB.valueQueryAsync(
          "SELECT COUNT(*) FROM creators"
        );

        // Database file info
        const dbPath = Zotero.DataDirectory.dir + '/zotero.sqlite';
        stats.databasePath = dbPath;

        // Get file size via File API
        try {
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(dbPath);
          stats.databaseSize = file.fileSize;
        } catch (e) {
          stats.databaseSize = null;
        }

        // Library info
        const libraries = Zotero.Libraries.getAll();
        stats.libraries = libraries.map(lib => ({
          id: lib.libraryID,
          name: lib.name,
          type: lib.libraryType
        }));

        return stats;
      } catch (error) {
        return { error: error.message };
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to get stats: ${response.exceptionMessage}`);
  }

  const stats = RDPClient.gripToValue(response.result) as {
    items?: number;
    attachments?: number;
    collections?: number;
    tags?: number;
    creators?: number;
    databasePath?: string;
    databaseSize?: number;
    libraries?: Array<{ id: number; name: string; type: string }>;
    error?: string;
  };

  if (stats.error) {
    throw new Error(stats.error);
  }

  const formatSize = (bytes: number | null | undefined) => {
    if (!bytes) return "unknown";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const lines = [
    "Zotero Database Statistics",
    "─".repeat(40),
    "",
    `Items: ${stats.items?.toLocaleString()}`,
    `Attachments: ${stats.attachments?.toLocaleString()}`,
    `Collections: ${stats.collections?.toLocaleString()}`,
    `Tags: ${stats.tags?.toLocaleString()}`,
    `Creators: ${stats.creators?.toLocaleString()}`,
    "",
    `Database: ${stats.databasePath}`,
    `Size: ${formatSize(stats.databaseSize)}`,
    "",
    `Libraries (${stats.libraries?.length || 0}):`,
  ];

  for (const lib of stats.libraries || []) {
    lines.push(`  - ${lib.name} (${lib.type}, ID: ${lib.id})`);
  }

  return [{ type: "text", text: lines.join("\n") }];
}
