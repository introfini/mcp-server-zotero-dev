/**
 * Logging Tools
 *
 * Read debug output, errors, and stream logs
 */

import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { getRdpClient } from "../index.js";
import { RDPClient } from "../rdp/index.js";

// Tool definitions
export const readLogsTool: Tool = {
  name: "zotero_read_logs",
  description:
    "Read Zotero's debug log output. " +
    "Shows recent debug messages from Zotero.debug() calls.",
  inputSchema: {
    type: "object",
    properties: {
      lines: {
        type: "number",
        description: "Number of recent lines to return (default: 100)",
        default: 100,
      },
      filter: {
        type: "string",
        description: "Filter logs containing this string (case-insensitive)",
      },
      level: {
        type: "string",
        enum: ["all", "error", "warning", "info"],
        description: "Filter by log level (default: all)",
        default: "all",
      },
    },
  },
};

export const readErrorsTool: Tool = {
  name: "zotero_read_errors",
  description:
    "Read errors from Zotero's error console. " +
    "Returns JavaScript errors with stack traces and source locations.",
  inputSchema: {
    type: "object",
    properties: {
      lines: {
        type: "number",
        description: "Number of recent errors to return (default: 20)",
        default: 20,
      },
    },
  },
};

export const clearLogsTool: Tool = {
  name: "zotero_clear_logs",
  description: "Clear the debug log buffer and error console.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const watchLogsTool: Tool = {
  name: "zotero_watch_logs",
  description:
    "Start/stop watching for new log messages. " +
    "Use action='start' to begin collecting, 'get' to retrieve collected logs, 'stop' to end.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "get", "stop"],
        description: "Action to perform",
      },
    },
    required: ["action"],
  },
};

// Tool handlers
export async function handleReadLogs(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const lines = (args.lines as number) || 100;
  const filter = args.filter as string | undefined;
  const level = (args.level as string) || "all";

  const client = await getRdpClient();

  // Try to get console viewer output (if debug output is enabled)
  // Return as JSON string to avoid RDP preview limitations with arrays
  const code = `
    (() => {
      try {
        // Check if Zotero.Debug exists
        if (!Zotero.Debug) {
          return JSON.stringify({
            logs: [],
            debugEnabled: false,
            message: "Zotero.Debug not available"
          });
        }

        // Check if debug output is enabled
        const isEnabled = Zotero.Debug.enabled ||
                          (typeof Zotero.Debug.isEnabled === 'function' && Zotero.Debug.isEnabled());

        if (!isEnabled) {
          return JSON.stringify({
            logs: [],
            debugEnabled: false,
            message: "Debug output is not enabled. Enable it in Preferences → Advanced → Enable debug output"
          });
        }

        // Try multiple methods to get debug output (Zotero API varies by version)
        let output = '';

        // Method 1: getConsoleViewerOutput (Zotero 7+)
        if (!output && typeof Zotero.Debug.getConsoleViewerOutput === 'function') {
          try {
            output = Zotero.Debug.getConsoleViewerOutput() || '';
          } catch (e) {}
        }

        // Method 2: get() method
        if (!output && typeof Zotero.Debug.get === 'function') {
          try {
            output = Zotero.Debug.get() || '';
          } catch (e) {}
        }

        // Method 3: _console array (internal)
        if (!output && Array.isArray(Zotero.Debug._console)) {
          try {
            output = Zotero.Debug._console.join('\\n');
          } catch (e) {}
        }

        // Method 4: _output string (internal)
        if (!output && typeof Zotero.Debug._output === 'string') {
          output = Zotero.Debug._output;
        }

        if (!output) {
          return JSON.stringify({
            logs: [],
            debugEnabled: true,
            message: "Debug enabled but no output captured yet"
          });
        }

        // Parse and filter logs
        let logLines = output.split('\\n').filter(line => line.trim());

        // Filter by content
        ${
          filter
            ? `
          const filterLower = ${JSON.stringify(filter.toLowerCase())};
          logLines = logLines.filter(line => line.toLowerCase().includes(filterLower));
        `
            : ""
        }

        // Filter by level
        ${
          level !== "all"
            ? `
          logLines = logLines.filter(line => {
            const levelMatch = {
              'error': /\\[error\\]|error:|exception/i,
              'warning': /\\[warn\\]|warning:/i,
              'info': /\\[info\\]|info:/i
            };
            return levelMatch['${level}'].test(line);
          });
        `
            : ""
        }

        // Take last N lines
        logLines = logLines.slice(-${lines});

        return JSON.stringify({ logs: logLines, debugEnabled: true });
      } catch (error) {
        return JSON.stringify({ error: String(error.message || error) });
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to read logs: ${response.exceptionMessage}`);
  }

  const jsonString = RDPClient.gripToValue(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error(
      "Failed to read logs: received undefined result from Zotero.\n\n" +
        "Troubleshooting:\n" +
        "1. Verify Zotero is running and connected (use zotero_ping)\n" +
        "2. Check if debug logging is enabled:\n" +
        "   - Preferences -> Advanced -> Enable debug output\n" +
        "   - Or run: zotero_execute_js with 'Zotero.Debug.init(true)'\n" +
        "3. Try zotero_read_errors to check for JavaScript errors\n" +
        "4. If the issue persists, restart Zotero and reconnect"
    );
  }

  const result = JSON.parse(String(jsonString)) as {
    logs?: string[];
    debugEnabled?: boolean;
    message?: string;
    error?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  if (!result.debugEnabled) {
    return [
      {
        type: "text",
        text:
          "Debug output is not enabled.\n\n" +
          "To enable debug logging:\n" +
          "1. Go to Preferences → Advanced\n" +
          "2. Check 'Enable debug output'\n" +
          "3. Or run: Zotero.Debug.init(true)",
      },
    ];
  }

  if (!result.logs || result.logs.length === 0) {
    return [
      {
        type: "text",
        text: filter
          ? `No logs found matching "${filter}"`
          : "No debug logs available",
      },
    ];
  }

  const text = `Debug logs (${result.logs.length} lines):\n\n${result.logs.join("\n")}`;

  return [{ type: "text", text }];
}

