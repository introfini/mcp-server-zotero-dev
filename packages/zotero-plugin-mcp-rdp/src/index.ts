/**
 * MCP Bridge for Zotero Plugin
 *
 * A lightweight Zotero plugin that enables
 * the Firefox Remote Debugging Protocol (RDP) on startup.
 *
 * This allows the MCP server to communicate with Zotero for:
 * - JavaScript execution
 * - DOM inspection
 * - Screenshots
 * - Console access
 */

// Declare Zotero globals
declare const Zotero: {
  debug: (message: string, level?: number) => void;
  uiReadyPromise: Promise<void>;
  Prefs: {
    get: (key: string, fallback?: unknown) => unknown;
  };
};

declare const ChromeUtils: {
  importESModule: (url: string) => {
    DevToolsServer?: {
      initialized: boolean;
      init: () => void;
      registerAllActors: () => void;
      openListener: (options: { portOrPath: number; host: string }) => unknown;
      closeAllListeners: () => void;
    };
  };
};

// Configuration
const DEFAULT_PORT = 6100;
const DEFAULT_HOST = "127.0.0.1"; // Localhost only for security

/**
 * Start the RDP server
 */
async function startRDPServer(): Promise<void> {
  // Wait for Zotero UI to be ready
  await Zotero.uiReadyPromise;

  // Get configuration from preferences (with defaults)
  const port = (Zotero.Prefs.get("extensions.mcp-rdp.port") as number) || DEFAULT_PORT;
  const enabled = Zotero.Prefs.get("extensions.mcp-rdp.enabled") !== false;

  if (!enabled) {
    Zotero.debug("[MCP] RDP server disabled by preference");
    return;
  }

  try {
    // Import the DevToolsServer module
    const { DevToolsServer } = ChromeUtils.importESModule(
      "resource://devtools/server/devtools-server.mjs"
    );

    if (!DevToolsServer) {
      Zotero.debug("[MCP] DevToolsServer not available");
      return;
    }

    // Initialize if needed
    if (!DevToolsServer.initialized) {
      DevToolsServer.init();
    }

    // Register all actor types (Console, Inspector, etc.)
    DevToolsServer.registerAllActors();

    // Start listening on the configured port
    const listener = DevToolsServer.openListener({
      portOrPath: port,
      host: DEFAULT_HOST,
    });

    if (listener) {
      Zotero.debug(`[MCP] RDP server listening on ${DEFAULT_HOST}:${port}`);
    } else {
      Zotero.debug("[MCP] RDP server failed to start - openListener returned null");
    }
  } catch (error) {
    Zotero.debug(`[MCP] Error starting RDP server: ${error}`);
  }
}

/**
 * Stop the RDP server
 */
function stopRDPServer(): void {
  try {
    const { DevToolsServer } = ChromeUtils.importESModule(
      "resource://devtools/server/devtools-server.mjs"
    );

    if (DevToolsServer) {
      DevToolsServer.closeAllListeners();
      Zotero.debug("[MCP] RDP server stopped");
    }
  } catch (error) {
    // Ignore errors on shutdown
  }
}

// Plugin lifecycle hooks - these are called by Zotero's bootstrap mechanism
export function onStartup(): void {
  startRDPServer().catch((error) => {
    Zotero.debug(`[MCP] Startup error: ${error}`);
  });
}

export function onShutdown(): void {
  stopRDPServer();
}

// For bootstrap.js compatibility
if (typeof module !== "undefined") {
  module.exports = { onStartup, onShutdown };
}
