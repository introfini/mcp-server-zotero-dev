/**
 * MCP Bridge for Zotero - Bootstrap
 *
 * Enables Firefox DevTools Remote Debugging Protocol for AI-assisted
 * Zotero plugin development.
 */

var rdpStarted = false;
var rdpListener = null;
var DevToolsServer = null;
var SocketListener = null;
var rdpPort = 6100;
var isShuttingDown = false;
var devToolsLoader = null;

// Log using dump() and Zotero.debug() - console is NOT available in bootstrap context
function log(msg) {
  var fullMsg = "[MCP RDP] " + msg;
  dump(fullMsg + "\n");
  try {
    if (typeof Zotero !== "undefined" && Zotero.debug) {
      Zotero.debug(fullMsg);
    }
  } catch (e) {}
}

// Initialize or reinitialize the DevTools stack
function initDevToolsStack() {
  try {
    var loaderModule = ChromeUtils.importESModule(
      "resource://devtools/shared/loader/Loader.sys.mjs"
    );

    var DevToolsLoader = loaderModule.DevToolsLoader;
    devToolsLoader = new DevToolsLoader({ freshCompartment: true });

    var devtoolsModule = devToolsLoader.require("devtools/server/devtools-server");
    var socketModule = devToolsLoader.require("devtools/shared/security/socket");
    DevToolsServer = devtoolsModule.DevToolsServer;
    SocketListener = socketModule.SocketListener;

    if (!DevToolsServer.initialized) {
      DevToolsServer.init();
    }
    DevToolsServer.registerAllActors();
    DevToolsServer.allowChromeProcess = true;

    log("DevTools stack initialized");
    return true;
  } catch (e) {
    log("Error initializing DevTools stack: " + e);
    return false;
  }
}

// Create and open the RDP listener
async function openListener() {
  if (isShuttingDown) return false;

  try {
    // Close existing listener if any
    if (rdpListener) {
      try { rdpListener.close(); } catch (e) {}
      rdpListener = null;
    }

    // Initialize or reinitialize the DevTools stack if needed
    if (!DevToolsServer || !DevToolsServer.initialized) {
      if (!initDevToolsStack()) {
        return false;
      }
    }

    rdpListener = new SocketListener(DevToolsServer, { portOrPath: rdpPort });
    await rdpListener.open();
    log("Listener opened on port " + rdpPort);
    return true;
  } catch (e) {
    log("Error opening listener: " + e);
    rdpListener = null;
    // Reset stack on error so it will be recreated next time
    DevToolsServer = null;
    SocketListener = null;
    devToolsLoader = null;
    return false;
  }
}

// Simple periodic reopener - tries to open listener every few seconds
// If listener is already running, the open() will fail harmlessly (port in use)
var healthCheckInterval = null;

function startHealthCheck() {
  if (healthCheckInterval) return;

  healthCheckInterval = setInterval(function() {
    if (isShuttingDown) {
      stopHealthCheck();
      return;
    }

    // Simply try to reopen - openListener handles errors gracefully
    openListener().then(function(success) {
      if (success) {
        log("Listener reopened by health check");
      }
    }).catch(function() {
      // Silently ignore - might be already listening
    });
  }, 2000);  // Try every 2 seconds

  log("Health check started");
}

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    log("Health check stopped");
  }
}

function install(data, reason) {
  log("install() called");
}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  log("startup() called, reason=" + reason);
  isShuttingDown = false;

  try {
    await Zotero.initializationPromise;
    log("Zotero initialized");
  } catch (e) {
    log("Error waiting for Zotero: " + e);
    return;
  }

  // Check if disabled via preference
  try {
    var enabled = Zotero.Prefs.get("extensions.mcp-rdp.enabled", true);
    if (enabled === false) {
      log("Disabled by preference");
      return;
    }
  } catch (e) {}

  // Get port (default 6100)
  try {
    var prefPort = Zotero.Prefs.get("extensions.mcp-rdp.port");
    if (prefPort) rdpPort = prefPort;
  } catch (e) {}

  log("Starting RDP server on port " + rdpPort);

  try {
    // Initialize DevTools stack
    if (!initDevToolsStack()) {
      log("Failed to initialize DevTools stack");
      return;
    }

    // Open the listener
    var success = await openListener();
    if (success) {
      rdpStarted = true;
      startHealthCheck();
      log("SUCCESS - Server listening on port " + rdpPort);
    } else {
      log("Failed to open listener");
    }
  } catch (e) {
    log("ERROR: " + e);
    if (e.stack) log("Stack: " + e.stack);
    try {
      Zotero.logError(e);
    } catch (e2) {}
  }
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  log("shutdown() called, reason=" + reason);
  isShuttingDown = true;  // Prevent auto-reopen
  stopHealthCheck();

  if (reason === APP_SHUTDOWN) return;
  if (!rdpStarted) return;

  try {
    if (rdpListener) {
      rdpListener.close();
      rdpListener = null;
      log("Listener closed");
    }
  } catch (e) {
    log("Shutdown error: " + e);
  }
  rdpStarted = false;
  DevToolsServer = null;
  SocketListener = null;
}

function uninstall(data, reason) {
  log("uninstall() called");
}