export async function handleReadErrors(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const lines = (args.lines as number) || 20;

  const client = await getRdpClient();

  // Get errors from console service - return as JSON string
  const code = `
    (() => {
      try {
        const consoleService = Cc["@mozilla.org/consoleservice;1"]
          .getService(Ci.nsIConsoleService);

        const messages = [];
        const msgArray = consoleService.getMessageArray() || [];

        for (const msg of msgArray) {
          try {
            if (msg instanceof Ci.nsIScriptError) {
              // Safely extract stack - can be string, object, or null
              let stackStr = null;
              if (msg.stack) {
                if (typeof msg.stack === 'string') {
                  stackStr = msg.stack;
                } else if (typeof msg.stack.toString === 'function') {
                  stackStr = msg.stack.toString();
                }
              }

              messages.push({
                message: String(msg.errorMessage || ''),
                sourceName: String(msg.sourceName || ''),
                lineNumber: msg.lineNumber || 0,
                columnNumber: msg.columnNumber || 0,
                category: String(msg.category || ''),
                flags: msg.flags || 0,
                timestamp: msg.timeStamp || Date.now(),
                stack: stackStr
              });
            }
          } catch (itemError) {
            // Skip problematic messages
          }
        }

        // Sort by timestamp descending and take recent
        messages.sort((a, b) => b.timestamp - a.timestamp);
        return JSON.stringify(messages.slice(0, ${lines}));
      } catch (error) {
        return JSON.stringify({ error: String(error.message || error) });
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to read errors: ${response.exceptionMessage}`);
  }

  const jsonString = RDPClient.gripToValue(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error(
      "Failed to read errors: received undefined result from Zotero.\n\n" +
        "Troubleshooting:\n" +
        "1. Verify Zotero is running and connected (use zotero_ping)\n" +
        "2. Try zotero_execute_js with a simple test like 'Zotero.version'\n" +
        "3. Check for RDP connection issues (restart Zotero if needed)\n" +
        "4. Ensure the MCP Bridge for Zotero plugin is installed and active"
    );
  }

  const result = JSON.parse(String(jsonString));

  if (typeof result === "object" && result !== null && "error" in result) {
    throw new Error((result as { error: string }).error);
  }

  const errors = result as Array<{
    message?: string;
    sourceName?: string;
    lineNumber?: number;
    columnNumber?: number;
    category?: string;
    timestamp?: number;
    stack?: string;
  }>;

  if (!errors || errors.length === 0) {
    return [{ type: "text", text: "No errors in console" }];
  }

  const lines_output: string[] = [`Found ${errors.length} error(s):\n`];

  for (const err of errors) {
    const time = err.timestamp
      ? new Date(err.timestamp).toLocaleTimeString()
      : "unknown time";

    lines_output.push(`─────────────────────────────────────`);
    lines_output.push(`[${time}] ${err.message}`);

    if (err.sourceName) {
      lines_output.push(
        `  at ${err.sourceName}:${err.lineNumber}:${err.columnNumber}`
      );
    }

    if (err.stack && typeof err.stack === "string") {
      lines_output.push(`  Stack:\n    ${err.stack.replace(/\n/g, "\n    ")}`);
    }

    lines_output.push("");
  }

  return [{ type: "text", text: lines_output.join("\n") }];
}

