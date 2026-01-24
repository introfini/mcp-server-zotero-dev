/**
 * Plugin Management Tools
 *
 * Install, reload, and list Zotero plugins
 */

import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { getRdpClient } from "../index.js";
import { existsSync } from "node:fs";

// Tool definitions
export const pluginReloadTool: Tool = {
  name: "zotero_plugin_reload",
  description:
    "Reload a Zotero plugin. " +
    "If a plugin ID is provided, reloads that specific plugin. " +
    "Otherwise attempts to reload based on the current project.",
  inputSchema: {
    type: "object",
    properties: {
      pluginId: {
        type: "string",
        description:
          "Plugin ID to reload (e.g., 'my-plugin@example.com'). " +
          "Use zotero_plugin_list to find IDs.",
      },
    },
  },
};

export const pluginListTool: Tool = {
  name: "zotero_plugin_list",
  description:
    "List all installed Zotero plugins/add-ons with their IDs, names, versions, and status.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const pluginInstallTool: Tool = {
  name: "zotero_plugin_install",
  description:
    "Install a Zotero plugin from a local XPI file. " +
    "The plugin will be installed and Zotero may need to be restarted.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the XPI file to install",
      },
    },
    required: ["path"],
  },
};

// Tool handlers
export async function handlePluginReload(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const pluginId = args.pluginId as string | undefined;

  const client = await getRdpClient();

  // Return as JSON string to avoid RDP preview limitations with nested objects
  const code = `
    (async () => {
      try {
        const { AddonManager } = ChromeUtils.importESModule(
          "resource://gre/modules/AddonManager.sys.mjs"
        );

        const pluginId = ${JSON.stringify(pluginId || null)};

        if (pluginId) {
          const addon = await AddonManager.getAddonByID(pluginId);
          if (!addon) {
            return JSON.stringify({ error: \`Plugin not found: \${pluginId}\` });
          }

          await addon.reload();
          return JSON.stringify({
            success: true,
            plugin: {
              id: addon.id,
              name: addon.name,
              version: addon.version
            }
          });
        }

        // No specific plugin - try to find dev plugins
        const addons = await AddonManager.getAllAddons();
        const devAddons = addons.filter(a =>
          a.temporarilyInstalled ||
          a.installPath?.includes('build') ||
          a.installPath?.includes('dist')
        );

        if (devAddons.length === 0) {
          return JSON.stringify({ error: "No development plugins found. Specify a pluginId." });
        }

        if (devAddons.length === 1) {
          await devAddons[0].reload();
          return JSON.stringify({
            success: true,
            plugin: {
              id: devAddons[0].id,
              name: devAddons[0].name,
              version: devAddons[0].version
            }
          });
        }

        // Multiple dev plugins - list them
        return JSON.stringify({
          error: "Multiple development plugins found. Please specify one:",
          plugins: devAddons.map(a => ({ id: a.id, name: a.name }))
        });
      } catch (error) {
        return JSON.stringify({ error: error.message || String(error) });
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Plugin reload failed: ${response.exceptionMessage}`);
  }

  // Use async method to handle longString grips
  const jsonString = await client.gripToValueAsync(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Plugin reload failed: received undefined result from Zotero");
  }

  const result = JSON.parse(String(jsonString)) as {
    success?: boolean;
    plugin?: { id: string; name: string; version: string };
    error?: string;
    plugins?: Array<{ id: string; name: string }>;
  };

  if (result.error) {
    if (result.plugins) {
      const list = result.plugins.map((p) => `  - ${p.id} (${p.name})`).join("\n");
      throw new Error(`${result.error}\n${list}`);
    }
    throw new Error(result.error);
  }

  return [
    {
      type: "text",
      text:
        `✓ Plugin reloaded successfully\n\n` +
        `Name: ${result.plugin?.name}\n` +
        `ID: ${result.plugin?.id}\n` +
        `Version: ${result.plugin?.version}`,
    },
  ];
}

