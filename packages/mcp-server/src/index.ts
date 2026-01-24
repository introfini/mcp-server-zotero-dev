#!/usr/bin/env node

/**
 * MCP Server for Zotero Plugin Development
 *
 * Enables AI assistants to build, test, and debug Zotero plugins by providing:
 * - UI inspection (screenshots, DOM, styles)
 * - JavaScript execution in Zotero context
 * - Build tool integration (scaffold)
 * - Log reading and error tracking
 * - Database access (read-only)
 * - Plugin management
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool,
  type TextContent,
  type ImageContent,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient, RDPClient } from "./rdp/index.js";
import { loadConfig, type Config } from "./utils/config.js";

// Tool handlers - imported from tools directory
import {
  executeJsTool,
  getPrefTool,
  setPrefTool,
  searchPrefsTool,
  inspectObjectTool,
  handleExecuteJs,
  handleGetPref,
  handleSetPref,
  handleSearchPrefs,
  handleInspectObject,
} from "./tools/execute.js";
import { screenshotTool, handleScreenshot } from "./tools/screenshot.js";
import {
  inspectElementTool,
  getDomTreeTool,
  getStylesTool,
  listWindowsTool,
  handleInspectElement,
  handleGetDomTree,
  handleGetStyles,
  handleListWindows,
} from "./tools/inspect.js";
import {
  readLogsTool,
  readErrorsTool,
  clearLogsTool,
  watchLogsTool,
  handleReadLogs,
  handleReadErrors,
  handleClearLogs,
  handleWatchLogs,
} from "./tools/logs.js";
import {
  scaffoldBuildTool,
  scaffoldServeTool,
  scaffoldLintTool,
  scaffoldTypecheckTool,
  handleScaffoldBuild,
  handleScaffoldServe,
  handleScaffoldLint,
  handleScaffoldTypecheck,
} from "./tools/scaffold.js";
import {
  pluginReloadTool,
  pluginListTool,
  pluginInstallTool,
  handlePluginReload,
  handlePluginList,
  handlePluginInstall,
} from "./tools/plugins.js";
import {
  dbQueryTool,
  dbSchemaTool,
  dbStatsTool,
  handleDbQuery,
  handleDbSchema,
  handleDbStats,
} from "./tools/database.js";
import { allPrompts, getPromptHandler } from "./prompts/index.js";

// Server instance
const server = new Server(
  {
    name: "mcp-server-zotero-dev",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

// Shared state
let rdpClient: RDPClient | null = null;
let config: Config;

/**
 * Get or create the RDP client
 */
export async function getRdpClient(): Promise<RDPClient> {
  if (!rdpClient) {
    rdpClient = createClient({
      host: config.rdp.host,
      port: config.rdp.port,
    });
  }

  if (!rdpClient.isConnected()) {
    await rdpClient.connect();
  }

  return rdpClient;
}

/**
 * Get the current configuration
 */
export function getConfig(): Config {
  return config;
}

// Ping tool definition
const pingTool: Tool = {
  name: "zotero_ping",
  description:
    "Test connection to Zotero and get version info. " +
    "Use this to verify that Zotero is running and the MCP Bridge for Zotero plugin is active.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

/**
 * Handle the ping tool
 */
async function handlePing(): Promise<TextContent[]> {
  try {
    const client = await getRdpClient();

    // Execute JS to get Zotero version
    const versionResult = await client.evaluateJS("Zotero.version");
    const version = await client.gripToValueAsync(versionResult.result);

    // Get app name
    const appResult = await client.evaluateJS("Zotero.appName");
    const appName = await client.gripToValueAsync(appResult.result);

    // Get platform
    const platformResult = await client.evaluateJS("Zotero.platformMajorVersion");
    const platformVersion = await client.gripToValueAsync(platformResult.result);

    // Get data directory
    const dataDirResult = await client.evaluateJS("Zotero.DataDirectory.dir");
    const dataDir = await client.gripToValueAsync(dataDirResult.result);

    return [
      {
        type: "text",
        text:
          `✓ Connected to ${appName} ${version}\n` +
          `  Platform: Firefox ${platformVersion}\n` +
          `  Data directory: ${dataDir}\n` +
          `  RDP port: ${config.rdp.port}\n\n` +
          `Ready to help with Zotero plugin development!`,
      },
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      {
        type: "text",
        text:
          `✗ Cannot connect to Zotero\n\n` +
          `Error: ${message}\n\n` +
          `Troubleshooting:\n` +
          `1. Make sure Zotero is running\n` +
          `2. Install the MCP Bridge for Zotero plugin in Zotero:\n` +
          `   Tools → Add-ons → ⚙️ → Install from file\n` +
          `3. Restart Zotero after installing the plugin\n` +
          `4. Check that port ${config.rdp.port} is not blocked`,
      },
    ];
  }
}

// Collect all tools
const allTools: Tool[] = [
  pingTool,
  executeJsTool,
  getPrefTool,
  setPrefTool,
  searchPrefsTool,
  inspectObjectTool,
  screenshotTool,
  inspectElementTool,
  getDomTreeTool,
  getStylesTool,
  listWindowsTool,
  readLogsTool,
  readErrorsTool,
  clearLogsTool,
  watchLogsTool,
  scaffoldBuildTool,
  scaffoldServeTool,
  scaffoldLintTool,
  scaffoldTypecheckTool,
  pluginReloadTool,
  pluginListTool,
  pluginInstallTool,
  dbQueryTool,
  dbSchemaTool,
  dbStatsTool,
];

// Register tool listing handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allTools };
});