export async function handleClearLogs(): Promise<TextContent[]> {
  const client = await getRdpClient();

  const code = `
    (() => {
      try {
        // Clear debug output
        if (Zotero.Debug && Zotero.Debug.clear) {
          Zotero.Debug.clear();
        }

        // Clear console service
        const consoleService = Cc["@mozilla.org/consoleservice;1"]
          .getService(Ci.nsIConsoleService);
        consoleService.reset();

        return { success: true };
      } catch (error) {
        return { error: error.message };
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to clear logs: ${response.exceptionMessage}`);
  }

  const resultValue = RDPClient.gripToValue(response.result);
  if (resultValue === undefined || resultValue === null) {
    // Assume success if no result (some Zotero versions don't return anything)
    return [{ type: "text", text: "Logs and error console cleared" }];
  }

  const result = resultValue as {
    success?: boolean;
    error?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  return [{ type: "text", text: "Logs and error console cleared" }];
}

export async function handleWatchLogs(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const action = args.action as string;

  if (!action || !["start", "get", "stop"].includes(action)) {
    throw new Error("Invalid action. Use 'start', 'get', or 'stop'");
  }

  const client = await getRdpClient();

  // Return as JSON string to avoid RDP preview limitations with nested objects
  const code = `
    (() => {
      try {
        const action = ${JSON.stringify(action)};

        if (action === 'start') {
          // Install hook if not already installed
          if (!Zotero._mcpLogBuffer) {
            Zotero._mcpLogBuffer = [];
            Zotero._mcpOriginalDebug = Zotero.debug;
            Zotero._mcpWatchStartTime = Date.now();

            Zotero.debug = function(...args) {
              const entry = {
                time: Date.now(),
                message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
              };
              Zotero._mcpLogBuffer.push(entry);

              // Keep buffer size reasonable
              if (Zotero._mcpLogBuffer.length > 1000) {
                Zotero._mcpLogBuffer.shift();
              }

              return Zotero._mcpOriginalDebug.apply(this, args);
            };

            return JSON.stringify({ action: 'started', message: 'Log watching started' });
          }
          return JSON.stringify({ action: 'already_running', message: 'Log watching already active' });
        }

        if (action === 'get') {
          if (!Zotero._mcpLogBuffer) {
            return JSON.stringify({ action: 'not_running', message: 'Log watching not started. Use action="start" first.' });
          }

          // Get and clear buffer
          const logs = Zotero._mcpLogBuffer.splice(0);
          return JSON.stringify({
            action: 'logs',
            count: logs.length,
            logs: logs.map(l => ({
              time: new Date(l.time).toLocaleTimeString(),
              message: l.message
            }))
          });
        }

        if (action === 'stop') {
          if (Zotero._mcpOriginalDebug) {
            Zotero.debug = Zotero._mcpOriginalDebug;
            delete Zotero._mcpOriginalDebug;
            delete Zotero._mcpLogBuffer;
            delete Zotero._mcpWatchStartTime;
            return JSON.stringify({ action: 'stopped', message: 'Log watching stopped' });
          }
          return JSON.stringify({ action: 'not_running', message: 'Log watching was not active' });
        }

        return JSON.stringify({ error: 'Unknown action' });
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Watch logs failed: ${response.exceptionMessage}`);
  }

  const jsonString = RDPClient.gripToValue(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error(
      "Watch logs failed: received undefined result from Zotero.\n\n" +
        "Troubleshooting:\n" +
        "1. Verify Zotero is running and connected (use zotero_ping)\n" +
        "2. Try zotero_execute_js with a simple test like 'Zotero.version'\n" +
        "3. Check for RDP connection issues (restart Zotero if needed)\n" +
        "4. Ensure the MCP Bridge for Zotero plugin is installed and active"
    );
  }

  const result = JSON.parse(String(jsonString)) as {
    action?: string;
    message?: string;
    count?: number;
    logs?: Array<{ time: string; message: string }>;
    error?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  if (result.action === "logs" && result.logs) {
    if (result.logs.length === 0) {
      return [{ type: "text", text: "No new logs since last check" }];
    }

    const lines = result.logs.map((l) => `[${l.time}] ${l.message}`);
    return [
      {
        type: "text",
        text: `Collected ${result.count} new log entries:\n\n${lines.join("\n")}`,
      },
    ];
  }

  return [{ type: "text", text: result.message || "Done" }];
}
