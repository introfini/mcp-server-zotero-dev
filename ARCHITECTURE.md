# Architecture & Technical Learnings

> Hard-won knowledge from implementing the MCP Bridge for Zotero for Zotero 8

This document captures the technical discoveries, gotchas, and architectural decisions made while implementing remote debugging support for Zotero plugin development.

---

## Table of Contents

1. [Overview](#overview)
2. [Firefox DevTools RDP Protocol](#firefox-devtools-rdp-protocol)
3. [Zotero 8 Plugin Development](#zotero-8-plugin-development)
4. [DevToolsServer Loading](#devtoolsserver-loading)
5. [RDP Actor Hierarchy](#rdp-actor-hierarchy)
6. [Port Configuration](#port-configuration)
7. [Common Pitfalls](#common-pitfalls)
8. [Testing & Debugging](#testing--debugging)

---

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI Assistant                              │
│                   (Claude/Cursor/Windsurf)                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ MCP Protocol (stdio)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Server (Node.js)                         │
│                    packages/mcp-server/                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  RDP Client                                              │    │
│  │  - TCP socket connection                                 │    │
│  │  - Packet framing: <length>:<json>                       │    │
│  │  - Actor-based messaging                                 │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Firefox RDP (TCP port 6100)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Zotero Application                            │
│                   (Firefox ESR 128+)                             │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  MCP Bridge for Zotero Plugin                                   │    │
│  │  packages/zotero-plugin-mcp-rdp/                         │    │
│  │  - Loads DevToolsServer via DevToolsLoader               │    │
│  │  - Opens SocketListener on port 6100                     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Firefox DevTools RDP Protocol

### Packet Format

All RDP messages use a simple length-prefixed format:

```
<length>:<json-message>

Example: 36:{"to":"root","type":"getRoot"}
```

**Key insight:** The length is the byte length of the JSON string, NOT including the length prefix or colon.

### Parsing Chunked Responses

RDP responses can be large (1-2KB+) and arrive in multiple TCP chunks. The parser must:

1. Buffer incoming data
2. Extract the length prefix
3. Wait until the full message is received
4. Parse JSON only when complete

```javascript
function tryParse(buffer) {
  const colonIdx = buffer.indexOf(':');
  if (colonIdx === -1) return null;

  const len = parseInt(buffer.substring(0, colonIdx), 10);
  const messageEnd = colonIdx + 1 + len;

  if (buffer.length < messageEnd) {
    return null; // Wait for more data
  }

  const json = buffer.substring(colonIdx + 1, messageEnd);
  return {
    message: JSON.parse(json),
    remaining: buffer.substring(messageEnd)
  };
}
```

### Message Structure

**Request:**
```json
{
  "to": "actor-id",
  "type": "method-name",
  ...additional params
}
```

**Response:**
```json
{
  "from": "actor-id",
  ...response data
}
```

---

## Zotero 8 Plugin Development

### Bootstrap.js Constraints

Zotero 8 plugins use the bootstrap pattern. Critical constraints:

| Feature | Available | Notes |
|---------|-----------|-------|
| `console.log()` | No | Use `dump()` or `Zotero.debug()` |
| `ChromeUtils.import()` | Removed | Use `ChromeUtils.importESModule()` |
| `Zotero.debug()` | Yes | Goes to debug log, not Error Console |
| `dump()` | Yes | Goes to terminal (if started from CLI) |
| `Zotero.logError()` | Yes | For error reporting |

### Logging Pattern

```javascript
function log(msg) {
  var fullMsg = "[MyPlugin] " + msg;
  dump(fullMsg + "\n");  // Terminal output
  try {
    if (typeof Zotero !== "undefined" && Zotero.debug) {
      Zotero.debug(fullMsg);  // Zotero debug log
    }
  } catch (e) {}
}
```

### Manifest.json Version Compatibility

For Zotero 7 and 8 beta compatibility:

```json
{
  "applications": {
    "zotero": {
      "id": "your-addon@example.com",
      "strict_min_version": "6.999",
      "strict_max_version": "8.*"
    }
  }
}
```

**Important:** Don't use `__MSG_name__` localization in manifest - use hardcoded strings for maximum compatibility.

---

## DevToolsServer Loading

### The Wrong Way (Direct ESM Import)

```javascript
// This FAILS - module path doesn't work as expected
const { DevToolsServer } = ChromeUtils.importESModule(
  "resource://devtools/server/devtools-server.mjs"
);
```

### The Correct Way (DevToolsLoader)

This is exactly how Zotero's `-debugger` flag works (see `zotero-main/app/assets/commandLineHandler.js`):

```javascript
// 1. Import the DevToolsLoader
const { DevToolsLoader } = ChromeUtils.importESModule(
  "resource://devtools/shared/loader/Loader.sys.mjs"
);

// 2. Create a loader with fresh compartment
const loader = new DevToolsLoader({ freshCompartment: true });

// 3. Load DevToolsServer and SocketListener via the loader
const { DevToolsServer } = loader.require("devtools/server/devtools-server");
const { SocketListener } = loader.require("devtools/shared/security/socket");

// 4. Initialize and configure
if (!DevToolsServer.initialized) {
  DevToolsServer.init();
}
DevToolsServer.registerAllActors();
DevToolsServer.allowChromeProcess = true;

// 5. Open socket listener
const listener = new SocketListener(DevToolsServer, { portOrPath: 6100 });
await listener.open();
```

### Why DevToolsLoader?

Firefox DevTools uses a custom module loader system. The standard `importESModule` doesn't properly resolve the DevTools module graph. The `DevToolsLoader`:

- Has knowledge of DevTools-specific module paths
- Sets up the correct compartment for DevTools code
- Handles the internal module dependencies

---

## RDP Actor Hierarchy

### Actor Flow for JavaScript Evaluation

```
root
  │
  ├── listProcesses
  │       │
  │       ▼
  │   ProcessDescriptor (e.g., "server1.conn0.processDescriptor1")
  │       │
  │       ├── getTarget
  │       │       │
  │       │       ▼
  │       │   Target with consoleActor (e.g., "server1.conn0.consoleActor4")
  │       │       │
  │       │       ├── evaluateJSAsync
  │       │       │       │
  │       │       │       ▼
  │       │       │   { result: "7.0.0-beta.XX" }
```

### Step-by-Step Connection

```javascript
// 1. Connect to RDP
const socket = net.connect(6100, '127.0.0.1');

// 2. List processes to find parent
send({ to: 'root', type: 'listProcesses' });
// Response: { processes: [{ actor: "...processDescriptor1", isParent: true }] }

// 3. Get target from parent process
send({ to: 'server1.conn0.processDescriptor1', type: 'getTarget' });
// Response: { process: { consoleActor: "...consoleActor4", title: "Zotero", ... } }

// 4. Evaluate JavaScript
send({
  to: 'server1.conn0.consoleActor4',
  type: 'evaluateJSAsync',
  text: 'Zotero.version'
});
// Response: { result: "7.0.0-beta.83+..." }
```

### Available Root Actor Methods

From `requestTypes`:
- `connect`
- `getRoot`
- `listTabs` (returns empty in Zotero - no traditional tabs)
- `getTab`
- `listAddons`
- `listWorkers`
- `listServiceWorkerRegistrations`
- `listProcesses` - **Use this for Zotero**
- `getProcess`
- `watchResources`
- `unwatchResources`
- `clearResources`
- `requestTypes`

### Key Actors in Response

When you call `getTarget` on the process descriptor, you get:

| Actor | Purpose |
|-------|---------|
| `consoleActor` | JavaScript evaluation, console messages |
| `inspectorActor` | DOM inspection |
| `styleSheetsActor` | CSS stylesheets |
| `screenshotContentActor` | Screenshots |
| `threadActor` | Debugger/breakpoints |

---

## Port Configuration

### Default Ports

| Port | Source | Notes |
|------|--------|-------|
| 6000 | Zotero's `-debugger` flag | Built-in, all builds |
| 6100 | MCP Bridge for Zotero plugin | Our plugin's default |

### DevTools Availability

DevTools are available in all Zotero 7+ builds (release, beta, and dev). The MCP Bridge plugin enables the DevTools server on port 6100 automatically.

You can verify by checking `devtools.debugger.remote-port` in `about:config`:
- `6100` → MCP Bridge plugin is active
- `6000` → Zotero's built-in `-debugger` flag

### Preference Configuration

The plugin sets these preferences automatically:

```javascript
Services.prefs.setBoolPref("devtools.debugger.remote-enabled", true);
Services.prefs.setBoolPref("devtools.chrome.enabled", true);
Services.prefs.setBoolPref("devtools.debugger.prompt-connection", false);
```

---

## Common Pitfalls

### 1. "console is not defined"

**Problem:** Using `console.log()` in bootstrap.js

**Solution:** Use `dump()` for terminal output, `Zotero.debug()` for debug log

### 2. "ChromeUtils.import has been removed"

**Problem:** Zotero 8 (Firefox ESR 128+) removed the old import method

**Solution:** Use `ChromeUtils.importESModule()` for `.sys.mjs` files

### 3. "Failed to load resource://devtools/server/devtools-server.mjs"

**Problem:** Direct ESM import doesn't work for DevTools modules

**Solution:** Use `DevToolsLoader` approach (see [DevToolsServer Loading](#devtoolsserver-loading))

### 4. Port closes after connection

**Problem:** RDP server seems to shut down

**Causes:**
- Another Zotero instance already running
- MCP Bridge plugin not installed
- Connection error causing server shutdown

**Debug:** Check `lsof -i :6000 -i :6100` and `ps aux | grep zotero`

### 5. Incomplete RDP responses

**Problem:** Large responses (getTarget is ~1.5KB) arrive in chunks

**Solution:** Buffer data until complete message received based on length prefix

### 6. "listTabs returns empty"

**Problem:** Zotero isn't a traditional browser with tabs

**Solution:** Use `listProcesses` → `getTarget` flow instead

---

## Testing & Debugging

### Manual RDP Test

```bash
# 1. Start Zotero with debugger
/Applications/Zotero.app/Contents/MacOS/zotero -debugger &

# 2. Check ports
lsof -i :6000 -i :6100

# 3. Test RDP connection
node -e "
const net = require('net');
const client = net.connect(6100, '127.0.0.1', () => {
  const msg = JSON.stringify({ to: 'root', type: 'listProcesses' });
  client.write(msg.length + ':' + msg);
});
client.on('data', d => console.log(d.toString()));
"
```

### View Zotero Debug Output

1. Start Zotero from terminal to see `dump()` output
2. Enable debug output: `zotero -ZoteroDebugText`
3. View Error Console: Help → Report Error → click console link

### MCP Inspector

```bash
cd packages/mcp-server
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## References

- [Firefox RDP Protocol](https://firefox-source-docs.mozilla.org/devtools/backend/protocol.html)
- [Actor Hierarchy](https://firefox-source-docs.mozilla.org/devtools/backend/actor-hierarchy.html)
- [Web Console Remoting](https://firefox-source-docs.mozilla.org/devtools-user/web_console/remoting/index.html)
- [Zotero Plugin Development](https://www.zotero.org/support/dev/client_coding/plugin_development)
- [Zotero 7 for Developers](https://www.zotero.org/support/dev/zotero_7_for_developers)
- [geckordp - Python RDP Client](https://github.com/jpramosi/geckordp)
- [Zotero Forum: -debugger flag](https://forums.zotero.org/discussion/102084/note-the-debugger-flag-availability-in-wiki)

---

## Changelog

- **2025-01-23**: Initial documentation based on implementation learnings