// Register prompt listing handler
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: allPrompts };
});

// Register prompt execution handler
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return getPromptHandler(name, args || {});
});

// Register tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let content: (TextContent | ImageContent)[];

    switch (name) {
      // Core tools
      case "zotero_ping":
        content = await handlePing();
        break;
      case "zotero_execute_js":
        content = await handleExecuteJs(args as Record<string, unknown>);
        break;
      case "zotero_get_pref":
        content = await handleGetPref(args as Record<string, unknown>);
        break;
      case "zotero_set_pref":
        content = await handleSetPref(args as Record<string, unknown>);
        break;
      case "zotero_search_prefs":
        content = await handleSearchPrefs(args as Record<string, unknown>);
        break;
      case "zotero_inspect_object":
        content = await handleInspectObject(args as Record<string, unknown>);
        break;

      // Screenshot
      case "zotero_screenshot":
        content = await handleScreenshot(args as Record<string, unknown>);
        break;

      // Inspection tools
      case "zotero_inspect_element":
        content = await handleInspectElement(args as Record<string, unknown>);
        break;
      case "zotero_get_dom_tree":
        content = await handleGetDomTree(args as Record<string, unknown>);
        break;
      case "zotero_get_styles":
        content = await handleGetStyles(args as Record<string, unknown>);
        break;
      case "zotero_list_windows":
        content = await handleListWindows();
        break;

      // Logging tools
      case "zotero_read_logs":
        content = await handleReadLogs(args as Record<string, unknown>);
        break;
      case "zotero_read_errors":
        content = await handleReadErrors(args as Record<string, unknown>);
        break;
      case "zotero_clear_logs":
        content = await handleClearLogs();
        break;
      case "zotero_watch_logs":
        content = await handleWatchLogs(args as Record<string, unknown>);
        break;

      // Scaffold tools
      case "zotero_scaffold_build":
        content = await handleScaffoldBuild(args as Record<string, unknown>);
        break;
      case "zotero_scaffold_serve":
        content = await handleScaffoldServe(args as Record<string, unknown>);
        break;
      case "zotero_scaffold_lint":
        content = await handleScaffoldLint(args as Record<string, unknown>);
        break;
      case "zotero_scaffold_typecheck":
        content = await handleScaffoldTypecheck(args as Record<string, unknown>);
        break;

      // Plugin tools
      case "zotero_plugin_reload":
        content = await handlePluginReload(args as Record<string, unknown>);
        break;
      case "zotero_plugin_list":
        content = await handlePluginList();
        break;
      case "zotero_plugin_install":
        content = await handlePluginInstall(args as Record<string, unknown>);
        break;

      // Database tools
      case "zotero_db_query":
        content = await handleDbQuery(args as Record<string, unknown>);
        break;
      case "zotero_db_schema":
        content = await handleDbSchema(args as Record<string, unknown>);
        break;
      case "zotero_db_stats":
        content = await handleDbStats();
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Main entry point
async function main() {
  // Load configuration
  config = loadConfig();

  console.error(`MCP Server Zotero Dev starting...`);
  console.error(`RDP target: ${config.rdp.host}:${config.rdp.port}`);

  if (config.zotero.dataDir) {
    console.error(`Zotero data: ${config.zotero.dataDir}`);
  }

  // Create transport and connect
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("MCP Server Zotero Dev running");
}

// Handle shutdown
process.on("SIGINT", () => {
  if (rdpClient) {
    rdpClient.disconnect();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (rdpClient) {
    rdpClient.disconnect();
  }
  process.exit(0);
});

// Run
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
