/**
 * zotero_plugin_install's work, kept free of any import from index.ts so
 * tests can load it without starting the MCP server (see ping.ts).
 *
 * The result names the profile the plugin went into, and an optional
 * `profile` guard refuses to install into any other. With several Zotero
 * instances or profiles on one machine, the bridge port answers for
 * whichever one is running, and an install meant for a development profile
 * can land in the user's real library profile without a word about it.
 */
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { EvaluateJSResponse, GripValue } from "../rdp/index.js";

/** The subset of RDPClient the install needs - injectable for tests. */
export interface InstallClient {
  evaluateJS(code: string): Promise<EvaluateJSResponse>;
  gripToValueAsync(grip: GripValue): Promise<unknown>;
}

export interface InstallResult {
  success?: boolean;
  /** The running Zotero's profile directory. */
  profileDir?: string;
  /** Set when the profile guard refused the install. */
  refused?: boolean;
  plugin?: { id: string; name: string; version: string; requiresRestart: boolean };
  error?: string;
}

/**
 * The code evaluated in Zotero. The guard is checked BEFORE anything is
 * created, case-insensitively (Windows paths), against the profile
 * directory's full path. Always a JSON string.
 */
export function installCode(fileUrl: string, profileGuard?: string): string {
  return `
    (async () => {
      let profileDir = null;
      try {
        profileDir = (typeof PathUtils !== "undefined" && PathUtils.profileDir)
          || Services.dirsvc.get("ProfD", Ci.nsIFile).path;
      } catch (e) {}
      try {
        const guard = ${JSON.stringify(profileGuard ?? null)};
        if (guard && !(profileDir || "").toLowerCase().includes(guard.toLowerCase())) {
          return JSON.stringify({ refused: true, profileDir });
        }
        const { AddonManager } = ChromeUtils.importESModule(
          "resource://gre/modules/AddonManager.sys.mjs"
        );

        const xpiUrl = ${JSON.stringify(fileUrl)};

        // Create install
        const install = await AddonManager.getInstallForURL(xpiUrl, {
          telemetryInfo: { source: "mcp-server" }
        });

        if (!install) {
          return JSON.stringify({ error: "Failed to create install object", profileDir });
        }

        // Install the addon
        await install.install();

        const addon = install.addon;
        if (!addon) {
          return JSON.stringify({ error: "Installation completed but addon not found", profileDir });
        }

        return JSON.stringify({
          success: true,
          profileDir,
          plugin: {
            id: addon.id,
            name: addon.name,
            version: addon.version,
            requiresRestart: addon.pendingOperations > 0
          }
        });
      } catch (error) {
        return JSON.stringify({ error: error.message || String(error), profileDir });
      }
    })()
  `;
}

/** The text for a parsed result; throws for an error or a refusal. */
export function installResultText(result: InstallResult, profileGuard?: string): TextContent[] {
  if (result.refused) {
    throw new Error(
      `Refused: the running Zotero's profile is "${result.profileDir ?? "unknown"}", ` +
        `which does not contain "${profileGuard ?? ""}". Nothing was installed. ` +
        "Start the intended profile, or point the server at its bridge port."
    );
  }
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
        `Version: ${result.plugin?.version}\n` +
        `Profile: ${result.profileDir ?? "unknown"}` +
        restartNote,
    },
  ];
}

/** Install `fileUrl` through an already-connected client. */
export async function installWithClient(
  client: InstallClient,
  fileUrl: string,
  profileGuard?: string
): Promise<TextContent[]> {
  const response = await client.evaluateJS(installCode(fileUrl, profileGuard));

  if (response.exception) {
    throw new Error(`Plugin installation failed: ${response.exceptionMessage}`);
  }

  // Use async method to handle longString grips
  const jsonString = await client.gripToValueAsync(response.result as GripValue);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Plugin installation failed: received undefined result from Zotero");
  }

  return installResultText(JSON.parse(String(jsonString)) as InstallResult, profileGuard);
}
