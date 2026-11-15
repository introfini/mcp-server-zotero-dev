/**
 * JavaScript Execution Tools
 *
 * Execute code in Zotero's privileged chrome context
 */

import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { getRdpClient } from "../index.js";
import { decodeWrappedError, evaluateUserCode, nullishGripToValue } from "./js-wrap.js";

/**
 * Detects if a result contains truncated grip values that lost information.
 */
function hasTruncatedValues(value: unknown): boolean {
  if (typeof value === "string") {
    // Check for common grip placeholder patterns
    return (
      value === "[Array]" ||
      value === "[Object]" ||
      value.includes('"[Array]"') ||
      value.includes('"[Object]"')
    );
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasTruncatedValues(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((v) => hasTruncatedValues(v));
  }
  return false;
}

// Tool definitions
export const executeJsTool: Tool = {
  name: "zotero_execute_js",
  description:
    "Execute JavaScript code in Zotero's privileged chrome context. " +
    "Has full access to Zotero APIs (Zotero.*, ZoteroPane, etc.). " +
    "Use for testing code snippets, inspecting state, or performing actions. " +
    "Prefer a dedicated tool when one fits the question (zotero_db_query for library data, zotero_read_logs/zotero_read_errors for output, zotero_inspect_object for API discovery); reach for raw JS only when none does. " +
    "Code with top-level 'return' statements is auto-wrapped in an IIFE. " +
    "Tip: For complex objects, use JSON.stringify(obj) to get full data. " +
    "IMPORTANT: Before calling unknown APIs, use zotero_inspect_object to discover available methods - don't guess API names.",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript code to execute. Can be async (automatically awaited). " +
          "You can use 'return' at top level - code will be auto-wrapped in IIFE.",
      },
      awaitPromise: {
        type: "boolean",
        description: "Whether to await the result if it's a Promise (default: true)",
        default: true,
      },
    },
    required: ["code"],
  },
};

export const getPrefTool: Tool = {
  name: "zotero_get_pref",
  description:
    "Get a Zotero preference value. " +
    "Common prefs: extensions.zotero.*, general.*, export.*",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Preference key (e.g., 'extensions.zotero.debug.log')",
      },
    },
    required: ["key"],
  },
};

export const setPrefTool: Tool = {
  name: "zotero_set_pref",
  description:
    "Set a Zotero preference value. " +
    "Use with caution - some preferences require restart.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Preference key",
      },
      value: {
        description: "Value to set (string, number, or boolean)",
      },
    },
    required: ["key", "value"],
  },
};

