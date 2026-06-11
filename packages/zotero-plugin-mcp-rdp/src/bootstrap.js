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
    // CRITICAL: without keepAlive, the DevToolsServer destroys itself - and
    // its listeners - whenever the LAST client connection closes. With a
    // non-destructive health check this surfaces as the listener dying
    // moments after every probe disconnect (when no MCP client holds a
    // long-lived connection); the original 2s reopen loop was accidentally
    // masking it by perpetually recreating the listener. Verified by
    // holding an external connection open: the kill cycle stopped for
    // exactly as long as the connection was held.
    DevToolsServer.keepAlive = true;

    log("DevTools stack initialized (keepAlive=true)");
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
    var transport = null;
    var finish = function (alive) {
      if (done) return;
      done = true;
      try { if (transport) transport.close(Components.results.NS_OK); } catch (e) {}
      resolve(alive);
    };
    try {
      var sts = Components.classes["@mozilla.org/network/socket-transport-service;1"]
        .getService(Components.interfaces.nsISocketTransportService);
      transport = sts.createTransport([], "127.0.0.1", rdpPort, null, null);
      var timer = setTimeout(function () { finish(false); }, 1500);
      // IMPORTANT: wait for the server's RDP intro packet and only close
      // AFTER reading it. Closing at TCP-connect time aborts the connection
      // mid-handshake - the DevTools server's intro write then hits a dying
      // socket and the LISTENER itself can self-close, i.e. the probe kills
      // the very listener it is checking (observed as a 10-20s flap cycle).
      transport.openOutputStream(0, 0, 0);   // kicks off the connect
      var input = transport.openInputStream(0, 0, 0);
      input.asyncWait({
        onInputStreamReady: function (s) {
          clearTimeout(timer);
          var alive = false;
          try {
            var n = s.available();           // throws if closed/refused
            if (n > 0) {
              alive = true;
              // Drain the intro bytes so the server's write completes.
              var sis = Components.classes["@mozilla.org/scriptableinputstream;1"]
                .createInstance(Components.interfaces.nsIScriptableInputStream);
              sis.init(s);
              sis.read(n);
            }
          } catch (e) { alive = false; }
          finish(alive);
        }
      }, 0, 0, Services.tm.currentThread);
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
      log("SUCCESS - Server listening on port " + rdpPort);
    } else {
      log("Failed to open listener");
    }
    // Start the health check UNCONDITIONALLY. The non-destructive check
    // reopens the listener whenever the port stops answering, so a failed
    // open at startup (e.g. the port was briefly busy by another process or
    // a not-yet-released previous instance) self-heals on a later tick
    // instead of leaving the bridge permanently dead until a manual plugin
    // reload or Zotero restart. Previously this ran only inside the success
    // branch, so a failed boot-open could never recover.
    rdpStarted = true;
    startHealthCheck();
  } catch (e) {
    log("ERROR: " + e);
    if (e.stack) log("Stack: " + e.stack);
    try {
      Zotero.logError(e);
    } catch (e2) {}
    // Even after an unexpected startup error, keep trying to come up.
    try { rdpStarted = true; startHealthCheck(); } catch (e3) {}
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
