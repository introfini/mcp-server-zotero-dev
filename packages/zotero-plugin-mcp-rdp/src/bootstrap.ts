/**
 * Bootstrap entry point for Zotero plugin
 *
 * Zotero 7+ uses a bootstrap.js pattern similar to Firefox extensions.
 * This file is the actual entry point that Zotero loads.
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
const RDP_PORT = 6100;
const RDP_HOST = "127.0.0.1";

let rdpStarted = false;

/**
 * Called when the plugin is installed or enabled
 */
export async function startup(
  { id, version, resourceURI, rootURI }: {
    id: string;
    version: string;
    resourceURI: unknown;
    rootURI: string;
  },
  reason: number
): Promise<void> {
  // Wait for Zotero to be ready
  await Zotero.uiReadyPromise;

  // Check if enabled via preference
  const enabled = Zotero.Prefs.get("extensions.mcp-rdp.enabled") !== false;
  if (!enabled) {
    Zotero.debug("[MCP RDP] Disabled by preference");
    return;
  }

  // Get port from preference or use default
  const port = (Zotero.Prefs.get("extensions.mcp-rdp.port") as number) || RDP_PORT;

  try {
    const { DevToolsServer } = ChromeUtils.importESModule(
      "resource://devtools/server/devtools-server.mjs"
    );

    if (!DevToolsServer) {
      Zotero.debug("[MCP RDP] DevToolsServer module not available");
      return;
    }

    if (!DevToolsServer.initialized) {
      DevToolsServer.init();
    }

    DevToolsServer.registerAllActors();

    const listener = DevToolsServer.openListener({
      portOrPath: port,
      host: RDP_HOST,
    });

    if (listener) {
      rdpStarted = true;
      Zotero.debug(`[MCP RDP] Server listening on ${RDP_HOST}:${port}`);
    } else {
      Zotero.debug("[MCP RDP] Failed to start listener");
    }
  } catch (error) {
    Zotero.debug(`[MCP RDP] Error: ${error}`);
  }
}

/**
 * Called when the plugin is disabled or uninstalled
 */
export function shutdown(
  { id, version, resourceURI, rootURI }: {
    id: string;
    version: string;
    resourceURI: unknown;
    rootURI: string;
  },
  reason: number
): void {
  if (!rdpStarted) return;

  try {
    const { DevToolsServer } = ChromeUtils.importESModule(
      "resource://devtools/server/devtools-server.mjs"
    );

    if (DevToolsServer) {
      DevToolsServer.closeAllListeners();
      Zotero.debug("[MCP RDP] Server stopped");
    }
  } catch {
    // Ignore errors during shutdown
  }

  rdpStarted = false;
}

/**
 * Called when the plugin is installed
 */
export function install(): void {
  // Nothing to do on install
}

/**
 * Called when the plugin is uninstalled
 */
export function uninstall(): void {
  // Nothing to do on uninstall
}
