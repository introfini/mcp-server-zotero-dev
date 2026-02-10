# MCP Server for Zotero Plugin Development

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that enables AI assistants to build, test, and debug **Zotero 7+ plugins**. It provides 25 tools for UI inspection, JavaScript execution, build integration, logging, database access, and plugin management.

> **How it works**: Zotero 7+ is built on Firefox ESR, so this server communicates with Zotero through Firefox's built-in Remote Debugging Protocol (RDP). A small companion plugin ([MCP Bridge for Zotero](https://github.com/introfini/mcp-server-zotero-dev/releases)) starts the DevTools server inside Zotero, and this MCP server connects to it.

```
AI Assistant (Claude, Cursor, Windsurf, etc.)
         | MCP Protocol (stdio)
         v
    MCP Server (this package)
         | Firefox RDP (TCP port 6100)
         v
    Zotero + MCP Bridge Plugin
```

## Prerequisites

- **Node.js** >= 20
- **Zotero 7+** (release, beta, or dev build)
- **MCP Bridge for Zotero** plugin installed in Zotero — [download the latest XPI](https://github.com/introfini/mcp-server-zotero-dev/releases)

### Installing the MCP Bridge plugin

1. Download `zotero-mcp-bridge-*.xpi` from [GitHub Releases](https://github.com/introfini/mcp-server-zotero-dev/releases)
2. In Zotero: **Tools > Add-ons > gear icon > Install Add-on From File...**
3. Select the downloaded `.xpi` file
4. Restart Zotero

The plugin automatically starts a DevTools server on port 6100 when Zotero launches.

## Setup

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zotero-dev": {
      "command": "npx",
      "args": ["-y", "@introfini/mcp-server-zotero-dev"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add zotero-dev -- npx -y @introfini/mcp-server-zotero-dev
```

### Cursor / Windsurf / Other MCP clients

Configure the MCP server with:
- **Command**: `npx`
- **Arguments**: `-y @introfini/mcp-server-zotero-dev`

Or install globally:

```bash
npm install -g @introfini/mcp-server-zotero-dev
```

## Tools (25)

### JavaScript Execution & Inspection

| Tool | Description |
|------|-------------|
| `zotero_ping` | Test connection to Zotero and get version info |
| `zotero_execute_js` | Execute JavaScript in Zotero's privileged chrome context |
| `zotero_get_pref` | Get a Zotero preference value |
| `zotero_set_pref` | Set a Zotero preference value |
| `zotero_search_prefs` | Search and list Zotero/Firefox preferences |
| `zotero_inspect_object` | Inspect a JavaScript object to discover methods and properties |
| `zotero_open_preferences` | Open Zotero's preferences window, optionally navigating to a pane |

### UI Inspection

| Tool | Description |
|------|-------------|
| `zotero_screenshot` | Capture a screenshot of Zotero (main window, specific window, or element) |
| `zotero_inspect_element` | Find DOM elements by CSS selector |
| `zotero_get_dom_tree` | Get a simplified DOM tree structure |
| `zotero_get_styles` | Get computed CSS styles for an element |
| `zotero_list_windows` | List all open Zotero windows |

### Logging & Debugging

| Tool | Description |
|------|-------------|
| `zotero_read_logs` | Read Zotero's debug log output |
| `zotero_read_errors` | Read errors from Zotero's error console |
| `zotero_clear_logs` | Clear the debug log buffer and error console |
| `zotero_watch_logs` | Start/stop watching for new log messages |

### Build Integration

| Tool | Description |
|------|-------------|
| `zotero_scaffold_build` | Build a Zotero plugin using zotero-plugin-scaffold |
| `zotero_scaffold_serve` | Start/stop the dev server with hot reload |
| `zotero_scaffold_lint` | Run ESLint on a plugin project |
| `zotero_scaffold_typecheck` | Run TypeScript type checking |

### Plugin Management

| Tool | Description |
|------|-------------|
| `zotero_plugin_reload` | Reload a Zotero plugin |
| `zotero_plugin_list` | List all installed plugins |
| `zotero_plugin_install` | Install a plugin from a local XPI file |

### Database Access (Read-only)

| Tool | Description |
|------|-------------|
| `zotero_db_query` | Execute a SELECT query on Zotero's database |
| `zotero_db_schema` | Get database schema information |
| `zotero_db_stats` | Get database statistics |

## Prompts (5)

| Prompt | Description |
|--------|-------------|
| `setup-dev` | Set up Zotero plugin development environment from scratch |
| `debug-plugin` | Connect to Zotero and start debugging your plugin |
| `fix-errors` | Find and fix errors from Zotero's error console |
| `inspect-api` | Interactive exploration of Zotero's JavaScript APIs |
| `migrate-z7` | Help migrate a plugin from Zotero 6 to Zotero 7 |

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `ZOTERO_RDP_PORT` | `6100` | RDP port to connect to |
| `ZOTERO_RDP_HOST` | `localhost` | RDP host address |
| `ZOTERO_DATA_DIR` | auto-detected | Zotero data directory path |
| `ZOTERO_PROFILE_PATH` | auto-detected | Zotero profile path |

## Troubleshooting

**"Cannot connect to Zotero"**
1. Make sure Zotero is running
2. Verify the MCP Bridge plugin is installed (Tools > Add-ons)
3. Restart Zotero after installing the plugin
4. Check port 6100 is not blocked: `lsof -i :6100`

**"Port already in use"**
- Another Zotero instance may be running, or Zotero was started with the `-debugger` flag (which uses port 6000). The MCP Bridge uses port 6100 to avoid conflicts.

## License

MIT