// Tool handlers
export async function handleExecuteJs(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const code = args.code as string;

  if (!code || typeof code !== "string") {
    throw new Error("Missing required parameter: code");
  }

  const client = await getRdpClient();

  // Wrapped in an IIFE when it needs one; see js-wrap.ts.
  const { response } = await evaluateUserCode(client, code);

  // A promise the code returned (its own async IIFE, say) rejected. Zotero's
  // reply carries no reason for it (see EvaluateJSResponse); the server's own
  // async wrapper catches errors itself, so this is code it did not wrap.
  if (response.topLevelAwaitRejected) {
    return [
      {
        type: "text",
        text:
          "Error executing JavaScript:\n\nThe code's promise was rejected. Zotero's reply does " +
          "not include the reason. To see it, write the code as plain statements with a " +
          "top-level await or return (the server then wraps it and reports what was thrown), " +
          "or catch the error yourself and return it.",
      },
    ];
  }

  if (response.exception || response.exceptionMessage) {
    const error = response.exceptionMessage || "Unknown error";
    let errorDetail = error;

    // Try to extract more info from the exception grip
    if (response.exception && typeof response.exception === "object") {
      const exc = response.exception as {
        preview?: { message?: string; stack?: string };
      };
      if (exc.preview?.stack) {
        errorDetail = `${error}\n\nStack trace:\n${exc.preview.stack}`;
      }
    }

    // Add contextual hints based on error type
    let hint = "";
    if (error.includes("is not a function")) {
      hint =
        "\n\n💡 Tip: Use zotero_inspect_object to discover available methods.\n" +
        'Example: zotero_inspect_object(path: "Zotero.Prefs", filter: "methods")';
    } else if (
      error.includes("is undefined") ||
      error.includes("is not defined")
    ) {
      hint =
        "\n\n💡 Tip: Use zotero_inspect_object to explore the API.\n" +
        'Example: zotero_inspect_object(path: "Zotero", pattern: "your_keyword")';
    }

    return [
      {
        type: "text",
        text: `Error executing JavaScript:\n\n${errorDetail}${hint}`,
      },
    ];
  }

  // Use async method to handle longString grips. gripToValue() hands the
  // undefined and null grips through as objects ({type: "undefined"}), which
  // printed as JSON; they are read off the raw grip first.
  const nullish = nullishGripToValue(response.result);
  const result = nullish === response.result ? await client.gripToValueAsync(response.result) : nullish;

  // What the server's async wrapper caught (js-wrap.ts wrapInIIFE).
  const thrown = decodeWrappedError(result);
  if (thrown) {
    return [
      {
        type: "text",
        text:
          `Error executing JavaScript:\n\n${thrown.name}: ${thrown.message}` +
          (thrown.stack ? `\n\nStack trace:\n${thrown.stack}` : ""),
      },
    ];
  }

  let resultText: string;

  if (result === undefined) {
    resultText = "undefined";
  } else if (result === null) {
    resultText = "null";
  } else if (typeof result === "object") {
    try {
      resultText = JSON.stringify(result, null, 2);
    } catch {
      resultText = String(result);
    }
  } else {
    resultText = String(result);
  }

  // Check for truncated values and add hint
  let truncationHint = "";
  if (hasTruncatedValues(result) || hasTruncatedValues(resultText)) {
    truncationHint =
      "\n\nNote: Some nested values appear truncated ([Array] or [Object]). " +
      "For full data, modify your code to return JSON.stringify(yourObject).";
  }

  return [
    {
      type: "text",
      text: `Result:\n${resultText}${truncationHint}`,
    },
  ];
}

