/**
 * zotero_instance_setup / zotero_instance_list (#29): a second Zotero
 * instance in one step, and an inventory of what already exists.
 *
 * Neither tool talks to Zotero: setup writes a new profile directory that no
 * Zotero has opened yet, list reads files. Like the scaffold and db tools they
 * need no RDP connection, and this module does not import index.ts (#33); the
 * server passes in what it knows (its port, its profile, its version).
 *
 * Setup does not start Zotero: it returns the launch command and the MCP
 * server entry, so a window appears only when the user (or the agent, on the
 * user's say-so) runs that command, and running the tool twice changes
 * nothing.
 */
import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_RDP_PORT,
  defaultParentDir,
  portAnswers,
  setupInstance,
  takeInventory,
  type HostEnv,
  type SetupResult,
} from "../utils/instance.js";

export const instanceSetupTool: Tool = {
  name: "zotero_instance_setup",
  description:
    "Create a separate Zotero instance to test against (a beta next to the release, an isolated dev " +
    "library, one instance per parallel session): a new profile and an empty data directory under " +
    "<parentDir>/<name>, a user.js giving it its own bridge port and HTTP port (sync off), and the MCP " +
    "Bridge sideloaded so that it starts enabled. Never touches an existing profile or data directory. " +
    "Does NOT start Zotero: returns the launch command and the MCP server entry for the new instance. " +
    "Calling it again with the same name returns the same setup. Use zotero_instance_list first to see " +
    "which ports are taken.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Instance name, used as its directory name (letters, digits, '.', '_', '-'), e.g. 'beta' or 'session-b'",
      },
      rdpPort: {
        type: "number",
        description: `Bridge (RDP) port for the new instance. Not ${DEFAULT_RDP_PORT} (the default, used by your existing Zotero) and not in use, e.g. 6101`,
      },
      httpPort: {
        type: "number",
        description:
          `Zotero HTTP server port (connector, local API) for the new instance. Default: ${DEFAULT_HTTP_PORT} moved by the same ` +
          `offset as rdpPort from ${DEFAULT_RDP_PORT} (6101 gives 23120)`,
      },
      zoteroPath: {
        type: "string",
        description:
          "Absolute path of the Zotero executable to run it with (zotero.exe; Zotero.app or its Contents/MacOS/zotero; " +
          "the 'zotero' script of the Linux tarball). Default: the single installation found at the standard locations",
      },
      bridgeXpi: {
        type: "string",
        description:
          "Absolute path of the MCP Bridge XPI (1.0.5 or later) to install in the new profile. Default: the bridge " +
          "installed in the profile this server is configured with (ZOTERO_PROFILE_PATH)",
      },
      parentDir: {
        type: "string",
        description: "Absolute directory to create the instance in. Default: zotero-dev-instances in your home directory",
      },
    },
    required: ["name", "rdpPort"],
  },
};

export const instanceListTool: Tool = {
  name: "zotero_instance_list",
  description:
    "List what already exists before creating a Zotero instance: Zotero installations at the standard " +
    "locations, the instances made by zotero_instance_setup (with their ports, and whether the bridge port " +
    "answers), and the profiles of Zotero's profile manager with their configured bridge and HTTP ports. " +
    "Reads files only; Zotero need not be running.",
  inputSchema: {
    type: "object",
    properties: {
      parentDir: {
        type: "string",
        description: "Directory holding the instances. Default: zotero-dev-instances in your home directory",
      },
    },
  },
};

/** What the server knows that the tools need. */
export interface InstanceToolContext {
  host: HostEnv;
  configuredPort: number;
  profilePath?: string;
  serverVersion: string;
}