export async function handlePluginList(): Promise<TextContent[]> {
  const client = await getRdpClient();

  // Return as JSON string to avoid RDP preview limitations with nested objects
  const code = `
    (async () => {
      try {
        const { AddonManager } = ChromeUtils.importESModule(
          "resource://gre/modules/AddonManager.sys.mjs"
        );

        const addons = await AddonManager.getAllAddons();

        const result = addons.map(addon => ({
          id: addon.id,
          name: addon.name,
          version: addon.version,
          type: addon.type,
          enabled: addon.isActive,
          temporarilyInstalled: addon.temporarilyInstalled,
          installPath: addon.installPath || null,
          description: addon.description?.slice(0, 100) || null
        }));
        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ error: error.message || String(error) });
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to list plugins: ${response.exceptionMessage}`);
  }

  // Use async method to handle longString grips
  const jsonString = await client.gripToValueAsync(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Failed to list plugins: received undefined result from Zotero");
  }

  const result = JSON.parse(String(jsonString));

  if (typeof result === "object" && result !== null && "error" in result) {
    throw new Error((result as { error: string }).error);
  }

  const plugins = result as Array<{
    id: string;
    name: string;
    version: string;
    type: string;
    enabled: boolean;
    temporarilyInstalled: boolean;
    installPath?: string;
    description?: string;
  }>;

  if (!plugins || plugins.length === 0) {
    return [{ type: "text", text: "No plugins installed" }];
  }

  const lines: string[] = [`Found ${plugins.length} plugin(s):\n`];

  for (const plugin of plugins) {
    const status = [];
    if (!plugin.enabled) status.push("disabled");
    if (plugin.temporarilyInstalled) status.push("dev");

    const statusStr = status.length ? ` [${status.join(", ")}]` : "";

    lines.push(`• ${plugin.name} v${plugin.version}${statusStr}`);
    lines.push(`  ID: ${plugin.id}`);
    if (plugin.description) {
      lines.push(`  ${plugin.description}`);
    }
    if (plugin.installPath) {
      lines.push(`  Path: ${plugin.installPath}`);
    }
    lines.push("");
  }

  return [{ type: "text", text: lines.join("\n") }];
}

export async function handlePluginInstall(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const xpiPath = args.path as string;

  if (!xpiPath) {
    throw new Error("Missing required parameter: path");
  }

  if (!existsSync(xpiPath)) {
    throw new Error(`XPI file not found: ${xpiPath}`);
  }

  if (!xpiPath.endsWith(".xpi")) {
    throw new Error("File must have .xpi extension");
  }

  const client = await getRdpClient();

  // We need to pass the file path to Zotero
  // Zotero can install from file:// URLs
  const fileUrl = `file://${xpiPath.replace(/\\/g, "/")}`;

  // Return as JSON string to avoid RDP preview limitations with nested objects
  const code = `
    (async () => {
      try {
        const { AddonManager } = ChromeUtils.importESModule(
          "resource://gre/modules/AddonManager.sys.mjs"
        );

        const xpiUrl = ${JSON.stringify(fileUrl)};

        // Create install
        const install = await AddonManager.getInstallForURL(xpiUrl, {
          telemetryInfo: { source: "mcp-server" }
        });

        if (!install) {
          return JSON.stringify({ error: "Failed to create install object" });
        }

        // Install the addon
        await install.install();

        const addon = install.addon;
        if (!addon) {
          return JSON.stringify({ error: "Installation completed but addon not found" });
        }

        return JSON.stringify({
          success: true,
          plugin: {
            id: addon.id,
            name: addon.name,
            version: addon.version,
            requiresRestart: addon.pendingOperations > 0
          }
        });
      } catch (error) {
        return JSON.stringify({ error: error.message || String(error) });
      }
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Plugin installation failed: ${response.exceptionMessage}`);
  }

  // Use async method to handle longString grips
  const jsonString = await client.gripToValueAsync(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Plugin installation failed: received undefined result from Zotero");
  }

  const result = JSON.parse(String(jsonString)) as {
    success?: boolean;
    plugin?: {
      id: string;
      name: string;
      version: string;
      requiresRestart: boolean;
    };
    error?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  const restartNote = result.plugin?.requiresRestart
    ? "\n\n⚠️ Zotero may need to be restarted for the plugin to take effect."
    : "";

  return [
    {
      type: "text",
      text:
        `✓ Plugin installed successfully\n\n` +
        `Name: ${result.plugin?.name}\n` +
        `ID: ${result.plugin?.id}\n` +
        `Version: ${result.plugin?.version}` +
        restartNote,
    },
  ];
}
