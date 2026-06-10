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

// Periodic NON-DESTRUCTIVE health check.
//
// The previous implementation called openListener() every 2 seconds, and
// openListener() unconditionally CLOSES the live listener before reopening -
// the "fails harmlessly (port in use)" assumption never held because the
// close frees the port first. Measured effect: the port refused most
// incoming connections (35/40 in a 10s probe run) and established
// connections died within a single cycle, so any RDP request in flight lost
// its reply (MCP clients saw "undefined" results / transient disconnects).
//
// Instead, probe the port as a CLIENT: if a TCP connect to 127.0.0.1:port
// succeeds, the listener is healthy and is left strictly alone; only when
// the connect fails (refused / timed out) is the listener actually reopened.
// (A bind-probe would be unreliable: Mozilla server sockets set SO_REUSEADDR,
// and on Windows that lets a second bind steal a live port.)
var healthCheckInterval = null;

function probeConnect() {
  return new Promise(function (resolve) {
    var done = false;
    var finish = function (alive) {
      if (done) return;
      done = true;
      resolve(alive);
    };
    try {
      var sts = Components.classes["@mozilla.org/network/socket-transport-service;1"]
        .getService(Components.interfaces.nsISocketTransportService);
      var transport = sts.createTransport([], "127.0.0.1", rdpPort, null, null);
      var timer = setTimeout(function () {
        try { transport.close(Components.results.NS_ERROR_ABORT); } catch (e) {}
        finish(false);
      }, 1500);
      transport.setEventSink({
        onTransportStatus: function (t, status) {
          if (status === Components.interfaces.nsISocketTransport.STATUS_CONNECTED_TO) {
            clearTimeout(timer);
            try { transport.close(Components.results.NS_OK); } catch (e) {}
            finish(true);
          }
        }
      }, Services.tm.currentThread);
      // Opening a stream kicks off the actual connection attempt.
      transport.openOutputStream(0, 0, 0);
    } catch (e) {
      finish(false);
    }
  });
}

async function checkListener() {
  if (isShuttingDown) return;
  if (rdpListener) {
    var alive = await probeConnect();
    if (alive || isShuttingDown) return;   // healthy - do NOT touch the listener
    log("Health check: port " + rdpPort + " not answering - reopening listener");
  }
  var ok = await openListener();
  if (ok) log("Listener (re)opened by health check");
}

function startHealthCheck() {
  if (healthCheckInterval) return;

  healthCheckInterval = setInterval(function() {
    if (isShuttingDown) {
      stopHealthCheck();
      return;
    }
    checkListener().catch(function () {});
  }, 10000);  // Probe every 10 seconds (read-only when healthy)

  log("Health check started (non-destructive connect-probe, 10s)");
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

  // Ensure DevTools preferences are set (required for RDP to work)
  try {
    var start = "devtools.debugger.";
    Services.prefs.setBoolPref(start + "remote-enabled", true);
    Services.prefs.setBoolPref(start + "prompt-connection", false);
    Services.prefs.setBoolPref("devtools.chrome.enabled", true);
    log("DevTools preferences configured");
  } catch (e) {
    log("Warning: Could not set DevTools preferences: " + e);
  }

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

// No-op window hooks. Zotero 7+ calls these on every plugin and logs a
// "Plugin ... is missing bootstrap method" warning per window when absent.
// The RDP server is window-independent, so there is nothing to do here.
function onMainWindowLoad() {}
function onMainWindowUnload() {}