/** The text zotero_instance_setup returns. Exported for the tests. */
export function formatSetup(r: SetupResult): TextContent[] {
  const rec = r.record;
  const head = r.created
    ? `✓ Created Zotero instance "${rec.name}" (Zotero was not started)`
    : `✓ Zotero instance "${rec.name}" already exists, made by zotero_instance_setup on ${rec.createdAt}; nothing was changed`;
  const lines = [
    head,
    "",
    `  Profile:        ${rec.profileDir}`,
    `  Data directory: ${rec.dataDir}${r.created ? "  (empty: Zotero creates a new library on first start)" : ""}`,
    `  Bridge port:    ${rec.rdpPort}  (extensions.mcp-rdp.port)`,
    `  HTTP port:      ${rec.httpPort}  (extensions.zotero.httpServer.port: connector, local API)`,
    `  Bridge:         MCP Bridge ${rec.bridge.version}, copied from ${rec.bridge.source}`,
    `  Zotero:         ${rec.zoteroPath}`,
  ];
  if (r.bridge?.maxZoteroVersion) {
    lines.push(
      `                  (this bridge declares Zotero ${r.bridge.maxZoteroVersion} as its maximum: a newer release ` +
        `build leaves it disabled, beta builds ignore the limit)`
    );
  }
  lines.push(
    "",
    "Start it:",
    ...r.commands.map((c) => `  ${c.shell.padEnd(11)} ${c.line}`),
    `  argv:       ${JSON.stringify(r.argv)}`,
    "",
    "MCP server entry for this instance (add it next to your existing one in the client's config, then restart the client):",
    JSON.stringify({ mcpServers: { [`zotero-dev-${rec.name}`]: r.mcpEntry } }, null, 2)
  );
  return [
    { type: "text", text: lines.join("\n") },
    {
      type: "text",
      text:
        `Next: start Zotero with the command above, then call zotero_ping through the new server entry. ` +
        `It must report Data directory: ${rec.dataDir}; if it reports another directory, something else ` +
        `answers on port ${rec.rdpPort}. Let the first start finish before quitting: after creating the ` +
        `database, Zotero installs its bundled translators and styles (Zotero.Schema.schemaUpdatePromise ` +
        `resolves when done), and an instance quit halfway through that can stop its next start on the ` +
        `modal error "Zotero could not load the translators and styles".`,
    },
  ];
}

export async function handleInstanceSetup(args: Record<string, unknown>, ctx: InstanceToolContext): Promise<TextContent[]> {
  const result = await setupInstance(args, ctx);
  return formatSetup(result);
}

export async function handleInstanceList(args: Record<string, unknown>, ctx: InstanceToolContext): Promise<TextContent[]> {
  const parentDir =
    typeof args.parentDir === "string" && args.parentDir !== "" ? args.parentDir : defaultParentDir(ctx.host);
  const inv = takeInventory(ctx.host, parentDir);
  const lines: string[] = [];

  lines.push("Zotero installations at the standard locations:");
  lines.push(...(inv.executables.length ? inv.executables.map((e) => `  • ${e}`) : ["  (none found; zotero_instance_setup takes zoteroPath)"]));

  const instances = inv.entries.filter((e) => e.kind === "instance");
  lines.push("", `Instances made by zotero_instance_setup in ${inv.parentDir}:`);
  if (!instances.length) lines.push("  (none)");
  for (const e of instances) {
    const answering = e.ports.rdpPort !== undefined && (await portAnswers(e.ports.rdpPort, 500));
    lines.push(
      `  • ${e.name}: bridge port ${e.ports.rdpPort ?? "?"} (${answering ? "answering" : "not answering"}), HTTP port ${e.ports.httpPort}`,
      `      profile ${e.profileDir}`,
      `      data    ${e.ports.dataDir ?? e.record?.dataDir ?? "?"}`,
      `      Zotero  ${e.record?.zoteroPath ?? "?"}`
    );
  }

  const profiles = inv.entries.filter((e) => e.kind === "profile");
  lines.push("", `Zotero profile manager (${inv.profilesIni}):`);
  if (!profiles.length) lines.push("  (no profiles.ini, or no profiles in it)");
  for (const e of profiles) {
    const bridge = e.ports.bridgeInstalled
      ? `bridge port ${e.ports.rdpPort}`
      : e.ports.rdpPort !== undefined
        ? `bridge port ${e.ports.rdpPort} configured, bridge XPI not found in the profile`
        : "no bridge";
    lines.push(
      `  • ${e.name}${e.isDefault ? " (default)" : ""}: ${bridge}, HTTP port ${e.ports.httpPort}`,
      `      profile ${e.profileDir}`,
      ...(e.ports.dataDir ? [`      data    ${e.ports.dataDir}`] : [])
    );
  }

  const rdp = [...new Set(inv.entries.map((e) => e.ports.rdpPort).filter((p): p is number => p !== undefined))].sort((a, b) => a - b);
  const http = [...new Set(inv.entries.map((e) => e.ports.httpPort))].sort((a, b) => a - b);
  lines.push("", `Ports configured above: bridge ${rdp.join(", ") || "none"}; HTTP ${http.join(", ") || "none"}.`);
  lines.push(`This server drives bridge port ${ctx.configuredPort} (ZOTERO_RDP_PORT).`);

  return [
    { type: "text", text: lines.join("\n") },
    { type: "text", text: "Next: zotero_instance_setup with a new name and a bridge port not listed above." },
  ];
}