export async function handleGetPref(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const key = args.key as string;

  if (!key || typeof key !== "string") {
    throw new Error("Missing required parameter: key");
  }

  const client = await getRdpClient();

  // Determine which API to use based on the preference path
  let code: string;
  if (key.startsWith("extensions.zotero.")) {
    // Use Zotero.Prefs for Zotero-specific prefs
    const zoteroKey = key.replace("extensions.zotero.", "");
    code = `Zotero.Prefs.get("${zoteroKey}")`;
  } else {
    // Use Services.prefs for general prefs
    code = `
      (() => {
        const prefs = Services.prefs;
        const type = prefs.getPrefType("${key}");
        switch (type) {
          case prefs.PREF_STRING:
            return prefs.getStringPref("${key}");
          case prefs.PREF_INT:
            return prefs.getIntPref("${key}");
          case prefs.PREF_BOOL:
            return prefs.getBoolPref("${key}");
          default:
            return null;
        }
      })()
    `;
  }

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to get preference: ${response.exceptionMessage}`);
  }

  // Use async method to handle longString grips
  const value = await client.gripToValueAsync(response.result);

  return [
    {
      type: "text",
      text: `${key} = ${JSON.stringify(value)}`,
    },
  ];
}

export async function handleSetPref(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const key = args.key as string;
  const value = args.value;

  if (!key || typeof key !== "string") {
    throw new Error("Missing required parameter: key");
  }

  if (value === undefined) {
    throw new Error("Missing required parameter: value");
  }

  const client = await getRdpClient();

  // Escape value for JavaScript
  const valueStr =
    typeof value === "string"
      ? `"${value.replace(/"/g, '\\"')}"`
      : JSON.stringify(value);

  // Determine which API to use
  let code: string;
  if (key.startsWith("extensions.zotero.")) {
    const zoteroKey = key.replace("extensions.zotero.", "");
    code = `Zotero.Prefs.set("${zoteroKey}", ${valueStr})`;
  } else {
    // Use Services.prefs for general prefs
    if (typeof value === "string") {
      code = `Services.prefs.setStringPref("${key}", ${valueStr})`;
    } else if (typeof value === "number") {
      code = `Services.prefs.setIntPref("${key}", ${valueStr})`;
    } else if (typeof value === "boolean") {
      code = `Services.prefs.setBoolPref("${key}", ${valueStr})`;
    } else {
      throw new Error(`Unsupported preference value type: ${typeof value}`);
    }
  }

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to set preference: ${response.exceptionMessage}`);
  }

  return [
    {
      type: "text",
      text: `Set ${key} = ${JSON.stringify(value)}`,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// New Tool: zotero_search_prefs
// ─────────────────────────────────────────────────────────────────────────────

export const searchPrefsTool: Tool = {
  name: "zotero_search_prefs",
  description:
    "Search and list Zotero/Firefox preferences. " +
    "Use to discover available preference keys before using zotero_get_pref/zotero_set_pref. " +
    "Can filter by branch prefix (e.g., 'extensions.zotero.') and/or substring pattern.",
  inputSchema: {
    type: "object",
    properties: {
      branch: {
        type: "string",
        description:
          "Preference branch to list (e.g., 'extensions.zotero.', 'general.'). " +
          "Defaults to 'extensions.zotero.' if not specified.",
      },
      pattern: {
        type: "string",
        description: "Substring filter for preference names (case-insensitive)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 50)",
        default: 50,
      },
    },
  },
};

export async function handleSearchPrefs(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const branch = (args.branch as string) || "extensions.zotero.";
  const pattern = args.pattern as string | undefined;
  const limit = (args.limit as number) || 50;

  const client = await getRdpClient();

  // Return as JSON string to get full data
  const code = `
    (() => {
      try {
        const branch = ${JSON.stringify(branch)};
        const pattern = ${pattern ? JSON.stringify(pattern.toLowerCase()) : "null"};
        const limit = ${limit};

        const prefs = Services.prefs;
        const childList = prefs.getChildList(branch);
        const results = [];

        for (const fullKey of childList) {
          // Apply pattern filter
          if (pattern && !fullKey.toLowerCase().includes(pattern)) {
            continue;
          }

          // Get value and type
          const type = prefs.getPrefType(fullKey);
          let value = null;
          let typeStr = 'unknown';

          switch (type) {
            case prefs.PREF_STRING:
              value = prefs.getStringPref(fullKey);
              typeStr = 'string';
              break;
            case prefs.PREF_INT:
              value = prefs.getIntPref(fullKey);
              typeStr = 'number';
              break;
            case prefs.PREF_BOOL:
              value = prefs.getBoolPref(fullKey);
              typeStr = 'boolean';
              break;
          }

          results.push({ key: fullKey, value, type: typeStr });

          if (results.length >= limit) {
            break;
          }
        }

        return JSON.stringify({
          branch,
          pattern: pattern || null,
          count: results.length,
          total: childList.length,
          prefs: results
        });
      } catch (error) {
        return JSON.stringify({ error: String(error.message || error) });
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to search preferences: ${response.exceptionMessage}`);
  }

  const jsonString = await client.gripToValueAsync(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Failed to search preferences: received undefined result");
  }

  const result = JSON.parse(String(jsonString)) as {
    branch?: string;
    pattern?: string | null;
    count?: number;
    total?: number;
    prefs?: Array<{ key: string; value: unknown; type: string }>;
    error?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  if (!result.prefs || result.prefs.length === 0) {
    return [
      {
        type: "text",
        text: pattern
          ? `No preferences found matching "${pattern}" in branch "${branch}"`
          : `No preferences found in branch "${branch}"`,
      },
    ];
  }

  // Format output
  const count = result.count ?? result.prefs.length;
  const total = result.total ?? count;
  const lines: string[] = [
    `Found ${count} preference(s)${total > count ? ` (of ${total} total in branch)` : ""}:\n`,
  ];

  for (const pref of result.prefs) {
    const valueStr =
      typeof pref.value === "string"
        ? `"${pref.value.length > 60 ? pref.value.slice(0, 60) + "..." : pref.value}"`
        : String(pref.value);
    lines.push(`${pref.key} = ${valueStr} (${pref.type})`);
  }

  if (total > count) {
    lines.push(`\n... and ${total - count} more. Use 'limit' parameter to see more.`);
  }

  return [{ type: "text", text: lines.join("\n") }];
}

// ─────────────────────────────────────────────────────────────────────────────
// New Tool: zotero_inspect_object
// ─────────────────────────────────────────────────────────────────────────────

export const inspectObjectTool: Tool = {
  name: "zotero_inspect_object",
  description:
    "Inspect a Zotero/JavaScript object to discover its methods and properties. " +
    "Use to explore APIs like Zotero.Items, ZoteroPane, Zotero.Prefs without manual JS execution. " +
    "Returns methods with signatures and properties with their types/values.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Object path to inspect (e.g., 'Zotero', 'Zotero.Items', 'ZoteroPane', 'Zotero.Prefs')",
      },
      filter: {
        type: "string",
        enum: ["all", "methods", "properties", "own"],
        description:
          "What to include: 'all' (default), 'methods' only, 'properties' only, or 'own' (only own properties, not inherited)",
        default: "all",
      },
      depth: {
        type: "number",
        description: "Prototype chain depth to inspect (default: 2, max: 5)",
        default: 2,
      },
      pattern: {
        type: "string",
        description: "Filter member names by substring (case-insensitive)",
      },
    },
    required: ["path"],
  },
};

// Security: Validate object path to prevent code injection
function isValidObjectPath(path: string): boolean {
  // Reject obvious code injection attempts
  const dangerousPatterns = [";", "{", "}", "eval", "Function", "(", ")", "`", "$"];
  for (const pattern of dangerousPatterns) {
    if (path.includes(pattern)) {
      return false;
    }
  }

  // Must be a valid property path (identifiers separated by dots)
  const validPath = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;
  return validPath.test(path);
}

export async function handleInspectObject(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const path = args.path as string;
  const filter = (args.filter as string) || "all";
  const depth = Math.min(Math.max((args.depth as number) || 2, 1), 5);
  const pattern = args.pattern as string | undefined;

  if (!path || typeof path !== "string") {
    throw new Error("Missing required parameter: path");
  }

  if (!isValidObjectPath(path)) {
    throw new Error(
      `Invalid object path: "${path}". Path must be a valid property chain (e.g., 'Zotero.Items').`
    );
  }

  const client = await getRdpClient();

  // Return as JSON string to get full data
  const code = `
    (() => {
      try {
        const path = ${JSON.stringify(path)};
        const filter = ${JSON.stringify(filter)};
        const maxDepth = ${depth};
        const pattern = ${pattern ? JSON.stringify(pattern.toLowerCase()) : "null"};

        // Resolve the object path
        let obj = globalThis;
        for (const part of path.split('.')) {
          if (obj === undefined || obj === null) {
            return JSON.stringify({ error: \`Cannot access '\${part}' - parent is \${obj}\` });
          }
          obj = obj[part];
        }

        if (obj === undefined) {
          return JSON.stringify({ error: \`Object '\${path}' is undefined\` });
        }

        if (obj === null) {
          return JSON.stringify({ error: \`Object '\${path}' is null\` });
        }

        const result = {
          path,
          type: typeof obj,
          constructorName: obj.constructor?.name || 'unknown',
          methods: [],
          properties: [],
          prototypeChain: []
        };

        // Collect all property names across prototype chain
        const seen = new Set();
        let current = obj;
        let currentDepth = 0;

        while (current && currentDepth < maxDepth) {
          const protoName = current.constructor?.name || 'Object';
          const levelInfo = { level: currentDepth, prototype: protoName, members: [] };

          const ownKeys = filter === 'own' && currentDepth > 0
            ? []
            : Object.getOwnPropertyNames(current);

          for (const key of ownKeys) {
            if (seen.has(key)) continue;
            seen.add(key);

            // Apply pattern filter
            if (pattern && !key.toLowerCase().includes(pattern)) {
              continue;
            }

            try {
              const descriptor = Object.getOwnPropertyDescriptor(current, key);
              const value = obj[key]; // Access from original object
              const valueType = typeof value;

              if (valueType === 'function') {
                if (filter === 'properties') continue;

                // Try to get function signature
                let signature = key + '()';
                try {
                  const fnStr = value.toString();
                  const match = fnStr.match(/^(?:async\\s+)?(?:function\\s*)?([^{]+)/);
                  if (match) {
                    signature = match[1].trim();
                    // Clean up arrow functions
                    if (signature.includes('=>')) {
                      signature = key + signature.substring(signature.indexOf('('));
                      signature = signature.split('=>')[0].trim();
                    }
                  }
                } catch (e) {}

                result.methods.push({
                  name: key,
                  signature,
                  level: currentDepth
                });
              } else {
                if (filter === 'methods') continue;

                let displayValue = null;
                try {
                  if (value === null) {
                    displayValue = 'null';
                  } else if (value === undefined) {
                    displayValue = 'undefined';
                  } else if (valueType === 'string') {
                    displayValue = value.length > 50 ? value.slice(0, 50) + '...' : value;
                  } else if (valueType === 'number' || valueType === 'boolean') {
                    displayValue = value;
                  } else if (Array.isArray(value)) {
                    displayValue = \`Array[\${value.length}]\`;
                  } else if (valueType === 'object') {
                    displayValue = value.constructor?.name || 'Object';
                  }
                } catch (e) {
                  displayValue = '<error accessing>';
                }

                result.properties.push({
                  name: key,
                  type: valueType,
                  value: displayValue,
                  level: currentDepth,
                  getter: !!descriptor?.get,
                  setter: !!descriptor?.set
                });
              }
            } catch (e) {
              // Skip inaccessible properties
            }
          }

          result.prototypeChain.push(protoName);
          current = Object.getPrototypeOf(current);
          currentDepth++;
        }

        // Sort alphabetically
        result.methods.sort((a, b) => a.name.localeCompare(b.name));
        result.properties.sort((a, b) => a.name.localeCompare(b.name));

        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ error: String(error.message || error) });
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to inspect object: ${response.exceptionMessage}`);
  }

  const jsonString = await client.gripToValueAsync(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Failed to inspect object: received undefined result");
  }

  const result = JSON.parse(String(jsonString)) as {
    path?: string;
    type?: string;
    constructorName?: string;
    methods?: Array<{ name: string; signature: string; level: number }>;
    properties?: Array<{
      name: string;
      type: string;
      value: unknown;
      level: number;
      getter?: boolean;
      setter?: boolean;
    }>;
    prototypeChain?: string[];
    error?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  // Format output
  const lines: string[] = [
    `## ${result.path}`,
    `Type: ${result.type} (${result.constructorName})`,
    `Prototype chain: ${result.prototypeChain?.join(" → ") || "unknown"}`,
    "",
  ];

  if (result.methods && result.methods.length > 0 && filter !== "properties") {
    lines.push(`### Methods (${result.methods.length})`);
    for (const m of result.methods) {
      const level = m.level > 0 ? ` [inherited]` : "";
      lines.push(`  ${m.signature}${level}`);
    }
    lines.push("");
  }

  if (result.properties && result.properties.length > 0 && filter !== "methods") {
    lines.push(`### Properties (${result.properties.length})`);
    for (const p of result.properties) {
      const level = p.level > 0 ? " [inherited]" : "";
      const accessor = p.getter || p.setter ? " [accessor]" : "";
      const valueStr =
        typeof p.value === "string" ? `"${p.value}"` : String(p.value);
      lines.push(`  ${p.name}: ${p.type} = ${valueStr}${level}${accessor}`);
    }
  }

  if (
    (!result.methods || result.methods.length === 0) &&
    (!result.properties || result.properties.length === 0)
  ) {
    lines.push(
      pattern
        ? `No members found matching "${pattern}"`
        : "No accessible members found"
    );
  }

  return [{ type: "text", text: lines.join("\n") }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: zotero_open_preferences
// ─────────────────────────────────────────────────────────────────────────────

export const openPreferencesTool: Tool = {
  name: "zotero_open_preferences",
  description:
    "Open Zotero's preferences/settings window. Optionally navigate directly to a specific pane. " +
    "For built-in panes, use: 'general', 'sync', 'export', 'cite', 'advanced'. " +
    "For plugin panes, use the plugin ID (e.g., 'zotseek@zotero.org' or just 'zotseek').",
  inputSchema: {
    type: "object",
    properties: {
      paneId: {
        type: "string",
        description:
          "Optional pane ID to navigate to. Built-in: 'general', 'sync', 'export', 'cite', 'advanced'. " +
          "For plugins: use the plugin ID (e.g., 'zotseek@zotero.org'). If omitted, opens to the last viewed pane.",
      },
    },
    required: [],
  },
};

export async function handleOpenPreferences(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const paneId = args.paneId as string | undefined;

  const client = await getRdpClient();

  // Open the pane. We only need the side effect, so the eval returns nothing:
  // that avoids a top-level `return` (no IIFE needed) and keeps paneId out of a
  // generated string literal — it is only ever a JSON.stringify'd argument, so a
  // paneId containing a quote can't break the snippet. The success message is
  // built here in TypeScript instead of inside the eval.
  const code = paneId
    ? `Zotero.Utilities.Internal.openPreferences(${JSON.stringify(paneId)})`
    : `Zotero.Utilities.Internal.openPreferences()`;

  const response = await client.evaluateJS(code);

  if (response.exception || response.exceptionMessage) {
    const error = response.exceptionMessage || "Unknown error";
    return [
      {
        type: "text",
        text: `Error opening preferences: ${error}`,
      },
    ];
  }

  const result = paneId
    ? `Preferences opened to: ${paneId}`
    : "Preferences window opened";

  // Also list available panes for reference
  const panesCode = `
    JSON.stringify({
      builtIn: Zotero.PreferencePanes.builtInPanes
        .filter(p => !p.id.includes('subpane'))
        .map(p => p.id.replace('zotero-prefpane-', '')),
      plugins: Zotero.PreferencePanes.pluginPanes.map(p => p.pluginID)
    })
  `;

  const panesResponse = await client.evaluateJS(panesCode);
  let panesInfo = "";

  if (!panesResponse.exception) {
    try {
      const panesJson = await client.gripToValueAsync(panesResponse.result);
      const panes = JSON.parse(String(panesJson)) as {
        builtIn: string[];
        plugins: string[];
      };
      panesInfo =
        "\n\nAvailable panes:\n" +
        `  Built-in: ${panes.builtIn.join(", ")}\n` +
        `  Plugins: ${panes.plugins.join(", ")}`;
    } catch {
      // Ignore parsing errors
    }
  }

  return [
    {
      type: "text",
      text: `${result}${panesInfo}`,
    },
  ];
}
