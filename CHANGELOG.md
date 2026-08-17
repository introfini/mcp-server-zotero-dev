# Changelog

All notable changes to MCP Server Zotero Dev will be documented in this file.

## [1.1.3] - 2026-08-17

### Fixed
- **`zotero_db_query` failed on every query returning rows** ([#20](https://github.com/introfini/mcp-server-zotero-dev/issues/20), [#21](https://github.com/introfini/mcp-server-zotero-dev/pull/21), thanks to @hainingpan), with `result.columns.join is not a function` — broken since 1.0.0 on every Zotero version. Two independent defects, either one fatal:
  - Column names were derived with `Object.keys(rows[0])`, but `Zotero.DB.queryAsync` wraps rows in a Proxy with only `get`/`has` traps (no `ownKeys`), so key enumeration returned the underlying `mozIStorageRow`'s XPCOM members instead of column names. Rows are now read via `queryAsync`'s `onRow` callback (raw `mozIStorageRow`, positional `getResultByIndex()`), with column names parsed from the SELECT list host-side and a `col1..colN` fallback when the list isn't statically parseable (e.g. `SELECT *`).
  - The eval returned a raw nested object, which RDP grip resolution flattens to placeholder strings (`columns` arrived as `"[Array]"`). Payloads are now `JSON.stringify`d inside the eval and parsed host-side, matching the convention already used by the other tool files.
- **`zotero_db_schema`** shared the raw-object serialization defect and got the same JSON-encoding fix on both branches (single-table and table listing).

## [Plugin 1.0.5] - 2026-07-31

### Fixed
- **`extensions.mcp-rdp.port` is now actually read** ([#17](https://github.com/introfini/mcp-server-zotero-dev/pull/17), thanks to @mjthoraval). The 1.0.4 fix changed `src/bootstrap.ts` and `src/index.ts`, but `scripts/build.mjs` ships `src/bootstrap.js`, so the released XPI never got it: the preference was read without the global flag, resolved under `extensions.zotero.`, and the documented name did nothing. Both names are read now, documented first, falling back to the legacy `extensions.zotero.`-prefixed one so profiles with a custom port keep it.
- **Invalid port values no longer break the bridge.** Zotero's Config Editor pre-selects **Boolean**, so a preference created without switching to **Number** stored `true`. `SocketListener` treats a non-numeric `portOrPath` as a pipe path and opens successfully, leaving the bridge logging success while serving nothing over TCP and reopening every 10s. The value is now parsed and range-checked: anything invalid keeps port 6100 and is logged.

### Removed
- **Dead `src/bootstrap.ts` and `src/index.ts`.** Nothing ever compiled them — the plugin has no `tsconfig`, the root `typecheck`/`lint` run with `--if-present`, and there is no CI — and they called three DevTools APIs that do not exist (`devtools-server.mjs`, `DevToolsServer.openListener`, `DevToolsServer.closeAllListeners`). Keeping a second, unbuildable copy of the bootstrap is what shipped the broken 1.0.4 fix. `main` now points at `src/bootstrap.js`, the file the build actually ships.

### Docs
- README: new **Changing the RDP Port** section covering the Zotero-side preference, the matching `ZOTERO_RDP_PORT` on the client, the fact that both sides must agree, and the Config Editor type trap. Also documents `extensions.mcp-rdp.enabled`, which had never been mentioned anywhere.

## [1.1.1] - 2026-06-22

### Fixed
- `serverInfo.version` in the MCP handshake now reads from `package.json` instead of a hard-coded `0.1.0`, so clients report the real running version.

### Docs
- README: pin an exact version in the `npx` config, and document the `npx` cache behavior, the `@latest` vs pin tradeoff, and the `-y` flag (without it `npx` hangs). Flag that `install-mcp` may write a config without `-y` or a version.

## [1.1.0] - 2026-06-22

### Added
- **UI interaction tools** (`src/tools/interact.ts`) — the server could *inspect* the Zotero UI (`zotero_screenshot` / `zotero_inspect_element` / `zotero_get_dom_tree`) but not *act* on it. Two tools close that gap:
  - `zotero_click_element` — click an element by CSS selector (`el.click()`, or a synthesized `mousedown`/`mouseup`/`click` sequence via `mouseEvents`). Supports `windowId` and an `index` for selectors that match several elements.
  - `zotero_send_keys` — type text into an input/textarea/contenteditable, firing `input`/`change` so listeners react; optional `clear` and `pressEnter`.
- Both reuse the existing RDP `evaluateJS` channel (no new actor) and **pierce open shadow roots** — Zotero's XUL custom elements (e.g. `search-textbox`) keep their internals in shadow DOM, which a document-level `querySelector` can't reach.

### Known limitation
- These tools cannot dismiss a **blocking** native modal dialog (`Services.prompt.confirmEx`): its nested modal event loop blocks the main thread that `evaluateJS` runs on. Non-modal windows and in-window elements work normally.

## [Plugin 1.0.1] - 2026-04-11

### Fixed
- **Zotero 9 compatibility** — bumped `strict_max_version` from `8.*` to `9.*` in the plugin manifest so the MCP Bridge XPI loads on Zotero 9.0. Without this fix, Zotero 9 refuses to activate the plugin, leaving the RDP port (6100) closed and disconnecting MCP clients (Claude Code, Cursor, Windsurf) from Zotero.

### Technical
- `packages/zotero-plugin-mcp-rdp/package.json` version bumped to 1.0.1 (build script auto-syncs this into the XPI manifest).
- `update.json` regenerated with the v1.0.1 download URL and an explicit `strict_max_version: "9.*"` in the applications block.
- The MCP server half (`@introfini/mcp-server-zotero-dev`) is unchanged — this release only ships a new Zotero plugin XPI.

## [1.0.0] - 2025-01-24

### Initial Release 🎉

An MCP (Model Context Protocol) server that enables AI assistants like Claude, Cursor, and Windsurf to build, test, and debug Zotero 7/8 plugins.

#### UI Inspection (5 tools)
- 📸 **zotero_screenshot** - Capture window, element, or region screenshots
  - Supports main window, preferences, PDF reader, dialogs
  - `highlightSelector` option adds red border to elements before capture
- 🔍 **zotero_inspect_element** - Find elements by CSS selector
- 🌳 **zotero_get_dom_tree** - Get DOM structure of any window/panel
- 🎨 **zotero_get_styles** - Get computed CSS styles for elements
- 🪟 **zotero_list_windows** - List all open Zotero windows

#### JavaScript Execution (6 tools)
- 💻 **zotero_execute_js** - Execute JavaScript in Zotero's privileged context
  - Auto-wraps code with top-level `return` statements in IIFE
- 🔎 **zotero_inspect_object** - Explore Zotero APIs interactively
  - List methods and properties of any object (e.g., `Zotero.Items`)
  - Supports depth control and filtering (own/inherited/all)
- ⚙️ **zotero_open_preferences** - Open Zotero's settings window
  - Navigate directly to built-in panes: 'general', 'sync', 'export', 'cite', 'advanced'
  - Navigate to plugin panes by plugin ID (e.g., 'zotseek@zotero.org')
- 🔧 **zotero_search_prefs** - Search/discover preferences by pattern
- 📖 **zotero_get_pref** - Get a preference value
- ✏️ **zotero_set_pref** - Set a preference value

#### Build & Scaffold (4 tools)
- 🏗️ **zotero_scaffold_build** - Build plugin (dev or production mode)
- 🔄 **zotero_scaffold_serve** - Start dev server with hot reload
- 📝 **zotero_scaffold_lint** - Run ESLint on plugin source
- ✅ **zotero_scaffold_typecheck** - Run TypeScript type checking

#### Logs & Debugging (4 tools)
- 📋 **zotero_read_logs** - Read debug output (Zotero.debug)
- ❌ **zotero_read_errors** - Read error console entries
- 👁️ **zotero_watch_logs** - Stream logs in real-time
- 🧹 **zotero_clear_logs** - Clear log buffer

#### Plugin Management (3 tools)
- 🔁 **zotero_plugin_reload** - Hot reload your dev plugin
- 📦 **zotero_plugin_install** - Install plugin from XPI path
- 📃 **zotero_plugin_list** - List installed plugins with version/status

#### Database Access (3 tools)
- 🗃️ **zotero_db_query** - Execute SELECT query on zotero.sqlite (read-only)
- 📊 **zotero_db_schema** - Get table schema information
- 📈 **zotero_db_stats** - Get database statistics

#### Connection (1 tool)
- 🔌 **zotero_ping** - Test connection to Zotero

#### Prompts (5 total)
- `/zotero-dev:setup-dev` - Initialize plugin development environment
- `/zotero-dev:debug-plugin` - Debug a plugin issue
- `/zotero-dev:inspect-api` - Explore Zotero's JavaScript APIs
- `/zotero-dev:build-feature` - Build a new plugin feature
- `/zotero-dev:fix-ui` - Fix UI/styling issues

### MCP Bridge for Zotero Plugin

Lightweight Zotero plugin that enables the Remote Debugging Protocol:
- Automatically starts DevToolsServer on port 6100 when Zotero launches
- Works on all Zotero 7+ builds (release, beta, dev)
- Zero configuration required after installation

### Technical
- Built with TypeScript and `@modelcontextprotocol/sdk`
- Uses Firefox Remote Debugging Protocol (RDP) for communication
- Monorepo structure with npm workspaces
- Read-only database access via direct SQLite connection
- Integrates with [zotero-plugin-scaffold](https://github.com/windingwind/zotero-plugin-scaffold) for build tooling
